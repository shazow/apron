package server

import (
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/shazow/apron/servers/go/internal/store"
)

// Persistence writes the server's state through to a store.Store. Every
// change made under s.mu marks what it changed (touch*); when the lock is
// released, unlock serializes the marked state into one batch, and a single
// writer applies batches to the store in order, off the lock. At start, New
// rebuilds the state from the store.
//
// Entry kinds and IDs:
//
//	meta     "counters"   log_id, guest, embed, and upload sequences
//	used_id  lowercased user_id ever assigned
//	record   log_id       a logged record and the rooms whose logs hold it
//	room     room_id
//	message  message_id
//	user     user_id      guests too, retired at the next start
//	session  hex SHA-256 of the bearer token
//	embed    embed_id
//	push     url
const (
	entryMeta    = "meta"
	entryUsedID  = "used_id"
	entryRecord  = "record"
	entryRoom    = "room"
	entryMessage = "message"
	entryUser    = "user"
	entrySession = "session"
	entryEmbed   = "embed"
	entryPush    = "push"
)

// storeQueue bounds the batches waiting for the store writer; beyond it,
// requests wait for the store.
const storeQueue = 1024

// dirtySet is the state changed since the last batch, by key. For users,
// sessions, embeds, and pushes, a key missing from the server's maps at
// flush time is deleted from the store.
type dirtySet struct {
	records  map[*logRecord]bool
	rooms    map[string]bool
	messages map[string]bool
	users    map[string]bool
	sessions map[[32]byte]bool
	embeds   map[string]bool
	pushes   map[string]bool
	usedIDs  []string
}

func newDirtySet() dirtySet {
	return dirtySet{
		records:  make(map[*logRecord]bool),
		rooms:    make(map[string]bool),
		messages: make(map[string]bool),
		users:    make(map[string]bool),
		sessions: make(map[[32]byte]bool),
		embeds:   make(map[string]bool),
		pushes:   make(map[string]bool),
	}
}

func (s *Server) touchRecord(r *logRecord)     { s.dirty.records[r] = true }
func (s *Server) touchRoom(r *roomState)       { s.dirty.rooms[r.id] = true }
func (s *Server) touchMessage(m *messageState) { s.dirty.messages[m.id] = true }
func (s *Server) touchUser(id string)          { s.dirty.users[id] = true }
func (s *Server) touchSession(key [32]byte)    { s.dirty.sessions[key] = true }
func (s *Server) touchEmbed(id string)         { s.dirty.embeds[id] = true }
func (s *Server) touchPush(url string)         { s.dirty.pushes[url] = true }
func (s *Server) touchUsedID(lowercased string) {
	s.dirty.usedIDs = append(s.dirty.usedIDs, lowercased)
}

// unlock writes the changes made under s.mu through to the store, then
// releases the lock.
func (s *Server) unlock() {
	s.flushLocked()
	s.mu.Unlock()
}

type storedMeta struct {
	LastID      int64  `json:"last_id"`
	GuestNumber uint64 `json:"guest_number"`
	EmbedNumber uint64 `json:"embed_number"`
	UploadSeq   int64  `json:"upload_seq"`
}

type storedRecord struct {
	Kind  recordKind     `json:"kind"`
	Raw   jsontext.Value `json:"raw"`
	Intro int64          `json:"intro,omitzero"`
	Rooms []string       `json:"rooms"`
}

type storedCursor struct {
	From      map[string]any `json:"from"`
	MessageID string         `json:"message_id"`
	ID        int64          `json:"id"`
}

type storedRoom struct {
	Parent      string                  `json:"parent,omitzero"`
	Record      map[string]any          `json:"record"`
	RecordLogID int64                   `json:"record_log_id"`
	CreatedID   int64                   `json:"created_id"`
	LatestID    int64                   `json:"latest_id"`
	Members     []string                `json:"members"`
	Creator     string                  `json:"creator,omitzero"`
	TitleFrom   string                  `json:"title_from,omitzero"`
	Reads       map[string]storedCursor `json:"reads,omitzero"`
}

type storedReaction struct {
	From   map[string]any `json:"from"`
	Emojis []string       `json:"emojis"`
}

type storedMessage struct {
	From         map[string]any            `json:"from"`
	LogID        int64                     `json:"log_id"`
	Owner        string                    `json:"owner"`
	RoomID       string                    `json:"room_id"`
	Reactions    map[string]storedReaction `json:"reactions,omitzero"`
	Records      []int64                   `json:"records"`
	TitleRecords []int64                   `json:"title_records,omitzero"`
	TitledRooms  []string                  `json:"titled_rooms,omitzero"`
}

