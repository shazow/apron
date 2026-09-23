package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/go-webauthn/webauthn/webauthn"
)

const (
	defaultReadLimit          int64 = 256 << 10
	defaultOutgoingQueue            = 128
	defaultHistoryPageSize          = 100
	maxHistoryPageSize              = 1000
	defaultPingInterval             = 30 * time.Second
	defaultPingTimeout              = 10 * time.Second
	defaultWriteTimeout             = 10 * time.Second
	defaultMaxUploadBytes     int64 = 32 << 20
	defaultMaxAvatarBytes     int64 = 2 << 20
	defaultUploadStartTimeout       = 5 * time.Minute
	defaultStreamKeepBytes          = 64 << 10
	defaultStreamMaxBytes     int64 = 16 << 20
	defaultStreamMaxDuration        = time.Hour
	// retryAfterSeconds is the delay suggested by connection-level
	// retry_after errors (capacity and shutdown).
	retryAfterSeconds = 30
)

// Config controls the HTTP and WebSocket behavior of a Server.
type Config struct {
	// WebAuthn enables passkeys with an explicitly configured RP and frontend origins.
	WebAuthn *webauthn.WebAuthn
	// OriginPatterns is passed to the WebSocket origin checker. Empty uses the
	// local development origins for localhost, 127.0.0.1, and ::1.
	OriginPatterns []string
	// AllowAnyOrigin disables origin checking. Use only for a trusted deployment.
	AllowAnyOrigin bool
	// StaticDir serves a built frontend from the HTTP root when non-empty.
	StaticDir string
	ReadLimit int64

	OutgoingQueue   int
	HistoryPageSize int
	PingInterval    time.Duration
	PingTimeout     time.Duration
	WriteTimeout    time.Duration

	// PublicURL is the external base URL (scheme and host, such as
	// https://chat.example) of write, file, and stream URLs. Empty derives it
	// from each WebSocket request's Host header.
	PublicURL string
	// MaxUploadBytes bounds one upload; MaxAvatarBytes bounds an @avatar upload.
	MaxUploadBytes int64
	MaxAvatarBytes int64
	// UploadStartTimeout is how long an unused write URL stays valid.
	UploadStartTimeout time.Duration
	// StreamKeepBytes is the trailing text a stream keeps; StreamMaxBytes and
	// StreamMaxDuration end a stream.
	StreamKeepBytes   int
	StreamMaxBytes    int64
	StreamMaxDuration time.Duration
	// DisablePush omits server.push and push registration.
	DisablePush bool
	// AllowInsecurePush accepts http push endpoints and internal addresses.
	// Use only for development and tests.
	AllowInsecurePush bool
	// MaxConnections bounds concurrent WebSockets; 0 is unlimited.
	MaxConnections int
	// MessagesPerMinute bounds each user's new messages; 0 is unlimited.
	MessagesPerMinute int
}

func DefaultConfig() Config {
	return Config{
		OriginPatterns:     []string{"http://localhost:*", "http://127.0.0.1:*", "http://[[]::1]:*"},
		ReadLimit:          defaultReadLimit,
		OutgoingQueue:      defaultOutgoingQueue,
		HistoryPageSize:    defaultHistoryPageSize,
		PingInterval:       defaultPingInterval,
		PingTimeout:        defaultPingTimeout,
		WriteTimeout:       defaultWriteTimeout,
		MaxUploadBytes:     defaultMaxUploadBytes,
		MaxAvatarBytes:     defaultMaxAvatarBytes,
		UploadStartTimeout: defaultUploadStartTimeout,
		StreamKeepBytes:    defaultStreamKeepBytes,
		StreamMaxBytes:     defaultStreamMaxBytes,
		StreamMaxDuration:  defaultStreamMaxDuration,
	}
}

