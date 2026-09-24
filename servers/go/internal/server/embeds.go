package server

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // Registered for image.DecodeConfig.
	_ "image/jpeg"
	_ "image/png"
	"io"
	"maps"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// HTTP paths for embed content (Appendix E, K). Write URLs carry a one-time
// token; file and stream URLs carry the embed_id and an unguessable secret,
// since HTTP requests are not authenticated.
const (
	writePath  = "/write/"
	filePath   = "/files/"
	streamPath = "/streams/"
)

const maxEmbedsPerMessage = 32

// embedState is a server-hosted embed: an upload or a stream. Other embed
// kinds are body content with only an embed_id.
type embedState struct {
	id   string
	kind string
	// messageID is the message the embed belongs to; avatarFor is set instead
	// for an @avatar upload (Appendix J.4).
	messageID string
	avatarFor *userState
	baseURL   string
	secret    string
	token     string
	title     string
	// alt is the sender's og.image.alt, kept in the server's og.
	alt string
	// timer expires an unused write URL, then bounds a stream's duration.
	timer    *time.Timer
	started  bool
	finished bool
	removed  bool
	// owned holds the server fields restored on every save: an upload's url
	// and og, a live stream's url, a finished stream's text.
	owned map[string]any

	content     []byte
	contentType string
	stream      *streamBuffer
}

func (e *embedState) endStream() {
	if e.stream != nil {
		e.stream.end()
	}
}

func (e *embedState) fileURL() string {
	return e.baseURL + filePath + e.id + "/" + e.secret
}

func (e *embedState) streamURL() string {
	return e.baseURL + streamPath + e.id + "/" + e.secret
}

// resolveEmbedsLocked applies embed identity (Appendix E) to a submitted
// body. An embed with embed_id keeps that embed of the current snapshot, with
// its kind and server-owned fields restored from the server's records; one
// without is new and gets an embed_id, and a new upload or stream embed gets
// a write URL, listed in written. Senders' og is dropped: the server only
// describes media it hosts.
func (s *Server) resolveEmbedsLocked(c *client, messageID string, current *messageState, body map[string]any) ([]any, []any, *rpcError) {
	submitted, _ := body["embeds"].([]any)
	previous := make(map[string]map[string]any)
	if current != nil {
		if currentBody, ok := current.snapshot["body"].(map[string]any); ok {
			for _, value := range asList(currentBody["embeds"]) {
				if embed, ok := value.(map[string]any); ok {
					if id, ok := embed["embed_id"].(string); ok {
						previous[id] = embed
					}
				}
			}
		}
	}
	kept := make(map[string]bool)
	for i, value := range submitted {
		embed := value.(map[string]any)
		raw, has := embed["embed_id"]
		if !has {
			continue
		}
		id, _ := raw.(string)
		if previous[id] == nil || kept[id] {
			return nil, nil, invalidParams("body.embeds[%d]: unknown embed_id %v", i, raw)
		}
		kept[id] = true
	}

	embeds := make([]any, 0, len(submitted))
	var written []any
	for _, value := range submitted {
		embed := cloneObject(value.(map[string]any))
		if id, has := embed["embed_id"].(string); has {
			embed["kind"] = previous[id]["kind"]
			delete(embed, "og")
			delete(embed, "write_url")
			if e := s.embeds[id]; e != nil {
				delete(embed, "url")
				delete(embed, "text")
				maps.Copy(embed, cloneObject(e.owned))
			}
			embeds = append(embeds, embed)
			continue
		}
		kind := embed["kind"].(string)
		s.embedNumber++
		id := fmt.Sprintf("embed_%d", s.embedNumber)
		alt := ogImageAlt(embed["og"])
		delete(embed, "og")
		delete(embed, "write_url")
		embed["embed_id"] = id
		if kind == "upload" || kind == "stream" {
			delete(embed, "url")
			delete(embed, "text")
			e := s.newWriteLocked(c, id, kind, messageID)
			e.alt = alt
			e.title, _ = embed["title"].(string)
			if kind == "stream" {
				e.stream = newStreamBuffer(s.config.StreamKeepBytes, s.config.StreamMaxBytes)
				e.owned = map[string]any{"url": e.streamURL()}
				embed["url"] = e.streamURL()
			}
			written = append(written, map[string]any{"embed_id": id, "kind": kind, "write_url": e.baseURL + writePath + e.token})
		}
		embeds = append(embeds, embed)
	}
	return embeds, written, nil
}