type storedPasskey struct {
	Handle      []byte                `json:"handle"`
	Credentials []webauthn.Credential `json:"credentials"`
}

type storedUser struct {
	Name        string           `json:"name,omitzero"`
	Avatar      string           `json:"avatar,omitzero"`
	Ext         map[string]any   `json:"ext,omitzero"`
	AvatarEmbed string           `json:"avatar_embed,omitzero"`
	LeftAt      map[string]int64 `json:"left_at,omitzero"`
	Passkey     *storedPasskey   `json:"passkey,omitzero"`
}

type storedSession struct {
	User    string    `json:"user"`
	Origin  string    `json:"origin"`
	Expires time.Time `json:"expires"`
}

type storedEmbed struct {
	Kind        string         `json:"kind"`
	MessageID   string         `json:"message_id,omitzero"`
	AvatarFor   string         `json:"avatar_for,omitzero"`
	BaseURL     string         `json:"base_url"`
	Secret      string         `json:"secret"`
	Title       string         `json:"title,omitzero"`
	Alt         string         `json:"alt,omitzero"`
	Stream      bool           `json:"stream,omitzero"`
	Finished    bool           `json:"finished,omitzero"`
	Owned       map[string]any `json:"owned,omitzero"`
	File        string         `json:"file,omitzero"`
	Size        int64          `json:"size,omitzero"`
	ContentType string         `json:"content_type,omitzero"`
	Seq         int64          `json:"seq,omitzero"`
}

type storedPush struct {
	User  string `json:"user"`
	Kind  string `json:"kind"`
	Token string `json:"token,omitzero"`
}

func sessionID(key [32]byte) string { return hex.EncodeToString(key[:]) }

// flushLocked queues the marked changes as one batch for the store writer.
func (s *Server) flushLocked() {
	if s.storeClosed {
		s.dirty = newDirtySet()
		return
	}
	batch := s.entriesLocked(s.dirty)
	meta := storedMeta{LastID: s.lastID, GuestNumber: s.guestNumber, EmbedNumber: s.embedNumber, UploadSeq: s.uploadSeq}
	if meta != s.storedMeta {
		s.storedMeta = meta
		batch = append(batch, store.Entry{Kind: entryMeta, ID: "counters", Value: encodeJSON(meta)})
	}
	s.dirty = newDirtySet()
	if len(batch) > 0 {
		s.storeWrites <- batch
	}
}

// dumpLocked renders the whole state as the entries a store holding it
// would have, for checking that every change reaches the store.
func (s *Server) dumpLocked() []store.Entry {
	all := newDirtySet()
	for id := range s.usedIDs {
		all.usedIDs = append(all.usedIDs, id)
	}
	for _, r := range s.rooms {
		all.rooms[r.id] = true
		for _, record := range r.log {
			all.records[record] = true
		}
	}
	for id := range s.messages {
		all.messages[id] = true
	}
	for id := range s.users {
		all.users[id] = true
	}
	for key := range s.sessions {
		all.sessions[key] = true
	}
	for id := range s.embeds {
		all.embeds[id] = true
	}
	for url := range s.pushes {
		all.pushes[url] = true
	}
	meta := storedMeta{LastID: s.lastID, GuestNumber: s.guestNumber, EmbedNumber: s.embedNumber, UploadSeq: s.uploadSeq}
	return append(s.entriesLocked(all), store.Entry{Kind: entryMeta, ID: "counters", Value: encodeJSON(meta)})
}