func (c Config) withDefaults() Config {
	defaults := DefaultConfig()
	if c.OriginPatterns == nil && !c.AllowAnyOrigin {
		c.OriginPatterns = defaults.OriginPatterns
	}
	if c.ReadLimit <= 0 {
		c.ReadLimit = defaults.ReadLimit
	}
	if c.OutgoingQueue <= 0 {
		c.OutgoingQueue = defaults.OutgoingQueue
	}
	if c.HistoryPageSize <= 0 {
		c.HistoryPageSize = defaults.HistoryPageSize
	}
	if c.PingInterval <= 0 {
		c.PingInterval = defaults.PingInterval
	}
	if c.PingTimeout <= 0 {
		c.PingTimeout = defaults.PingTimeout
	}
	if c.WriteTimeout <= 0 {
		c.WriteTimeout = defaults.WriteTimeout
	}
	if c.MaxUploadBytes <= 0 {
		c.MaxUploadBytes = defaults.MaxUploadBytes
	}
	if c.MaxAvatarBytes <= 0 {
		c.MaxAvatarBytes = defaults.MaxAvatarBytes
	}
	if c.UploadStartTimeout <= 0 {
		c.UploadStartTimeout = defaults.UploadStartTimeout
	}
	if c.StreamKeepBytes <= 0 {
		c.StreamKeepBytes = defaults.StreamKeepBytes
	}
	if c.StreamMaxBytes <= 0 {
		c.StreamMaxBytes = defaults.StreamMaxBytes
	}
	if c.StreamMaxDuration <= 0 {
		c.StreamMaxDuration = defaults.StreamMaxDuration
	}
	c.PublicURL = strings.TrimRight(c.PublicURL, "/")
	return c
}

// recordKind partitions the server's single append-only log (PROTOCOL.md §2).
type recordKind int

const (
	kindRoom recordKind = iota
	kindMessage
	kindReactions
)

// logRecord is one committed change. value is the complete wire object
// (including log_id) as it was at commit time; it is cloned on output and
// rewritten only by redaction (Appendix B). A record is referenced from the
// log of every room it belongs to, so a move snapshot appears in both the
// source and destination room logs.
type logRecord struct {
	id    int64
	kind  recordKind
	value map[string]any
}

func formatID(id int64) string {
	return strconv.FormatInt(id, 10)
}

type client struct {
	server *Server
	ws     *websocket.Conn
	out    chan outboundBatch
	done   chan struct{}
	stop   sync.Once

	// user is the connection's identity, nil before authentication. Guarded
	// by server.mu.
	user *userState
	// baseURL prefixes the write, file, and stream URLs this connection mints.
	baseURL  string
	origin   string
	ceremony *passkeyCeremony
	token    [32]byte
	// closing is set once the final batch is queued; later frames are dropped.
	closing atomic.Bool
}

// outboundBatch keeps a sequence of protocol frames together in the writer's
// queue while each frame is still written as its own WebSocket message. This
// lets authentication announce an arbitrary number of rooms and threads without
// consuming one queue slot per announcement or interleaving another broadcast
// between the announcements. A batch with closeReason is the connection's last:
// the writer closes the connection after writing it.
type outboundBatch struct {
	frames      [][]byte
	closeReason string
}

type Server struct {
	config Config

	mu sync.RWMutex
	// lastID is the single log_id sequence shared by every record kind and room.
	lastID int64
	rooms  map[string]*roomState
	// roomOrder lists room IDs in creation order, so parents precede threads.
	roomOrder []string
	messages  map[string]*messageState
	clients   map[*client]struct{}
	// users holds every live identity: connected guests and passkey users.
	users       map[string]*userState
	guestNumber uint64
	embedNumber uint64
	embeds      map[string]*embedState
	// writes maps an unused or in-progress write token to its embed.
	writes      map[string]*embedState
	pushes      map[string]*pushRegistration
	closed      bool
	passkeys    map[string]*passkeyUser
	credentials map[string]*passkeyUser
	sessions    map[[32]byte]passkeySession

	ops         map[string]operation
	push        *pushDeliverer
	connections sync.WaitGroup
}