func asList(value any) []any {
	list, _ := value.([]any)
	return list
}

func ogImageAlt(og any) string {
	if og, ok := og.(map[string]any); ok {
		if image, ok := og["image"].(map[string]any); ok {
			alt, _ := image["alt"].(string)
			return alt
		}
	}
	return ""
}

// newWriteLocked registers a hosted embed awaiting its write. An unused write
// URL expires, and the embed is dropped.
func (s *Server) newWriteLocked(c *client, id, kind, messageID string) *embedState {
	e := &embedState{
		id:        id,
		kind:      kind,
		messageID: messageID,
		baseURL:   c.baseURL,
		secret:    rand.Text(),
		token:     rand.Text(),
	}
	s.embeds[id] = e
	s.writes[e.token] = e
	e.timer = time.AfterFunc(s.config.UploadStartTimeout, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if !e.started && !e.removed {
			s.failWriteLocked(e)
		}
	})
	return e
}

// releaseEmbedsLocked deletes the hosted content of embeds a save removed
// (Appendix E); a nil body, as for a tombstone, removes every embed.
func (s *Server) releaseEmbedsLocked(current *messageState, body map[string]any) {
	if current == nil {
		return
	}
	currentBody, _ := current.snapshot["body"].(map[string]any)
	remaining := make(map[string]bool)
	for _, value := range asList(body["embeds"]) {
		if id, ok := value.(map[string]any)["embed_id"].(string); ok {
			remaining[id] = true
		}
	}
	for _, value := range asList(currentBody["embeds"]) {
		if embed, ok := value.(map[string]any); ok {
			if id, ok := embed["embed_id"].(string); ok && !remaining[id] {
				s.removeEmbedLocked(id)
			}
		}
	}
}

// removeEmbedLocked forgets a hosted embed and its content, invalidating its
// write, file, and stream URLs.
func (s *Server) removeEmbedLocked(id string) {
	e := s.embeds[id]
	if e == nil {
		return
	}
	e.removed = true
	if e.timer != nil {
		e.timer.Stop()
	}
	e.endStream()
	e.content = nil
	delete(s.writes, e.token)
	delete(s.embeds, id)
}

// failWriteLocked finishes a write that never started or failed: the embed is
// published out of its message (Appendix E).
func (s *Server) failWriteLocked(e *embedState) {
	if m := s.messages[e.messageID]; m != nil {
		s.republishLocked(m, func(body map[string]any) bool {
			return replaceEmbed(body, e.id, nil)
		})
	}
	s.removeEmbedLocked(e.id)
}

// replaceEmbed swaps one embed in a body for update, or removes it when
// update is nil. It reports whether the embed was present.
func replaceEmbed(body map[string]any, id string, update func(map[string]any)) bool {
	embeds := asList(body["embeds"])
	for i, value := range embeds {
		embed, ok := value.(map[string]any)
		if !ok || embed["embed_id"] != id {
			continue
		}
		if update == nil {
			embeds = append(embeds[:i:i], embeds[i+1:]...)
			if len(embeds) == 0 {
				delete(body, "embeds")
			} else {
				body["embeds"] = embeds
			}
		} else {
			update(embed)
		}
		return true
	}
	return false
}

// uploadAvatarLocked handles a message to room @avatar (Appendix J.4): one
// upload embed whose file becomes the sender's avatar. The message is
// neither delivered nor logged.
func (s *Server) uploadAvatarLocked(c *client, req request, body map[string]any) (any, bool, *rpcError) {
	embeds := asList(body["embeds"])
	if len(embeds) != 1 || embeds[0].(map[string]any)["kind"] != "upload" {
		return nil, false, invalidParams("A message to %s carries exactly one upload embed", avatarRoomID)
	}
	messageID := formatID(s.nextIDLocked())
	s.embedNumber++
	e := s.newWriteLocked(c, fmt.Sprintf("embed_%d", s.embedNumber), "upload", "")
	e.avatarFor = c.user
	result := map[string]any{
		"message_id": messageID,
		"embeds":     []any{map[string]any{"embed_id": e.id, "kind": "upload", "write_url": e.baseURL + writePath + e.token}},
	}
	return result, false, nil
}