// entriesLocked renders the state named by a dirty set as store entries.
func (s *Server) entriesLocked(d dirtySet) []store.Entry {
	var batch []store.Entry
	put := func(kind, id string, value any) {
		encoded := encodeJSON(value)
		if encoded == nil {
			slog.Error("cannot encode state for the store", "kind", kind, "id", id)
			return
		}
		batch = append(batch, store.Entry{Kind: kind, ID: id, Value: encoded})
	}
	del := func(kind, id string) {
		batch = append(batch, store.Entry{Kind: kind, ID: id})
	}
	for _, id := range d.usedIDs {
		put(entryUsedID, id, true)
	}
	for r := range d.records {
		stored := storedRecord{Kind: r.kind, Raw: r.raw, Rooms: r.rooms}
		if r.intro != nil {
			stored.Intro = r.intro.id
		}
		put(entryRecord, formatID(r.id), stored)
	}
	for id := range d.rooms {
		if r := s.rooms[id]; r != nil {
			put(entryRoom, id, s.storedRoomLocked(r))
		}
	}
	for id := range d.messages {
		if m := s.messages[id]; m != nil {
			put(entryMessage, id, storedMessageOf(m))
		}
	}
	for id := range d.users {
		if u := s.users[id]; u != nil {
			put(entryUser, id, storedUserOf(u))
		} else {
			del(entryUser, id)
		}
	}
	for key := range d.sessions {
		if session, ok := s.sessions[key]; ok {
			put(entrySession, sessionID(key), storedSession{User: session.user.user.id, Origin: session.origin, Expires: session.expires})
		} else {
			del(entrySession, sessionID(key))
		}
	}
	for id := range d.embeds {
		if e := s.embeds[id]; e != nil {
			put(entryEmbed, id, storedEmbedOf(e))
		} else {
			del(entryEmbed, id)
		}
	}
	for url := range d.pushes {
		if p := s.pushes[url]; p != nil {
			put(entryPush, url, storedPush{User: p.userID, Kind: p.kind, Token: p.token})
		} else {
			del(entryPush, url)
		}
	}
	return batch
}

func (s *Server) storedRoomLocked(r *roomState) storedRoom {
	stored := storedRoom{
		Record:      r.record,
		RecordLogID: r.recordLogID,
		CreatedID:   r.createdID,
		LatestID:    r.latestID,
		Members:     slices.Sorted(maps.Keys(r.members)),
		Creator:     r.creator,
		TitleFrom:   r.titleFrom,
	}
	if r.parent != nil {
		stored.Parent = r.parent.id
	}
	if len(r.reads) > 0 {
		stored.Reads = make(map[string]storedCursor, len(r.reads))
		for id, cursor := range r.reads {
			stored.Reads[id] = storedCursor{From: cursor.from, MessageID: cursor.messageID, ID: cursor.id}
		}
	}
	return stored
}

func storedMessageOf(m *messageState) storedMessage {
	stored := storedMessage{From: m.from, LogID: m.logID, Owner: m.owner, RoomID: m.roomID}
	for _, record := range m.records {
		stored.Records = append(stored.Records, record.id)
	}
	for _, record := range m.titleRecords {
		stored.TitleRecords = append(stored.TitleRecords, record.id)
	}
	for _, r := range m.titledRooms {
		stored.TitledRooms = append(stored.TitledRooms, r.id)
	}
	if len(m.reactions) > 0 {
		stored.Reactions = make(map[string]storedReaction, len(m.reactions))
		for id, set := range m.reactions {
			stored.Reactions[id] = storedReaction{From: set.from, Emojis: set.emojis}
		}
	}
	return stored
}

func storedUserOf(u *userState) storedUser {
	stored := storedUser{Name: u.name, Avatar: u.avatar, Ext: u.ext, LeftAt: u.leftAt}
	if u.avatarEmbed != nil {
		stored.AvatarEmbed = u.avatarEmbed.id
	}
	if u.passkey != nil {
		stored.Passkey = &storedPasskey{Handle: u.passkey.handle, Credentials: u.passkey.credentials}
	}
	return stored
}

func storedEmbedOf(e *embedState) storedEmbed {
	stored := storedEmbed{
		Kind: e.kind, MessageID: e.messageID, BaseURL: e.baseURL, Secret: e.secret,
		Title: e.title, Alt: e.alt, Stream: e.stream != nil, Finished: e.finished,
		Owned: e.owned, Size: e.size, ContentType: e.contentType, Seq: e.seq,
	}
	if e.avatarFor != nil {
		stored.AvatarFor = e.avatarFor.id
	}
	if e.path != "" {
		stored.File = filepath.Base(e.path)
	}
	return stored
}

// writeStore applies batches to the store in order until the queue closes.
func (s *Server) writeStore() {
	defer close(s.storeDone)
	for batch := range s.storeWrites {
		if err := s.config.Store.Apply(batch); err != nil {
			slog.Error("cannot write to the store", "error", err)
		}
	}
}

// closeStoreLocked writes the last changes and closes the store.
func (s *Server) closeStoreLocked() {
	if s.storeClosed {
		return
	}
	s.flushLocked()
	s.storeClosed = true
	close(s.storeWrites)
	<-s.storeDone
	if err := s.config.Store.Close(); err != nil {
		slog.Error("cannot close the store", "error", err)
	}
}