func New(config Config) *Server {
	config = config.withDefaults()
	s := &Server{
		config:      config,
		rooms:       make(map[string]*roomState),
		messages:    make(map[string]*messageState),
		clients:     make(map[*client]struct{}),
		users:       make(map[string]*userState),
		embeds:      make(map[string]*embedState),
		writes:      make(map[string]*embedState),
		pushes:      make(map[string]*pushRegistration),
		passkeys:    make(map[string]*passkeyUser),
		credentials: make(map[string]*passkeyUser),
		sessions:    make(map[[32]byte]passkeySession),
	}
	s.ops = s.operations()
	s.push = newPushDeliverer(config.AllowInsecurePush)
	// The seeded default room has a logged creation record like any other room,
	// so its history_log_id is never null.
	s.commitRoomLocked(defaultRoomID, nil, map[string]any{"title": "General"})
	return s
}

const defaultRoomID = "general"

// Handler returns the HTTP handler serving /ws, /healthz, the upload, file,
// and stream endpoints, and StaticDir.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc(writePath, s.handleWrite)
	mux.HandleFunc(filePath, s.handleFile)
	mux.HandleFunc(streamPath, s.handleStream)
	if s.config.StaticDir != "" {
		root := filepath.Clean(s.config.StaticDir)
		mux.Handle("/", http.FileServer(http.Dir(root)))
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
	}
	return mux
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.Handler().ServeHTTP(w, r)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	closed := s.closed
	s.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	if closed {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

// Shutdown tells active WebSockets to retry later, closes them, ends live
// streams, and waits for the connection handlers to finish.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		for c := range s.clients {
			c.closeWithError(&rpcError{Code: codeRetryAfter, Message: "Server is shutting down; reconnect shortly", Data: map[string]any{"retry_after": 5}})
		}
		for _, e := range s.embeds {
			e.endStream()
		}
	}
	s.mu.Unlock()

	done := make(chan struct{})
	go func() {
		s.connections.Wait()
		s.push.wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		http.Error(w, "server is shutting down", http.StatusServiceUnavailable)
		return
	}
	s.connections.Add(1)
	s.mu.Unlock()
	defer s.connections.Done()

	options := &websocket.AcceptOptions{}
	if s.config.AllowAnyOrigin {
		options.InsecureSkipVerify = true
	} else {
		options.OriginPatterns = s.config.OriginPatterns
	}
	ws, err := websocket.Accept(w, r, options)
	if err != nil {
		return
	}
	ws.SetReadLimit(s.config.ReadLimit)

	c := &client{
		server:  s,
		ws:      ws,
		out:     make(chan outboundBatch, s.config.OutgoingQueue),
		done:    make(chan struct{}),
		origin:  r.Header.Get("Origin"),
		baseURL: s.baseURL(r),
	}
	go c.writeLoop()
	go c.pingLoop()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		c.stopConnection()
		return
	}
	if s.config.MaxConnections > 0 && len(s.clients) >= s.config.MaxConnections {
		// An error about the connection as a whole omits id (§1.1).
		c.enqueue(map[string]any{"method": "server", "params": s.serverParams()})
		c.closeWithError(&rpcError{Code: codeRetryAfter, Message: "Server at capacity; try again shortly", Data: map[string]any{"retry_after": retryAfterSeconds}})
		s.mu.Unlock()
		<-c.done
		return
	}
	s.clients[c] = struct{}{}
	// The server announcement is queued before the reader starts accepting auth.
	c.enqueue(map[string]any{"method": "server", "params": s.serverParams()})
	s.mu.Unlock()

	defer func() {
		c.stopConnection()
		s.mu.Lock()
		delete(s.clients, c)
		s.detachLocked(c)
		s.mu.Unlock()
	}()

	ctx := r.Context()
	for {
		messageType, payload, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if messageType != websocket.MessageText {
			_ = ws.Close(websocket.StatusUnsupportedData, "text frames required")
			return
		}
		s.processFrame(c, payload)
	}
}

