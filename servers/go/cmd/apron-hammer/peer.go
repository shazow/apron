package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
)

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("rpc %d: %s", e.Code, e.Message)
}

type reply struct {
	result json.RawMessage
	err    *rpcError
}

// errDisconnected reports a request whose connection closed before its reply.
var errDisconnected = errors.New("connection closed before reply")

// peer is one WebSocket connection to the server. Its read loop routes
// replies to waiting calls by id and hands notifications to notify.
type peer struct {
	h       *hammer
	ws      *websocket.Conn
	next    atomic.Uint64
	mu      sync.Mutex
	pending map[string]chan reply
	done    chan struct{}
	// readErr is why the read loop stopped; set before done closes.
	readErr error
	// connErr is a connection-level error frame (one without id).
	connErr atomic.Pointer[rpcError]
	// closedByUs marks a close the scenario asked for, so it is not counted
	// as a server disconnect.
	closedByUs atomic.Bool
	userID     string
	// notify, when set before the read loop starts, sees every notification
	// on the read goroutine. method is the frame's method.
	notify func(method string, frame []byte)
}

type dialOptions struct {
	// noRead leaves the connection unread, as a stalled client would.
	noRead bool
	// list pipelines room_list {filter: joined, members: true} right behind
	// auth without waiting for its result, as clients do (auth is a
	// barrier), and checks that it lists general with the new guest in it.
	list   bool
	notify func(method string, frame []byte)
}

