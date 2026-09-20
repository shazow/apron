package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
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
	ID     string `json:"user_id"`
	Name   string `json:"name,omitempty"`
	Avatar string `json:"avatar,omitempty"`
}

func (i identity) object() map[string]any {
	value := map[string]any{"user_id": i.ID}
	if i.Name != "" {
		value["name"] = i.Name
	}
	if i.Avatar != "" {
		value["avatar"] = i.Avatar
	}
	return value
}

type transition struct {
	id             int64
	message        map[string]any
	previousThread string
}

type threadMetadata struct {
	id     string
	fields map[string]any
}

func (t threadMetadata) announcement(roomID string) map[string]any {
	params := cloneObject(t.fields)
	params["room_id"] = roomID
	params["thread_id"] = t.id
	return map[string]any{"method": "thread", "params": params}
}

func (t transition) historyEntry() map[string]any {
	return map[string]any{"log_id": t.idString(), "message": cloneObject(t.message)}
}

func (t transition) idString() string {
	return strconv.FormatInt(t.id, 10)
}

type room struct {
	id      string
	entries []transition
	lastID  int64
	// states contains the latest message snapshots and is the server's current state.
	states  map[string]map[string]any
	owners  map[string]string
	threads map[string]threadMetadata
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
}

// outboundBatch keeps a sequence of protocol frames together in the writer's
// queue while each frame is still written as its own WebSocket message. This
// lets authentication announce an arbitrary number of retained threads without
// consuming one queue slot per announcement or interleaving another broadcast
// between the room and thread announcements.
type outboundBatch [][]byte

type Server struct {
	config Config

	mu          sync.RWMutex
	room        room
	clients     map[*client]struct{}
	guestNumber uint64
	closed      bool

	connections sync.WaitGroup
}