// setAvatarEmbedLocked records the hosted upload behind a user's avatar,
// deleting the content of the one it replaces.
func (s *Server) setAvatarEmbedLocked(u *userState, e *embedState) {
	if u.avatarEmbed != nil && u.avatarEmbed != e {
		s.removeEmbedLocked(u.avatarEmbed.id)
	}
	u.avatarEmbed = e
}

func setEmbedCORS(w http.ResponseWriter, methods string) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", methods)
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

// handleWrite accepts an upload or stream body at its write URL, once.
func (s *Server) handleWrite(w http.ResponseWriter, r *http.Request) {
	setEmbedCORS(w, "PUT, POST, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		w.Header().Set("Allow", "PUT, POST, OPTIONS")
		http.Error(w, "Write with PUT or POST", http.StatusMethodNotAllowed)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, writePath)
	s.mu.Lock()
	e := s.writes[token]
	if e == nil || e.started || e.removed {
		s.mu.Unlock()
		http.Error(w, "This write URL is unknown, used, or expired", http.StatusNotFound)
		return
	}
	e.started = true
	delete(s.writes, token)
	e.timer.Stop()
	if e.stream != nil {
		e.timer = time.AfterFunc(s.config.StreamMaxDuration, e.endStream)
	}
	s.mu.Unlock()
	if e.stream != nil {
		s.writeStream(w, r, e)
	} else {
		s.writeUpload(w, r, e)
	}
}

func (s *Server) writeUpload(w http.ResponseWriter, r *http.Request, e *embedState) {
	limit := s.config.MaxUploadBytes
	if e.avatarFor != nil {
		limit = s.config.MaxAvatarBytes
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	contentType := uploadContentType(r.Header.Get("Content-Type"), data)
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.removed {
		http.Error(w, "The embed was removed from its message", http.StatusGone)
		return
	}
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		s.failWriteLocked(e)
		http.Error(w, fmt.Sprintf("Uploads are limited to %d bytes", limit), http.StatusRequestEntityTooLarge)
		return
	case err != nil:
		s.failWriteLocked(e)
		http.Error(w, "The upload did not finish", http.StatusBadRequest)
		return
	case e.avatarFor != nil && !avatarType(contentType):
		s.failWriteLocked(e)
		http.Error(w, "Avatars must be PNG, JPEG, GIF, or WebP images", http.StatusUnsupportedMediaType)
		return
	}
	e.finished = true
	e.content = data
	e.contentType = contentType
	e.owned = map[string]any{"url": e.fileURL()}
	if og := describeUpload(e, data); og != nil {
		e.owned["og"] = og
	}
	if u := e.avatarFor; u != nil {
		if s.users[u.id] == u {
			s.setAvatarEmbedLocked(u, e)
			u.avatar = e.fileURL()
			s.notifyProfileLocked(u, nil)
		} else {
			s.removeEmbedLocked(e.id)
		}
	} else if m := s.messages[e.messageID]; m != nil {
		s.republishLocked(m, func(body map[string]any) bool {
			return replaceEmbed(body, e.id, func(embed map[string]any) {
				maps.Copy(embed, cloneObject(e.owned))
			})
		})
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_, _ = fmt.Fprintf(w, "{\"url\":%q}\n", e.fileURL())
}

// uploadContentType prefers the sender's declared type, except for types a
// browser would run as a document, and otherwise sniffs the content.
func uploadContentType(declared string, data []byte) string {
	if mediaType, _, err := mime.ParseMediaType(declared); err == nil && mediaType != "application/octet-stream" {
		switch {
		case strings.Contains(mediaType, "html"), strings.Contains(mediaType, "xml"), strings.Contains(mediaType, "javascript"):
		default:
			return mediaType
		}
	}
	mediaType, _, _ := mime.ParseMediaType(http.DetectContentType(data))
	if strings.Contains(mediaType, "html") || strings.Contains(mediaType, "xml") {
		return "application/octet-stream"
	}
	return mediaType
}

func avatarType(contentType string) bool {
	switch contentType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	}
	return false
}

