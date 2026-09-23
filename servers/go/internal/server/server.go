package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/go-webauthn/webauthn/webauthn"
)

const (
	defaultReadLimit       int64 = 256 << 10
	defaultOutgoingQueue         = 128
	defaultHistoryPageSize       = 100
	defaultPingInterval          = 30 * time.Second
	defaultPingTimeout           = 10 * time.Second
	defaultWriteTimeout          = 10 * time.Second
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
}

func DefaultConfig() Config {
	return Config{
		OriginPatterns:  []string{"http://localhost:*", "http://127.0.0.1:*", "http://[[]::1]:*"},
		ReadLimit:       defaultReadLimit,
		OutgoingQueue:   defaultOutgoingQueue,
		HistoryPageSize: defaultHistoryPageSize,
		PingInterval:    defaultPingInterval,
		PingTimeout:     defaultPingTimeout,
		WriteTimeout:    defaultWriteTimeout,
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
	return c
}

type identity struct {
	ID   string `json:"user_id"`
	Name string `json:"name,omitempty"`
}

func (i identity) object() map[string]any {
	value := map[string]any{"user_id": i.ID}
	if i.Name != "" {
		value["name"] = i.Name
	}
	return value
}

// recordKind partitions the server's single append-only log (PROTOCOL.md §2).
type recordKind int

const (
	kindRoom recordKind = iota
	kindMessage
	kindReactions
)

// logRecord is one committed change. value is the complete, immutable wire
// object (including log_id) as it was at commit time; it is cloned on output.
// A record is referenced from the log of every room it belongs to, so a move
// snapshot appears in both the source and destination room logs.
type logRecord struct {
	id    int64
	kind  recordKind
	value map[string]any
}

// roomState is a room's current record and its log. All rooms, including
// threads (rooms with parent_room_id), are visible to every authenticated user.
type roomState struct {
	id     string
	parent string
	// record holds the latest logged room record with a bare intro_message.
	record    map[string]any
	createdID int64
	latestID  int64
	log       []*logRecord
}

// deliveryFields returns the room's log head and the inclusive lower bound of
// retained history. The Go server retains every record, so history always
// starts at the room's creation record. Callers hold s.mu.
func (r *roomState) deliveryFields() map[string]any {
	return map[string]any{
		"latest_log_id":  formatID(r.latestID),
		"history_log_id": formatID(r.createdID),
	}
}

type reactionSet struct {
	from   map[string]any
	emojis []string
}

// messageState is the current state of one message. Only non-empty reaction
// sets are kept; clearing removes the user's entry.
type messageState struct {
	snapshot  map[string]any
	owner     string
	roomID    string
	reactions map[string]reactionSet
}

func formatID(id int64) string {
	return strconv.FormatInt(id, 10)
}

type dedupResult struct {
	fingerprint string
	result      any
	err         *rpcError
}

type client struct {
	server *Server
	ws     *websocket.Conn
	out    chan outboundBatch
	done   chan struct{}
	stop   sync.Once

	mu       sync.Mutex
	dedup    map[string]dedupResult
	identity identity
	authed   bool
	origin   string
	ceremony *passkeyCeremony
	token    [32]byte
}

// outboundBatch keeps a sequence of protocol frames together in the writer's
// queue while each frame is still written as its own WebSocket message. This
// lets authentication announce an arbitrary number of rooms and threads without
// consuming one queue slot per announcement or interleaving another broadcast
// between the announcements.
type outboundBatch [][]byte

type Server struct {
	config Config

	mu sync.RWMutex
	// lastID is the single log_id sequence shared by every record kind and room.
	lastID int64
	rooms  map[string]*roomState
	// roomOrder lists room IDs in creation order, so parents precede threads.
	roomOrder   []string
	messages    map[string]*messageState
	clients     map[*client]struct{}
	guestNumber uint64
	closed      bool
	users       map[string]*passkeyUser
	credentials map[string]*passkeyUser
	sessions    map[[32]byte]passkeySession

	connections sync.WaitGroup
}

func New(config Config) *Server {
	config = config.withDefaults()
	s := &Server{
		config:      config,
		rooms:       make(map[string]*roomState),
		messages:    make(map[string]*messageState),
		clients:     make(map[*client]struct{}),
		users:       make(map[string]*passkeyUser),
		credentials: make(map[string]*passkeyUser),
		sessions:    make(map[[32]byte]passkeySession),
	}
	// The seeded default room has a logged creation record like any other room,
	// so its history_log_id is never null.
	s.commitRoomLocked(defaultRoomID, "", map[string]any{"title": "General"})
	return s
}

const defaultRoomID = "general"

// Handler returns the HTTP handler serving /ws, /healthz, and StaticDir.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/healthz", s.handleHealth)
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

// Shutdown closes active WebSockets and waits for their handlers to finish.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		for c := range s.clients {
			c.stopConnection()
		}
	}
	s.mu.Unlock()

	done := make(chan struct{})
	go func() {
		s.connections.Wait()
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
		server: s,
		ws:     ws,
		out:    make(chan outboundBatch, s.config.OutgoingQueue),
		done:   make(chan struct{}),
		dedup:  make(map[string]dedupResult),
		origin: r.Header.Get("Origin"),
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = ws.Close(websocket.StatusGoingAway, "server is shutting down")
		return
	}
	s.clients[c] = struct{}{}
	s.mu.Unlock()

	defer func() {
		c.stopConnection()
		s.mu.Lock()
		delete(s.clients, c)
		s.mu.Unlock()
	}()

	go c.writeLoop()
	go c.pingLoop()
	// The server announcement is queued before the reader starts accepting auth.
	authSchemes := []string{"guest"}
	if s.config.WebAuthn != nil {
		authSchemes = []string{"webauthn", "token", "guest"}
	}
	c.enqueue(map[string]any{
		"method": "server",
		"params": map[string]any{
			"protocol": 4,
			"name":     "apron-go/0.4",
			"caps":     []string{"history", "edit", "rooms", "reactions", "activity"},
			"auth":     authSchemes,
		},
	})

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