func New(config Config) *Server {
	config = config.withDefaults()
	return &Server{
		config:  config,
		clients: make(map[*client]struct{}),
		room: room{
			id:      "general",
			states:  make(map[string]map[string]any),
			owners:  make(map[string]string),
			threads: make(map[string]threadMetadata),
			entries: make([]transition, 0),
		},
	}
}

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
	c.enqueue(map[string]any{
		"method": "server",
		"params": map[string]any{
			"protocol": 2,
			"name":     "apron-go/0.1",
			"caps":     []string{"history", "edit"},
			"auth":     []string{"anonymous"},
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

	if req.hasID {
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
		cacheResult = operationErr == nil
		responseSent = operationErr == nil
	case "nick":
		result, operationErr = s.rename(c, req)
		cacheResult = operationErr == nil
	case "message":
		result, operationErr = s.saveMessage(c, req)
		cacheResult = operationErr == nil
		responseSent = operationErr == nil
	case "history":
		result, operationErr = s.history(req)
		cacheResult = operationErr == nil
	case "thread":
		result, operationErr = s.saveThread(c, req)
		cacheResult = operationErr == nil
		responseSent = operationErr == nil
	case "typing":
		result, operationErr = s.typing(c, req)
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
	if c.authed {
		result := map[string]any{"you": c.identity.object()}
		if req.hasID {
			c.enqueue(response(req.id, req.full, result))
		}
		return result, nil
	}
	s.guestNumber++
	c.identity = identity{ID: fmt.Sprintf("guest_%d", s.guestNumber)}
	c.authed = true

	result := map[string]any{"you": c.identity.object()}
	frames := make([]any, 0, 2+len(s.room.threads))
	if req.hasID {
		frames = append(frames, response(req.id, req.full, result))
	}
	frames = append(frames, map[string]any{
		"method": "room",
		"params": map[string]any{
			"room_id":   s.room.id,
			"name":      "General",
			"latest_id": strconv.FormatInt(s.room.lastID, 10),
		},
	})
	threadIDs := make([]string, 0, len(s.room.threads))
	for threadID := range s.room.threads {
		threadIDs = append(threadIDs, threadID)
	}
	sort.Strings(threadIDs)
	for _, threadID := range threadIDs {
		frames = append(frames, s.room.threads[threadID].announcement(s.room.id))
	}
	c.enqueueBatch(frames...)
	return result, nil
}

func (s *Server) rename(c *client, req request) (any, *rpcError) {
	name, err := parseString(req.params, "name", true)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	c.identity.Name = name
	result := map[string]any{"you": c.identity.object()}
	s.mu.Unlock()
	return result, nil
}

func (s *Server) saveMessage(c *client, req request) (any, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, err
	}
	if roomID != s.room.id {
		return nil, invalidParams("Unknown room %q", roomID)
	}
	if _, present := req.params["log_id"]; present {
		return nil, invalidParams("log_id is server-controlled")
	}
	messageID, err := parseString(req.params, "message_id", false)
	if err != nil {
		return nil, err
	}
	_, replacing := req.params["message_id"]
	if replacing && !validMessageID(messageID) {
		return nil, invalidParams("message_id must be a positive decimal string")
	}
	replyID, err := parseString(req.params, "reply_message_id", false)
	if err != nil {
		return nil, err
	}
	_, hasReply := req.params["reply_message_id"]
	if hasReply && !validMessageID(replyID) {
		return nil, invalidParams("reply_message_id must be a positive decimal string")
	}
	deleted, err := parseBool(req.params, "deleted", false)
	if err != nil {
		return nil, err
	}
	if deleted && !replacing {
		return nil, invalidParams("Cannot create a deleted message")
	}
	next := make(map[string]any)
	for key, raw := range req.params {
		if key == "room_id" || key == "message_id" || key == "from" || (deleted && key == "body") {
			continue
		}
		var value any
		if json.Unmarshal(raw, &value) != nil {
			return nil, invalidParams("Invalid %s", key)
		}
		next[key] = value
	}
	if !deleted {
		body, err := parseObject(req.params, "body", true)
		if err != nil {
			return nil, err
		}
		if err := validateBody(body); err != nil {
			return nil, err
		}
	}
	threadID, hasThread, err := parseThread(req.params)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var previousThread string
	from := c.identity.object()
	if replacing {
		previous, exists := s.room.states[messageID]
		if !exists {
			return nil, invalidParams("Unknown message %q", messageID)
		}
		if s.room.owners[messageID] != c.identity.ID {
			return nil, &rpcError{Code: codeDenied, Message: "Only the author may update this message"}
		}
		from = cloneObject(previous["from"].(map[string]any))
		previousThread, _ = previous["thread_id"].(string)
	}
	if hasThread {
		if _, exists := s.room.threads[threadID]; !exists {
			return nil, invalidParams("Unknown thread %q", threadID)
		}
	}
	if hasReply {
		target, exists := s.room.states[replyID]
		if !exists || (replacing && replyID == messageID) {
			return nil, invalidParams("Reply target must be another message in this room")
		}
		targetThread, _ := target["thread_id"].(string)
		if targetThread != threadID {
			return nil, invalidParams("Reply target must be in the same thread")
		}
	}
	if replacing && previousThread != threadID {
		for _, message := range s.room.states {
			if message["reply_message_id"] == messageID {
				return nil, invalidParams("Cannot move a message with replies to another thread")
			}
		}
	}
	logID := s.nextIDLocked()
	if !replacing {
		messageID = logID
	}
	next["message_id"] = messageID
	next["from"] = from
	s.room.states[messageID] = next
	s.room.owners[messageID] = c.identity.ID
	s.room.entries = append(s.room.entries, transition{id: s.room.lastID, message: next, previousThread: previousThread})
	result := map[string]any{"message_id": messageID}
	params := map[string]any{"room_id": roomID, "log_id": logID, "message": cloneObject(next)}
	if req.hasID {
		params["echo"] = req.id
		c.enqueue(response(req.id, req.full, result))
	}
	s.broadcastLocked(map[string]any{"method": "message", "params": params})
	return result, nil
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

func (s *Server) saveThread(c *client, req request) (any, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, err
	}
	if roomID != s.room.id {
		return nil, invalidParams("Unknown room %q", roomID)
	}
	if _, exists := req.params["thread_id"]; exists {
		id, err := parseString(req.params, "thread_id", true)
		if err != nil {
			return nil, err
		}
		summary, err := parseString(req.params, "summary", true)
		if err != nil {
			return nil, err
		}
		for _, key := range []string{"title", "root_message_id"} {
			if _, present := req.params[key]; present {
				return nil, invalidParams("Only the summary can be edited")
			}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		metadata, exists := s.room.threads[id]
		if !exists {
			return nil, invalidParams("Unknown thread %q", id)
		}
		// Summaries are shared room notes; any authenticated participant may edit them.
		if summary == "" {
			delete(metadata.fields, "summary")
		} else {
			metadata.fields["summary"] = summary
		}
		result := map[string]any{"thread_id": id}
		if req.hasID {
			c.enqueue(response(req.id, req.full, result))
		}
		s.broadcastLocked(metadata.announcement(roomID))
		return result, nil
	}
	fields := make(map[string]any)
	for _, key := range []string{"title", "summary", "root_message_id"} {
		if _, exists := req.params[key]; !exists {
			continue
		}
		value, err := parseString(req.params, key, false)
		if err != nil {
			return nil, err
		}
		if key == "root_message_id" && !validMessageID(value) {
			return nil, invalidParams("root_message_id must be a positive decimal string")
		}
		fields[key] = value
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := fmt.Sprintf("t_%d", len(s.room.threads)+1)
	metadata := threadMetadata{id: id, fields: fields}
	s.room.threads[id] = metadata
	result := map[string]any{"thread_id": id}
	if req.hasID {
		c.enqueue(response(req.id, req.full, result))
	}
	s.broadcastLocked(metadata.announcement(roomID))
	return result, nil
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

func parseThread(params map[string]json.RawMessage) (string, bool, *rpcError) {
	raw, present := params["thread_id"]
	if !present {
		return "", false, nil
	}
	var threadID string
	if json.Unmarshal(raw, &threadID) != nil || threadID == "" {
		return "", false, invalidParams("thread_id must be a non-empty string")
	}
	return threadID, true, nil
}

func (s *Server) history(req request) (any, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, err
	}
	if roomID != s.room.id {
		return nil, invalidParams("Unknown room %q", roomID)
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
	threadID, hasThread, err := parseThread(req.params)
	if err != nil {
		return nil, err
	}
	if hasThread {
		if _, exists := s.room.threads[threadID]; !exists {
			return nil, invalidParams("Unknown thread %q", threadID)
		}
	}
	// Membership before the transition is stored independently of the requested bounds.
	matching := make([]transition, 0)
	for _, entry := range s.room.entries {
		if (hasAfter && entry.id < after) || (hasBefore && entry.id > before) {
			continue
		}
		if hasThread && entry.previousThread != threadID && entry.message["thread_id"] != threadID {
			continue
		}
		matching = append(matching, entry)
	}
	more := len(matching) > limit
	if more {
		if hasAfter {
			matching = matching[:limit]
		} else {
			matching = matching[len(matching)-limit:]
		}
	}
	entries := make([]map[string]any, 0, len(matching))
	for _, entry := range matching {
		entries = append(entries, entry.historyEntry())
	}
	result := map[string]any{"entries": entries, "more": more}
	if len(matching) > 0 {
		result["first_id"] = matching[0].idString()
		result["last_id"] = matching[len(matching)-1].idString()
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

func (s *Server) typing(c *client, req request) (any, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, err
	}
	if roomID != s.room.id {
		return nil, invalidParams("Unknown room %q", roomID)
	}
	active, err := parseBool(req.params, "active", true)
	if err != nil {
		return nil, err
	}
	var timeout any
	if raw, ok := req.params["timeout"]; ok {
		var value int
		if json.Unmarshal(raw, &value) != nil || value < 0 {
			return nil, invalidParams("timeout must be a non-negative integer")
		}
		timeout = value
	}
	s.mu.Lock()
	params := map[string]any{
		"room_id": roomID,
		"from":    c.identity.object(),
		"active":  active,
	}
	if timeout != nil {
		params["timeout"] = timeout
	}
	result := map[string]any{}
	if req.hasID {
		c.enqueue(response(req.id, req.full, result))
	}
	s.broadcastLocked(map[string]any{"method": "typing", "params": params})
	s.mu.Unlock()
	return result, nil
}

func (s *Server) nextIDLocked() string {
	now := time.Now().UnixMilli()
	if now <= s.room.lastID {
		now = s.room.lastID + 1
	}
	s.room.lastID = now
	return strconv.FormatInt(now, 10)
}

func (s *Server) broadcastLocked(frame any) {
	for c := range s.clients {
		if c.authed {
			c.enqueue(frame)
		}
	}
}

var _ http.Handler = (*Server)(nil)