// describeUpload builds the og the server sets on a finished upload
// (Appendix E): image for a preview, or video or audio to play. Other files
// have none, so clients show a file card.
func describeUpload(e *embedState, data []byte) map[string]any {
	media := map[string]any{"url": e.fileURL(), "type": e.contentType}
	og := map[string]any{}
	switch {
	case avatarType(e.contentType):
		if config, _, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
			media["width"], media["height"] = config.Width, config.Height
		}
		if e.alt != "" {
			media["alt"] = e.alt
		}
		og["image"] = media
	case strings.HasPrefix(e.contentType, "video/"):
		og["video"] = media
	case strings.HasPrefix(e.contentType, "audio/"):
		og["audio"] = media
	default:
		return nil
	}
	if e.title != "" {
		og["title"] = e.title
	}
	return og
}

// inlineType reports whether a hosted file may be shown in the browser
// rather than downloaded.
func inlineType(contentType string) bool {
	return avatarType(contentType) || contentType == "text/plain" ||
		strings.HasPrefix(contentType, "video/") || strings.HasPrefix(contentType, "audio/")
}

// handleFile serves a finished upload. Hosted files never run as documents on
// this origin: they are sandboxed, not sniffed, and downloaded unless they
// are media or plain text.
func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Read with GET", http.StatusMethodNotAllowed)
		return
	}
	s.mu.RLock()
	e := s.lookupEmbedLocked(strings.TrimPrefix(r.URL.Path, filePath))
	if e == nil || !e.finished || e.stream != nil {
		s.mu.RUnlock()
		http.NotFound(w, r)
		return
	}
	content, contentType, title := e.content, e.contentType, e.title
	s.mu.RUnlock()
	header := w.Header()
	header.Set("Content-Type", contentType)
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	header.Set("Cache-Control", "private, max-age=3600")
	disposition := "attachment"
	if inlineType(contentType) {
		disposition = "inline"
	}
	if title != "" {
		disposition = mime.FormatMediaType(disposition, map[string]string{"filename": title})
	}
	header.Set("Content-Disposition", disposition)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(content))
}

// lookupEmbedLocked resolves "embed_id/secret" from a file or stream path.
func (s *Server) lookupEmbedLocked(path string) *embedState {
	id, secret, ok := strings.Cut(path, "/")
	e := s.embeds[id]
	if !ok || e == nil || subtle.ConstantTimeCompare([]byte(secret), []byte(e.secret)) != 1 {
		return nil
	}
	return e
}