// restoreLocked rebuilds the server's state from the store's entries. It
// returns the upload files the restored embeds hold.
func (s *Server) restoreLocked() (map[string]bool, error) {
	entries := make(map[string]map[string]jsontext.Value)
	err := s.config.Store.Load(func(e store.Entry) error {
		if entries[e.Kind] == nil {
			entries[e.Kind] = make(map[string]jsontext.Value)
		}
		entries[e.Kind][e.ID] = e.Value
		return nil
	})
	if err != nil {
		return nil, err
	}
	decode := func(kind, id string, raw jsontext.Value, into any) error {
		if err := json.Unmarshal(raw, into); err != nil {
			return fmt.Errorf("stored %s %q: %w", kind, id, err)
		}
		return nil
	}

	if raw, ok := entries[entryMeta]["counters"]; ok {
		if err := decode(entryMeta, "counters", raw, &s.storedMeta); err != nil {
			return nil, err
		}
		s.lastID, s.guestNumber, s.embedNumber, s.uploadSeq = s.storedMeta.LastID, s.storedMeta.GuestNumber, s.storedMeta.EmbedNumber, s.storedMeta.UploadSeq
	}
	for id := range entries[entryUsedID] {
		s.usedIDs[id] = true
	}

	records := make(map[int64]*logRecord)
	storedRecords := make(map[int64]storedRecord)
	for id, raw := range entries[entryRecord] {
		var stored storedRecord
		if err := decode(entryRecord, id, raw, &stored); err != nil {
			return nil, err
		}
		logID, _ := strconv.ParseInt(id, 10, 64)
		records[logID] = &logRecord{id: logID, kind: stored.Kind, raw: stored.Raw, rooms: stored.Rooms}
		storedRecords[logID] = stored
	}
	for logID, stored := range storedRecords {
		if stored.Intro != 0 {
			records[logID].intro = records[stored.Intro]
		}
	}

	storedRooms := make(map[string]storedRoom)
	for id, raw := range entries[entryRoom] {
		var stored storedRoom
		if err := decode(entryRoom, id, raw, &stored); err != nil {
			return nil, err
		}
		storedRooms[id] = stored
		s.rooms[id] = &roomState{
			id: id, record: stored.Record, recordLogID: stored.RecordLogID, createdID: stored.CreatedID,
			latestID: stored.LatestID, creator: stored.Creator, titleFrom: stored.TitleFrom,
			members: make(map[string]*userState), reads: make(map[string]readCursor),
		}
	}
	order := slices.SortedFunc(maps.Keys(s.rooms), func(a, b string) int {
		return int(s.rooms[a].createdID - s.rooms[b].createdID)
	})
	for _, id := range order {
		r := s.rooms[id]
		if parent := s.rooms[storedRooms[id].Parent]; parent != nil {
			r.parent = parent
			parent.children = append(parent.children, r)
		}
		for userID, cursor := range storedRooms[id].Reads {
			r.reads[userID] = readCursor{from: cursor.From, messageID: cursor.MessageID, id: cursor.ID}
		}
	}
	for _, logID := range slices.Sorted(maps.Keys(records)) {
		record := records[logID]
		for _, roomID := range record.rooms {
			if r := s.rooms[roomID]; r != nil {
				r.log = append(r.log, record)
			}
		}
	}

	for id, raw := range entries[entryMessage] {
		var stored storedMessage
		if err := decode(entryMessage, id, raw, &stored); err != nil {
			return nil, err
		}
		m := &messageState{id: id, from: stored.From, logID: stored.LogID, owner: stored.Owner, roomID: stored.RoomID, reactions: make(map[string]reactionSet)}
		for userID, set := range stored.Reactions {
			m.reactions[userID] = reactionSet{from: set.From, emojis: set.Emojis}
		}
		for _, logID := range stored.Records {
			if record := records[logID]; record != nil {
				m.records = append(m.records, record)
			}
		}
		for _, logID := range stored.TitleRecords {
			if record := records[logID]; record != nil {
				m.titleRecords = append(m.titleRecords, record)
			}
		}
		for _, roomID := range stored.TitledRooms {
			if r := s.rooms[roomID]; r != nil {
				m.titledRooms = append(m.titledRooms, r)
			}
		}
		if len(m.records) == 0 {
			continue // A message without its records cannot be served.
		}
		s.messages[id] = m
	}

	storedUsers := make(map[string]storedUser)
	for id, raw := range entries[entryUser] {
		var stored storedUser
		if err := decode(entryUser, id, raw, &stored); err != nil {
			return nil, err
		}
		storedUsers[id] = stored
		u := newUserState(id, stored.Name)
		u.avatar, u.ext = stored.Avatar, stored.Ext
		if stored.LeftAt != nil {
			u.leftAt = stored.LeftAt
		}
		if stored.Passkey != nil {
			u.passkey = &passkeyUser{user: u, handle: stored.Passkey.Handle, credentials: stored.Passkey.Credentials}
			s.passkeys[id] = u.passkey
			for _, credential := range u.passkey.credentials {
				s.credentials[string(credential.ID)] = u.passkey
			}
		}
		s.users[id] = u
	}
	for _, id := range order {
		r := s.rooms[id]
		for _, userID := range storedRooms[id].Members {
			if u := s.users[userID]; u != nil {
				r.members[userID] = u
				u.joined[id] = r
			}
		}
	}

	files := make(map[string]bool)
	var uploads []*embedState
	for id, raw := range entries[entryEmbed] {
		var stored storedEmbed
		if err := decode(entryEmbed, id, raw, &stored); err != nil {
			return nil, err
		}
		e := &embedState{
			id: id, kind: stored.Kind, messageID: stored.MessageID, avatarFor: s.users[stored.AvatarFor],
			baseURL: stored.BaseURL, secret: stored.Secret, title: stored.Title, alt: stored.Alt,
			finished: stored.Finished, started: stored.Finished, owned: stored.Owned, size: stored.Size,
			contentType: stored.ContentType, seq: stored.Seq,
		}
		if stored.Stream {
			e.stream = newStreamBuffer(s.config.StreamKeepBytes, s.config.StreamMaxBytes)
			if stored.Finished {
				e.stream.end()
			}
		}
		if stored.File != "" {
			e.path = filepath.Join(s.uploadDir, stored.File)
			files[e.path] = true
			uploads = append(uploads, e)
		}
		s.embeds[id] = e
	}
	slices.SortFunc(uploads, func(a, b *embedState) int { return int(a.seq - b.seq) })
	for _, e := range uploads {
		e.upload = s.uploads.PushBack(e)
		s.uploadBytes += e.size
	}
	for id, stored := range storedUsers {
		if e := s.embeds[stored.AvatarEmbed]; e != nil {
			s.users[id].avatarEmbed = e
		}
	}

	for url, raw := range entries[entryPush] {
		var stored storedPush
		if err := decode(entryPush, url, raw, &stored); err != nil {
			return nil, err
		}
		if s.users[stored.User] != nil {
			s.pushes[url] = &pushRegistration{userID: stored.User, kind: stored.Kind, url: url, token: stored.Token}
		}
	}
	now := time.Now()
	for id, raw := range entries[entrySession] {
		var stored storedSession
		key, err := hex.DecodeString(id)
		if err != nil || len(key) != 32 {
			continue
		}
		if err := decode(entrySession, id, raw, &stored); err != nil {
			return nil, err
		}
		if u := s.users[stored.User]; u != nil && u.passkey != nil && now.Before(stored.Expires) {
			s.sessions[[32]byte(key)] = passkeySession{user: u.passkey, origin: stored.Origin, expires: stored.Expires}
		} else {
			s.touchSession([32]byte(key))
		}
	}

	// Nothing is connected yet: guests are retired as if their last
	// connections had just closed, and writes that had not finished fail.
	for _, id := range slices.Sorted(maps.Keys(s.users)) {
		if u := s.users[id]; u.passkey == nil {
			s.retireLocked(u)
		}
	}
	for _, id := range slices.Sorted(maps.Keys(s.embeds)) {
		if e := s.embeds[id]; e != nil && !e.finished {
			s.failWriteLocked(e)
		}
	}
	return files, nil
}

// removeStaleUploads deletes upload files in the upload directory that no
// restored embed holds, such as those of a run without persistence.
func (s *Server) removeStaleUploads(keep map[string]bool) {
	stale, _ := filepath.Glob(filepath.Join(s.uploadDir, "*"+uploadSuffix))
	for _, name := range stale {
		if !keep[name] {
			_ = os.Remove(name)
		}
	}
}