func (c *client) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case batch := <-c.out:
			for _, payload := range batch {
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

func (c *client) enqueue(value any) bool {
	return c.enqueueBatch(value)
}

func (c *client) enqueueBatch(values ...any) bool {
	if len(values) == 0 {
		return true
	}
	batch := make(outboundBatch, 0, len(values))
	for _, value := range values {
		payload, err := json.Marshal(value)
		if err != nil {
			c.stopConnection()
			return false
		}
		batch = append(batch, payload)
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

func (s *Server) processFrame(c *client, payload []byte) {
	req, parseErr := parseRequest(payload)
	if parseErr != nil {
		if parseErr.Code == codeInvalidParams && !req.hasID {
			return
		}
		if req.hasID {
			c.enqueue(errorResponse(req.id, req.full, parseErr))
		} else {
			c.enqueue(errorResponse(nil, req.full, parseErr))
		}
		return
	}

	if req.hasID && req.method != "auth" {
		fingerprint := requestFingerprint(req)
		c.mu.Lock()
		previous, exists := c.dedup[req.id]
		c.mu.Unlock()
		if exists {
			if previous.fingerprint != fingerprint {
				c.sendError(req, invalidParams("Request id was already used for another operation"))
				return
			}
			if previous.err != nil {
				c.sendError(req, previous.err)
			} else {
				c.sendResult(req, previous.result)
			}
			return
		}
	}

	if req.method != "auth" && !c.isAuthenticated() {
		if req.hasID {
			c.sendError(req, &rpcError{Code: codeDenied, Message: "Authenticate first"})
		}
		return
	}

	var result any
	var operationErr *rpcError
	cacheResult := false
	responseSent := false
	switch req.method {
	case "auth":
		result, operationErr = s.authenticate(c, req)
		responseSent = operationErr == nil
	case "me":
		result, operationErr = s.updateProfile(c, req)
		cacheResult = operationErr == nil
	case "message":
		result, operationErr = s.saveMessage(c, req)
		cacheResult = operationErr == nil
		responseSent = operationErr == nil
	case "history":
		result, operationErr = s.history(req)
		cacheResult = operationErr == nil
	case "room":
		result, operationErr = s.saveRoom(c, req)
		cacheResult = operationErr == nil
		responseSent = operationErr == nil
	case "room_join":
		result, operationErr = s.joinRoom(c, req)
		cacheResult = operationErr == nil
		responseSent = operationErr == nil
	case "room_leave":
		result, operationErr = s.leaveRoom(req)
		cacheResult = operationErr == nil
	case "reactions":
		result, operationErr = s.react(c, req)
		cacheResult = operationErr == nil
		responseSent = operationErr == nil
	case "activity":
		result, operationErr = s.activity(c, req)
		cacheResult = operationErr == nil
		responseSent = operationErr == nil
	default:
		operationErr = &rpcError{Code: codeUnsupported, Message: "Unsupported method"}
	}

	if req.hasID && !responseSent {
		if operationErr != nil {
			c.sendError(req, operationErr)
		} else {
			c.sendResult(req, result)
		}
	}
	if req.hasID && cacheResult {
		c.mu.Lock()
		c.dedup[req.id] = dedupResult{fingerprint: requestFingerprint(req), result: result}
		c.mu.Unlock()
	}
}

func (c *client) isAuthenticated() bool {
	c.server.mu.RLock()
	authed := c.authed
	c.server.mu.RUnlock()
	return authed
}

func (c *client) sendResult(req request, result any) {
	c.enqueue(response(req.id, req.full, result))
}

func (c *client) sendError(req request, err *rpcError) {
	c.enqueue(errorResponse(req.id, req.full, err))
}

func (s *Server) authenticate(c *client, req request) (any, *rpcError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	scheme, err := parseString(req.params, "scheme", true)
	if err != nil {
		return nil, err
	}
	if scheme == "webauthn" {
		return s.authenticatePasskey(c, req)
	}
	if scheme == "token" {
		if s.config.WebAuthn == nil {
			return nil, &rpcError{Code: codeUnsupported, Message: "Unsupported authentication scheme"}
		}
		return s.authenticateToken(c, req, time.Now())
	}
	if scheme != "guest" {
		return nil, &rpcError{Code: codeUnsupported, Message: "Unsupported authentication scheme"}
	}
	name, err := parseString(req.params, "name", false)
	if err != nil {
		return nil, err
	}
	if c.authed {
		result := map[string]any{"you": c.identity.object()}
		if req.hasID {
			c.enqueue(response(req.id, req.full, result))
		}
		return result, nil
	}
	s.guestNumber++
	c.identity = identity{ID: fmt.Sprintf("guest_%d", s.guestNumber), Name: name}
	c.authed = true

	result := map[string]any{"you": c.identity.object()}
	s.announceAuthenticated(c, req, result)
	return result, nil
}

// announceAuthenticated runs under s.mu, ordering identity before the room
// announcements and both before any later broadcast. Rooms are announced in
// creation order, so every parent precedes its threads.
func (s *Server) announceAuthenticated(c *client, req request, result map[string]any) {
	frames := make([]any, 0, 1+len(s.roomOrder))
	if req.hasID {
		frames = append(frames, response(req.id, req.full, result))
	}
	for _, roomID := range s.roomOrder {
		frames = append(frames, s.roomAnnouncementLocked(s.rooms[roomID]))
	}
	c.enqueueBatch(frames...)
}

// roomAnnouncementLocked renders a room's current record with the current
// intro_message snapshot embedded and this client's delivery fields.
func (s *Server) roomAnnouncementLocked(r *roomState) map[string]any {
	return roomFrame(s.embedIntroLocked(r.record), r)
}

func roomFrame(record map[string]any, r *roomState) map[string]any {
	params := cloneObject(record)
	for key, value := range r.deliveryFields() {
		params[key] = value
	}
	return map[string]any{"method": "room", "params": params}
}

// embedIntroLocked returns a copy of a room record whose bare intro_message
// reference is replaced by the referenced message's current snapshot.
func (s *Server) embedIntroLocked(record map[string]any) map[string]any {
	value := cloneObject(record)
	if intro, ok := value["intro_message"].(map[string]any); ok {
		if id, ok := intro["message_id"].(string); ok {
			if m := s.messages[id]; m != nil {
				value["intro_message"] = cloneObject(m.snapshot)
			}
		}
	}
	return value
}

// updateProfile applies a `me` request (PROTOCOL.md §3.3). A given name
// replaces the current one and "" removes it; an omitted name is unchanged.
// Profile avatars and ext are not supported, so those fields are declined.
func (s *Server) updateProfile(c *client, req request) (any, *rpcError) {
	name, err := parseString(req.params, "name", false)
	if err != nil {
		return nil, err
	}
	_, hasName := req.params["name"]
	s.mu.Lock()
	defer s.mu.Unlock()
	if hasName {
		c.identity.Name = name
		if user := s.users[c.identity.ID]; user != nil {
			user.identity.Name = name
		}
	}
	return map[string]any{"you": c.identity.object()}, nil
}

// saveMessage creates a message (no message_id) or saves an existing one
// (Appendix B): every client field is replaced by the submitted state. A save
// naming a different room_id moves the message; the snapshot is logged in and
// broadcast to both rooms, followed by a reactions record in the destination
// when the message has reactions.
func (s *Server) saveMessage(c *client, req request) (any, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, err
	}
	messageID, err := parseString(req.params, "message_id", false)
	if err != nil {
		return nil, err
	}
	_, replacing := req.params["message_id"]
	if replacing && !validMessageID(messageID) {
		return nil, invalidParams("message_id must be a positive decimal string")
	}
	replyID, hasReply, err := parseMessageRef(req.params, "reply_to")
	if err != nil {
		return nil, err
	}
	deleted, err := parseBool(req.params, "deleted", false)
	if err != nil {
		return nil, err
	}
	if deleted && !replacing {
		return nil, invalidParams("Cannot create a deleted message")
	}
	var body map[string]any
	if !deleted {
		body, err = parseObject(req.params, "body", true)
		if err != nil {
			return nil, err
		}
		if err := validateBody(body); err != nil {
			return nil, err
		}
	}
	ext, err := parseObject(req.params, "ext", false)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	destination := s.rooms[roomID]
	if destination == nil {
		return nil, invalidParams("Unknown room %q", roomID)
	}
	from := c.identity.object()
	var current *messageState
	if replacing {
		current = s.messages[messageID]
		if current == nil {
			return nil, invalidParams("Unknown message %q", messageID)
		}
		if current.owner != c.identity.ID {
			return nil, &rpcError{Code: codeDenied, Message: "Only the author may update this message"}
		}
		from = cloneObject(current.snapshot["from"].(map[string]any))
	}
	if hasReply {
		if _, exists := s.messages[replyID]; !exists || (replacing && replyID == messageID) {
			return nil, invalidParams("reply_to must name another existing message")
		}
	}

	logID := s.nextIDLocked()
	if !replacing {
		messageID = formatID(logID)
	}
	snapshot := map[string]any{
		"message_id": messageID,
		"log_id":     formatID(logID),
		"room_id":    roomID,
		"from":       from,
	}
	if deleted {
		snapshot["deleted"] = true
	} else {
		snapshot["body"] = body
	}
	if hasReply {
		snapshot["reply_to"] = map[string]any{"message_id": replyID}
	}
	if ext != nil {
		snapshot["ext"] = ext
	}

	members := []*roomState{destination}
	moved := false
	if current == nil {
		current = &messageState{owner: c.identity.ID, reactions: make(map[string]reactionSet)}
		s.messages[messageID] = current
	} else if current.roomID != roomID {
		moved = true
		members = []*roomState{s.rooms[current.roomID], destination}
	}
	current.snapshot = snapshot
	current.roomID = roomID
	s.appendLocked(&logRecord{id: logID, kind: kindMessage, value: snapshot}, members...)

	result := map[string]any{"message_id": messageID}
	if req.hasID {
		c.enqueue(response(req.id, req.full, result))
	}
	s.broadcastLocked(map[string]any{"method": "message", "params": snapshot})
	if moved && len(current.reactions) > 0 {
		s.commitReactionsLocked(current, current.reactionElements())
	}
	return result, nil
}

// reactionElements returns every non-empty reaction set, ordered by user ID.
func (m *messageState) reactionElements() []any {
	users := make([]string, 0, len(m.reactions))
	for userID := range m.reactions {
		users = append(users, userID)
	}
	sort.Strings(users)
	elements := make([]any, 0, len(users))
	for _, userID := range users {
		set := m.reactions[userID]
		elements = append(elements, map[string]any{"from": cloneObject(set.from), "emojis": slices.Clone(set.emojis)})
	}
	return elements
}

func validMessageID(id string) bool {
	if len(id) == 0 || id[0] < '1' || id[0] > '9' {
		return false
	}
	for _, ch := range id {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

// parseMessageRef reads a message reference (reply_to, intro_message). Clients
// send bare references; any other keys, such as an echoed snapshot, are ignored.
func parseMessageRef(params map[string]json.RawMessage, name string) (string, bool, *rpcError) {
	raw, present := params[name]
	if !present {
		return "", false, nil
	}
	var ref map[string]json.RawMessage
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &ref) != nil || ref == nil {
		return "", false, invalidParams("%s must be a message object", name)
	}
	id, err := parseString(ref, "message_id", true)
	if err != nil || !validMessageID(id) {
		return "", false, invalidParams("%s.message_id must be a positive decimal string", name)
	}
	return id, true, nil
}

func validateBody(body map[string]any) *rpcError {
	if raw, ok := body["text"]; ok {
		if _, ok := raw.(string); !ok {
			return invalidParams("body.text must be a string")
		}
	}
	if raw, ok := body["format"]; ok {
		format, ok := raw.(string)
		if !ok || (format != "plain" && format != "markdown") {
			return invalidParams("body.format must be plain or markdown")
		}
	}
	if raw, ok := body["embeds"]; ok {
		if _, ok := raw.([]any); !ok {
			return invalidParams("body.embeds must be an array")
		}
	}
	return nil
}

// saveRoom creates a room (no room_id) or replaces an existing room's client
// fields (Appendix C). parent_room_id is fixed at creation and ignored on
// updates. Any authenticated user may create rooms and threads and update any
// room's client fields.
func (s *Server) saveRoom(c *client, req request) (any, *rpcError) {
	_, updating := req.params["room_id"]
	var roomID, parent string
	var err *rpcError
	if updating {
		roomID, err = parseString(req.params, "room_id", true)
		if err != nil {
			return nil, err
		}
	} else if _, present := req.params["parent_room_id"]; present {
		parent, err = parseString(req.params, "parent_room_id", true)
		if err != nil {
			return nil, err
		}
		if parent == "" {
			return nil, invalidParams("parent_room_id must be a non-empty string")
		}
	}
	title, err := parseString(req.params, "title", false)
	if err != nil {
		return nil, err
	}
	introID, hasIntro, err := parseMessageRef(req.params, "intro_message")
	if err != nil {
		return nil, err
	}
	ext, err := parseObject(req.params, "ext", false)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if updating {
		existing := s.rooms[roomID]
		if existing == nil {
			return nil, invalidParams("Unknown room %q", roomID)
		}
		parent = existing.parent
	} else if parent != "" && s.rooms[parent] == nil {
		return nil, invalidParams("Unknown parent room %q", parent)
	}
	if hasIntro && s.messages[introID] == nil {
		return nil, invalidParams("Unknown intro_message %q", introID)
	}
	fields := make(map[string]any)
	if title == "" && parent != "" {
		// Servers title threads so clients unaware of parent_room_id render them.
		title = s.threadTitleLocked(introID)
	}
	if title != "" {
		fields["title"] = title
	}
	if hasIntro {
		fields["intro_message"] = map[string]any{"message_id": introID}
	}
	if ext != nil {
		fields["ext"] = ext
	}
	r, record := s.commitRoomLocked(roomID, parent, fields)
	result := map[string]any{"room_id": r.id}
	if req.hasID {
		c.enqueue(response(req.id, req.full, result))
	}
	s.broadcastLocked(roomFrame(record, r))
	return result, nil
}

const maxThreadTitleRunes = 60

// threadTitleLocked derives a default thread title from the intro message's
// first line of text.
func (s *Server) threadTitleLocked(introID string) string {
	if m := s.messages[introID]; m != nil {
		if body, ok := m.snapshot["body"].(map[string]any); ok {
			text, _ := body["text"].(string)
			line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
			line = strings.TrimSpace(line)
			if runes := []rune(line); len(runes) > maxThreadTitleRunes {
				line = strings.TrimSpace(string(runes[:maxThreadTitleRunes])) + "…"
			}
			if line != "" {
				return line
			}
		}
	}
	return "Thread"
}

// commitRoomLocked logs a room record holding fields, the client fields other
// than parent_room_id. An unknown roomID creates the room; an empty one names
// it by its creation log_id. It returns the logged record, whose
// intro_message embeds the snapshot current at commit time.
func (s *Server) commitRoomLocked(roomID, parent string, fields map[string]any) (*roomState, map[string]any) {
	logID := s.nextIDLocked()
	r := s.rooms[roomID]
	if r == nil {
		if roomID == "" {
			roomID = formatID(logID)
		}
		r = &roomState{id: roomID, parent: parent, createdID: logID}
		s.rooms[roomID] = r
		s.roomOrder = append(s.roomOrder, roomID)
	}
	record := map[string]any{"room_id": r.id, "log_id": formatID(logID)}
	if r.parent != "" {
		record["parent_room_id"] = r.parent
	}
	for key, value := range fields {
		record[key] = value
	}
	r.record = record
	logged := s.embedIntroLocked(record)
	s.appendLocked(&logRecord{id: logID, kind: kindRoom, value: logged}, r)
	return r, logged
}

// joinRoom re-announces a known room. Every room is visible to everyone, so
// joining changes no membership.
func (s *Server) joinRoom(c *client, req request) (any, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.rooms[roomID]
	if r == nil {
		return nil, invalidParams("Unknown room %q", roomID)
	}
	result := map[string]any{}
	frames := make([]any, 0, 2)
	if req.hasID {
		frames = append(frames, response(req.id, req.full, result))
	}
	frames = append(frames, s.roomAnnouncementLocked(r))
	c.enqueueBatch(frames...)
	return result, nil
}

// leaveRoom is denied by policy: every room stays visible to every user.
func (s *Server) leaveRoom(req request) (any, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.rooms[roomID] == nil {
		return nil, invalidParams("Unknown room %q", roomID)
	}
	return nil, &rpcError{Code: codeDenied, Message: "Rooms on this server cannot be left"}
}

const (
	maxEmojiBytes    = 64
	maxDistinctEmoji = 20
)

// react replaces the caller's complete reaction set on one message
// (Appendix D.2). Duplicates collapse; an unchanged set logs nothing.
func (s *Server) react(c *client, req request) (any, *rpcError) {
	messageID, err := parseString(req.params, "message_id", true)
	if err != nil {
		return nil, err
	}
	emojis, err := parseEmojis(req.params)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.messages[messageID]
	if m == nil {
		return nil, invalidParams("Unknown message %q", messageID)
	}
	result := map[string]any{}
	if req.hasID {
		c.enqueue(response(req.id, req.full, result))
	}
	if sameEmojiSet(m.reactions[c.identity.ID].emojis, emojis) {
		return result, nil
	}
	from := c.identity.object()
	if len(emojis) == 0 {
		delete(m.reactions, c.identity.ID)
	} else {
		m.reactions[c.identity.ID] = reactionSet{from: from, emojis: emojis}
	}
	s.commitReactionsLocked(m, []any{map[string]any{"from": cloneObject(from), "emojis": slices.Clone(emojis)}})
	return result, nil
}

// commitReactionsLocked logs and broadcasts one reactions record in the
// message's current room.
func (s *Server) commitReactionsLocked(m *messageState, elements []any) {
	logID := s.nextIDLocked()
	value := map[string]any{
		"log_id":     formatID(logID),
		"message_id": m.snapshot["message_id"],
		"room_id":    m.roomID,
		"reactions":  elements,
	}
	s.appendLocked(&logRecord{id: logID, kind: kindReactions, value: value}, s.rooms[m.roomID])
	s.broadcastLocked(map[string]any{"method": "reactions", "params": value})
}

func parseEmojis(params map[string]json.RawMessage) ([]string, *rpcError) {
	raw, ok := params["emojis"]
	if !ok {
		return nil, invalidParams("Missing emojis")
	}
	var values []json.RawMessage
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &values) != nil {
		return nil, invalidParams("emojis must be an array of strings")
	}
	emojis := make([]string, 0, len(values))
	for _, value := range values {
		var emoji string
		if json.Unmarshal(value, &emoji) != nil || emoji == "" || len(emoji) > maxEmojiBytes {
			return nil, invalidParams("emojis must be non-empty strings of at most %d bytes", maxEmojiBytes)
		}
		if !slices.Contains(emojis, emoji) {
			emojis = append(emojis, emoji)
		}
	}
	if len(emojis) > maxDistinctEmoji {
		return nil, invalidParams("At most %d distinct emoji per message", maxDistinctEmoji)
	}
	return emojis, nil
}

func sameEmojiSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, emoji := range a {
		if !slices.Contains(b, emoji) {
			return false
		}
	}
	return true
}

// history returns a window of one room's log (Appendix A). limit counts records
// of every kind; the slice is partitioned into rooms, entries, and reactions.
// The server retains all records and does not compact.
func (s *Server) history(req request) (any, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, err
	}
	after, hasAfter, err := parseBound(req.params, "after")
	if err != nil {
		return nil, err
	}
	before, hasBefore, err := parseBound(req.params, "before")
	if err != nil {
		return nil, err
	}
	limit, err := parseLimit(req.params, s.config.HistoryPageSize)
	if err != nil {
		return nil, err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	r := s.rooms[roomID]
	if r == nil {
		return nil, invalidParams("Unknown room %q", roomID)
	}
	matching := make([]*logRecord, 0)
	for _, record := range r.log {
		if (hasAfter && record.id < after) || (hasBefore && record.id > before) {
			continue
		}
		matching = append(matching, record)
	}
	more := len(matching) > limit
	if more {
		if hasAfter {
			matching = matching[:limit]
		} else {
			matching = matching[len(matching)-limit:]
		}
	}
	rooms := make([]any, 0)
	entries := make([]any, 0, len(matching))
	reactions := make([]any, 0)
	for _, record := range matching {
		value := cloneObject(record.value)
		switch record.kind {
		case kindRoom:
			rooms = append(rooms, value)
		case kindMessage:
			entries = append(entries, value)
		case kindReactions:
			reactions = append(reactions, value)
		}
	}
	result := map[string]any{"rooms": rooms, "entries": entries, "reactions": reactions, "more": more}
	for key, value := range r.deliveryFields() {
		result[key] = value
	}
	if len(matching) > 0 {
		result["first_id"] = formatID(matching[0].id)
		result["last_id"] = formatID(matching[len(matching)-1].id)
	}
	return result, nil
}

func parseBound(params map[string]json.RawMessage, name string) (int64, bool, *rpcError) {
	raw, ok := params[name]
	if !ok {
		return 0, false, nil
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return 0, false, invalidParams("%s must be a decimal string", name)
	}
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil || number < 0 {
		return 0, false, invalidParams("%s must be a non-negative decimal string", name)
	}
	return number, true, nil
}

func parseLimit(params map[string]json.RawMessage, defaultLimit int) (int, *rpcError) {
	raw, ok := params["limit"]
	if !ok {
		return defaultLimit, nil
	}
	var value int
	if json.Unmarshal(raw, &value) != nil || value <= 0 {
		return 0, invalidParams("limit must be a positive integer")
	}
	if value > 1000 {
		value = 1000
	}
	return value, nil
}

// activity relays a user's typing state in a room (Appendix D.1). Only typing
// is supported: read_message_id is dropped, and a frame without typing
// broadcasts nothing.
func (s *Server) activity(c *client, req request) (any, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, err
	}
	var typing any
	if raw, ok := req.params["typing"]; ok {
		var value int
		if json.Unmarshal(raw, &value) != nil || value < 0 {
			return nil, invalidParams("typing must be a non-negative integer")
		}
		typing = value
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rooms[roomID] == nil {
		return nil, invalidParams("Unknown room %q", roomID)
	}
	result := map[string]any{}
	if req.hasID {
		c.enqueue(response(req.id, req.full, result))
	}
	if typing != nil {
		s.broadcastLocked(map[string]any{"method": "activity", "params": map[string]any{
			"room_id": roomID,
			"from":    c.identity.object(),
			"typing":  typing,
		}})
	}
	return result, nil
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

func (s *Server) broadcastLocked(frame any) {
	for c := range s.clients {
		if c.authed {
			c.enqueue(frame)
		}
	}
}

var _ http.Handler = (*Server)(nil)