// writeStream copies the request body into a stream until it ends: the body
// ends, a limit is reached, or the embed is removed (Appendix K).
func (s *Server) writeStream(w http.ResponseWriter, r *http.Request, e *embedState) {
	// The reply may come before the body ends, as when the stream is removed.
	controller := http.NewResponseController(w)
	_ = controller.EnableFullDuplex()
	chunks := make(chan []byte)
	go func() {
		defer close(chunks)
		for {
			buf := make([]byte, 32<<10)
			n, err := r.Body.Read(buf)
			if n > 0 {
				select {
				case chunks <- buf[:n]:
				case <-e.stream.finished:
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	bodyEnded := false
	for open := true; open; {
		select {
		case chunk, ok := <-chunks:
			bodyEnded = !ok
			open = ok && e.stream.write(chunk)
		case <-e.stream.finished:
			open = false
		}
	}
	e.stream.end()
	if !bodyEnded {
		// Unblock a body read still waiting on the writer, and let it finish.
		// The expired deadline also cancels the connection's context, so the
		// connection must not serve another request.
		w.Header().Set("Connection", "close")
		_ = controller.SetReadDeadline(time.Now())
		for range chunks {
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e.timer.Stop()
	if e.removed {
		http.Error(w, "The stream was removed from its message", http.StatusGone)
		return
	}
	e.finished = true
	e.owned = map[string]any{"text": e.stream.text()}
	if m := s.messages[e.messageID]; m != nil {
		s.republishLocked(m, func(body map[string]any) bool {
			return replaceEmbed(body, e.id, func(embed map[string]any) {
				delete(embed, "url")
				embed["text"] = e.owned["text"]
			})
		})
	}
	if e.stream.limited() {
		http.Error(w, fmt.Sprintf("Streams are limited to %d bytes; the stream ended", s.config.StreamMaxBytes), http.StatusRequestEntityTooLarge)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleStream serves a live stream: the kept text, then more as it arrives,
// until the stream ends. A finished stream's URL no longer works.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method != http.MethodGet {
		http.Error(w, "Read with GET", http.StatusMethodNotAllowed)
		return
	}
	s.mu.RLock()
	e := s.lookupEmbedLocked(strings.TrimPrefix(r.URL.Path, streamPath))
	if e == nil || e.stream == nil || e.finished {
		s.mu.RUnlock()
		http.NotFound(w, r)
		return
	}
	stream := e.stream
	s.mu.RUnlock()
	header := w.Header()
	header.Set("Content-Type", "text/plain; charset=utf-8")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Cache-Control", "no-store")
	controller := http.NewResponseController(w)
	position := int64(-1)
	for {
		chunk, next, changed, ended := stream.read(position)
		if len(chunk) > 0 {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
		_ = controller.Flush()
		position = next
		if ended {
			return
		}
		select {
		case <-changed:
		case <-r.Context().Done():
			return
		}
	}
}

// streamBuffer keeps a stream's trailing text and wakes readers as it grows.
type streamBuffer struct {
	mu       sync.Mutex
	keep     int
	maxBytes int64
	// data holds the kept bytes, starting at absolute offset start.
	data    []byte
	start   int64
	total   int64
	changed chan struct{}
	ended   bool
	atLimit bool
	// finished closes when the stream ends, for its writer.
	finished chan struct{}
}

func newStreamBuffer(keep int, maxBytes int64) *streamBuffer {
	return &streamBuffer{keep: keep, maxBytes: maxBytes, changed: make(chan struct{}), finished: make(chan struct{})}
}

// write appends to the stream and reports whether it still accepts more. At
// the size limit it keeps what fits and ends.
func (b *streamBuffer) write(p []byte) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ended {
		return false
	}
	if room := b.maxBytes - b.total; int64(len(p)) >= room {
		p = p[:room]
		b.atLimit = true
	}
	b.data = append(b.data, p...)
	b.total += int64(len(p))
	if excess := len(b.data) - b.keep; excess > 0 {
		// Trim to a rune boundary so the kept text starts with a whole rune.
		for excess < len(b.data) && !utf8.RuneStart(b.data[excess]) {
			excess++
		}
		b.data = append([]byte(nil), b.data[excess:]...)
		b.start += int64(excess)
	}
	b.signalLocked()
	if b.atLimit {
		b.endLocked()
	}
	return !b.ended
}

func (b *streamBuffer) end() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.endLocked()
}

func (b *streamBuffer) endLocked() {
	if !b.ended {
		b.ended = true
		close(b.finished)
		b.signalLocked()
	}
}

func (b *streamBuffer) signalLocked() {
	close(b.changed)
	b.changed = make(chan struct{})
}

func (b *streamBuffer) limited() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.atLimit
}

// read returns the bytes from position on (from the start of the kept text
// when position is before it), the next position, a channel closed on the
// next change, and whether the stream has ended with nothing more to read.
func (b *streamBuffer) read(position int64) ([]byte, int64, chan struct{}, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	position = max(position, b.start)
	chunk := append([]byte(nil), b.data[position-b.start:]...)
	return chunk, b.start + int64(len(b.data)), b.changed, b.ended
}

// text is the kept text as valid UTF-8.
func (b *streamBuffer) text() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.ToValidUTF8(string(b.data), "�")
}