// baseURL is the configured PublicURL or the scheme and host the WebSocket
// request arrived on.
func (s *Server) baseURL(r *http.Request) string {
	if s.config.PublicURL != "" {
		return s.config.PublicURL
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return (&url.URL{Scheme: scheme, Host: r.Host}).String()
}

// serverParams is the `server` frame (PROTOCOL.md §3.1).
func (s *Server) serverParams() map[string]any {
	authSchemes := []string{"guest"}
	if s.config.WebAuthn != nil {
		authSchemes = []string{"webauthn", "token", "guest"}
	}
	params := map[string]any{
		"protocol": 4,
		"name":     "apron-go/0.5",
		"caps":     []string{"history", "edit", "rooms", "reactions", "activity", "embed:upload", "embed:stream"},
		"auth":     authSchemes,
		"ext": map[string]any{"apron-go": map[string]any{
			"max_frame_bytes":           s.config.ReadLimit,
			"max_history_limit":         maxHistoryPageSize,
			"max_upload_bytes":          s.config.MaxUploadBytes,
			"max_avatar_bytes":          s.config.MaxAvatarBytes,
			"stream_keep_bytes":         s.config.StreamKeepBytes,
			"max_stream_bytes":          s.config.StreamMaxBytes,
			"max_stream_seconds":        int(s.config.StreamMaxDuration / time.Second),
			"messages_per_minute":       s.config.MessagesPerMinute,
			"write_url_timeout_seconds": int(s.config.UploadStartTimeout / time.Second),
		}},
	}
	if !s.config.DisablePush {
		params["push"] = map[string]any{"relay": map[string]any{}}
	}
	return params
}

func (c *client) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case batch := <-c.out:
			for _, payload := range batch.frames {
				select {
				case <-c.done:
					return
				default:
				}
				ctx, cancel := context.WithTimeout(context.Background(), c.server.config.WriteTimeout)
				err := c.ws.Write(ctx, websocket.MessageText, payload)
				cancel()
				if err != nil {
					c.stopConnection()
					return
				}
			}
			if batch.closeReason != "" {
				// The error frame explains the close; a close handshake would
				// wait on a peer that may not be reading.
				c.stopConnection()
				return
			}
		}
	}
}

func (c *client) pingLoop() {
	ticker := time.NewTicker(c.server.config.PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), c.server.config.PingTimeout)
			err := c.ws.Ping(ctx)
			cancel()
			if err != nil {
				c.stopConnection()
				return
			}
		}
	}
}

func (c *client) stopConnection() {
	c.stop.Do(func() {
		close(c.done)
		_ = c.ws.CloseNow()
	})
}

// closeWithError sends an error about the connection as a whole, without id
// (PROTOCOL.md §1.1), after the frames already queued, then closes the
// connection.
func (c *client) closeWithError(e *rpcError) {
	payload, err := json.Marshal(errorResponse(nil, false, e))
	if err != nil || !c.closing.CompareAndSwap(false, true) {
		return
	}
	select {
	case c.out <- outboundBatch{frames: [][]byte{payload}, closeReason: e.Message}:
	default:
		c.stopConnection()
	}
}

func (c *client) enqueue(value any) bool {
	return c.enqueueBatch(value)
}

func (c *client) enqueueBatch(values ...any) bool {
	if len(values) == 0 {
		return true
	}
	if c.closing.Load() {
		return false
	}
	batch := outboundBatch{frames: make([][]byte, 0, len(values))}
	for _, value := range values {
		payload, err := json.Marshal(value)
		if err != nil {
			c.stopConnection()
			return false
		}
		batch.frames = append(batch.frames, payload)
	}
	select {
	case <-c.done:
		return false
	case c.out <- batch:
		return true
	default:
		// A slow client cannot hold the room lock or the server's broadcast path.
		c.stopConnection()
		return false
	}
}

func (c *client) sendResult(req request, result any) {
	c.enqueue(response(req.id, req.full, result))
}