func (h *hammer) dial(ctx context.Context, options dialOptions) (*peer, error) {
	header := http.Header{}
	if h.origin != "" {
		header.Set("Origin", h.origin)
	}
	ws, _, err := websocket.Dial(ctx, h.wsURL, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(1 << 30)
	h.dials.Add(1)
	p := &peer{h: h, ws: ws, pending: make(map[string]chan reply), done: make(chan struct{}), notify: options.notify}
	if !options.noRead {
		go p.readLoop()
	}
	return p, nil
}

// dialGuest connects and signs in as a new guest.
func (h *hammer) dialGuest(ctx context.Context, name string, options dialOptions) (*peer, error) {
	p, err := h.dial(ctx, options)
	if err != nil {
		return nil, err
	}
	if options.noRead {
		// A stalled client still signs in; it just never reads the reply.
		if err := p.send(ctx, "auth", "auth", map[string]any{"scheme": "guest", "name": name}); err != nil {
			p.close()
			return nil, err
		}
		return p, nil
	}
	auth := map[string]any{"scheme": "guest", "name": name}
	if options.list {
		if err := p.authAndList(ctx, auth); err != nil {
			return nil, err
		}
		return p, nil
	}
	raw, err := p.call(ctx, "auth", auth)
	if err != nil {
		p.close()
		return nil, fmt.Errorf("auth: %w", err)
	}
	var result struct {
		You struct {
			UserID string `json:"user_id"`
		} `json:"you"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		p.close()
		return nil, fmt.Errorf("auth result: %w", err)
	}
	p.userID = result.You.UserID
	return p, nil
}

// authAndList sends auth and room_list back to back, then waits for both.
func (p *peer) authAndList(ctx context.Context, auth map[string]any) error {
	fail := func(err error) error {
		p.close()
		return err
	}
	authCh, err := p.expect("auth")
	if err != nil {
		return fail(err)
	}
	listCh, err := p.expect("list")
	if err != nil {
		return fail(err)
	}
	if err := p.send(ctx, "auth", "auth", auth); err != nil {
		return fail(err)
	}
	if err := p.send(ctx, "list", "room_list", map[string]any{"filter": "joined", "members": true}); err != nil {
		return fail(err)
	}
	raw, err := p.wait(ctx, "auth", authCh)
	if err != nil {
		return fail(fmt.Errorf("auth: %w", err))
	}
	var result struct {
		You struct {
			UserID string `json:"user_id"`
		} `json:"you"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return fail(fmt.Errorf("auth result: %w", err))
	}
	p.userID = result.You.UserID
	raw, err = p.wait(ctx, "list", listCh)
	if err != nil {
		return fail(fmt.Errorf("room_list behind auth: %w", err))
	}
	var listed struct {
		Joined []struct {
			RoomID  string `json:"room_id"`
			Members []struct {
				UserID string `json:"user_id"`
			} `json:"members"`
		} `json:"joined"`
		NotJoined json.RawMessage   `json:"not_joined"`
		Users     []json.RawMessage `json:"users"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		return fail(fmt.Errorf("room_list result: %w", err))
	}
	member := false
	for _, room := range listed.Joined {
		if room.RoomID == generalRoom {
			for _, m := range room.Members {
				member = member || m.UserID == p.userID
			}
		}
	}
	if !member || listed.NotJoined != nil || len(listed.Users) == 0 {
		p.h.protocolViolation("room_list joined with members behind auth did not list %s in %s: %s", p.userID, generalRoom, raw)
	}
	return nil
}

var notificationPrefix = []byte(`{"method":"`)

func (p *peer) readLoop() {
	defer func() {
		p.mu.Lock()
		pending := p.pending
		p.pending = nil
		p.mu.Unlock()
		for _, ch := range pending {
			close(ch)
		}
		if !p.closedByUs.Load() {
			p.h.serverDisconnects.Add(1)
		}
		close(p.done)
	}()
	for {
		_, data, err := p.ws.Read(context.Background())
		if err != nil {
			p.readErr = err
			return
		}
		p.h.framesIn.Add(1)
		p.h.bytesIn.Add(int64(len(data)))
		// The server marshals notifications from maps, so "method" is always
		// the first key; replies are structs that start with jsonrpc or id.
		if rest, ok := bytes.CutPrefix(data, notificationPrefix); ok {
			if end := bytes.IndexByte(rest, '"'); end >= 0 && p.notify != nil {
				p.notify(string(rest[:end]), data)
			}
			continue
		}
		var frame struct {
			ID     *string         `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *rpcError       `json:"error"`
		}
		if err := json.Unmarshal(data, &frame); err != nil {
			p.h.protocolViolation("unparseable frame from server: %v", err)
			continue
		}
		if frame.ID == nil {
			if frame.Error != nil {
				p.connErr.Store(frame.Error)
			}
			continue
		}
		p.mu.Lock()
		ch := p.pending[*frame.ID]
		delete(p.pending, *frame.ID)
		p.mu.Unlock()
		if ch == nil {
			p.h.protocolViolation("reply for unknown id %q", *frame.ID)
			continue
		}
		ch <- reply{result: frame.Result, err: frame.Error}
	}
}

// send writes one request frame without waiting for a reply.
func (p *peer) send(ctx context.Context, id, method string, params any) error {
	frame := map[string]any{"method": method, "params": params}
	if id != "" {
		frame["id"] = id
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return p.sendRaw(ctx, payload)
}

func (p *peer) sendRaw(ctx context.Context, payload []byte) error {
	if err := p.ws.Write(ctx, websocket.MessageText, payload); err != nil {
		return err
	}
	p.h.framesOut.Add(1)
	p.h.bytesOut.Add(int64(len(payload)))
	return nil
}

// call sends a request and waits for its reply.
func (p *peer) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := strconv.FormatUint(p.next.Add(1), 36)
	ch, err := p.expect(id)
	if err != nil {
		return nil, err
	}
	if err := p.send(ctx, id, method, params); err != nil {
		p.forget(id)
		return nil, err
	}
	return p.wait(ctx, id, ch)
}

// callRaw sends a hand-written request frame carrying id and waits for its
// reply.
func (p *peer) callRaw(ctx context.Context, id string, payload []byte) (json.RawMessage, error) {
	ch, err := p.expect(id)
	if err != nil {
		return nil, err
	}
	if err := p.sendRaw(ctx, payload); err != nil {
		p.forget(id)
		return nil, err
	}
	return p.wait(ctx, id, ch)
}

func (p *peer) expect(id string) (chan reply, error) {
	ch := make(chan reply, 1)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pending == nil {
		return nil, errDisconnected
	}
	p.pending[id] = ch
	return ch, nil
}

func (p *peer) forget(id string) {
	p.mu.Lock()
	delete(p.pending, id)
	p.mu.Unlock()
}

func (p *peer) wait(ctx context.Context, id string, ch chan reply) (json.RawMessage, error) {
	select {
	case r, ok := <-ch:
		if !ok {
			return nil, errDisconnected
		}
		if r.err != nil {
			return nil, r.err
		}
		return r.result, nil
	case <-ctx.Done():
		// The entry stays: a reply that arrives later is still expected, and
		// its buffered channel absorbs it.
		return nil, ctx.Err()
	}
}

func (p *peer) alive() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

// close ends the connection abruptly, as a dropped client would.
func (p *peer) close() {
	p.closedByUs.Store(true)
	_ = p.ws.CloseNow()
}

// closeGracefully runs the close handshake.
func (p *peer) closeGracefully() {
	p.closedByUs.Store(true)
	_ = p.ws.Close(websocket.StatusNormalClosure, "done")
}