func (c *client) sendError(req request, err *rpcError) {
	c.enqueue(errorResponse(req.id, req.full, err))
}

// operation is a request handler. When it succeeds and has already queued its
// own reply (to order it before broadcasts), it reports replied.
type operation func(s *Server, c *client, req request) (result any, replied bool, err *rpcError)

func (s *Server) operations() map[string]operation {
	ops := map[string]operation{
		"me":         (*Server).updateProfile,
		"message":    (*Server).saveMessage,
		"history":    (*Server).history,
		"room":       (*Server).saveRoom,
		"room_list":  (*Server).listRooms,
		"room_join":  (*Server).joinRoom,
		"room_leave": (*Server).leaveRoom,
		"reactions":  (*Server).react,
		"activity":   (*Server).activity,
	}
	if !s.config.DisablePush {
		ops["push_register"] = (*Server).registerPush
		ops["push_unregister"] = (*Server).unregisterPush
	}
	return ops
}

func (s *Server) processFrame(c *client, payload []byte) {
	req, parseErr := parseRequest(payload)
	if parseErr != nil {
		if parseErr.Code == codeInvalidParams && !req.hasID {
			return
		}
		if req.hasID {
			c.sendError(req, parseErr)
		} else {
			c.enqueue(errorResponse(nil, req.full, parseErr))
		}
		return
	}

	if req.method == "auth" {
		if _, err := s.authenticate(c, req); err != nil && req.hasID {
			c.sendError(req, err)
		}
		return
	}

	s.mu.Lock()
	user := c.user
	if user == nil {
		s.mu.Unlock()
		if req.hasID {
			c.sendError(req, &rpcError{Code: codeDenied, Message: "Sign in before sending requests"})
		}
		return
	}
	op := s.ops[req.method]
	if op == nil {
		s.mu.Unlock()
		if req.hasID {
			c.sendError(req, &rpcError{Code: codeUnsupported, Message: "Unsupported method " + strconv.Quote(req.method)})
		}
		return
	}
	// Requests deduplicate per user (§1.2): a duplicate waits for the original,
	// even one running on another connection, and replies with its outcome.
	var entry *dedupEntry
	if req.hasID {
		fingerprint := requestFingerprint(req)
		if prior := user.dedup.get(req.id); prior != nil {
			s.mu.Unlock()
			if prior.fingerprint != fingerprint {
				c.sendError(req, invalidParams("Request id %q was already used for another operation", req.id))
				return
			}
			<-prior.done
			if prior.err != nil {
				c.sendError(req, prior.err)
			} else {
				c.sendResult(req, prior.result)
			}
			return
		}
		entry = &dedupEntry{fingerprint: fingerprint, done: make(chan struct{})}
		user.dedup.put(req.id, entry)
	}
	s.mu.Unlock()

	result, replied, err := op(s, c, req)
	if req.hasID && !replied {
		if err != nil {
			c.sendError(req, err)
		} else {
			c.sendResult(req, result)
		}
	}
	if entry != nil {
		s.mu.Lock()
		entry.result, entry.err = result, err
		if err != nil {
			// Failed operations are not cached; a retry executes again.
			user.dedup.remove(req.id, entry)
		}
		close(entry.done)
		s.mu.Unlock()
	}
}

func (c *client) isAuthenticated() bool {
	c.server.mu.RLock()
	defer c.server.mu.RUnlock()
	return c.user != nil
}

// nextIDLocked returns the next log_id in the server-wide sequence: the commit
// time in milliseconds, or the previous log_id + 1.
func (s *Server) nextIDLocked() int64 {
	s.lastID = max(time.Now().UnixMilli(), s.lastID+1)
	return s.lastID
}

// appendLocked adds a committed record to the log of each room it belongs to.
func (s *Server) appendLocked(record *logRecord, rooms ...*roomState) {
	for _, r := range rooms {
		r.log = append(r.log, record)
		r.latestID = record.id
	}
}

var _ http.Handler = (*Server)(nil)
