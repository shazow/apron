package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type testClient struct {
	ws *websocket.Conn
}

func newTestServer(t *testing.T, config Config) (*Server, *httptest.Server) {
	t.Helper()
	app := New(config)
	httpServer := httptest.NewServer(app.Handler())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		if err := app.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
		cancel()
		httpServer.Close()
	})
	return app, httpServer
}

func TestShutdownClosesConnections(t *testing.T) {
	app, httpServer := newTestServer(t, DefaultConfig())
	closed := dialTestClient(t, httpServer, "closed", false)
	_ = closed.ws.Close(websocket.StatusNormalClosure, "finished")
	active := dialTestClient(t, httpServer, "active", false)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := app.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown with accepted connections: %v", err)
	}
	if _, _, err := active.ws.Read(ctx); err == nil {
		t.Fatal("active connection remained open after shutdown")
	}
	if err := app.Shutdown(ctx); err != nil {
		t.Fatalf("repeated shutdown: %v", err)
	}
	_, response, err := websocket.Dial(ctx, "ws"+httpServer.URL[len("http"):]+"/ws", nil)
	if err == nil || response == nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("connection after shutdown: response=%v, error=%v", response, err)
	}
}

func dialTestClient(t *testing.T, httpServer *httptest.Server, id string, full bool) *testClient {
	t.Helper()
	wsURL := "ws" + httpServer.URL[len("http"):] + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	cancel()
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := &testClient{ws: ws}
	t.Cleanup(func() { _ = ws.Close(websocket.StatusNormalClosure, "test finished") })
	serverFrame := c.read(t)
	if serverFrame["method"] != "server" {
		t.Fatalf("first frame = %#v, want server announcement", serverFrame)
	}
	auth := map[string]any{
		"method": "auth",
		"id":     id,
		"params": map[string]any{"scheme": "anonymous"},
	}
	if full {
		auth["jsonrpc"] = "2.0"
	}
	c.write(t, auth)
	result := c.read(t)
	if result["id"] != id {
		t.Fatalf("auth result = %#v, want id %q", result, id)
	}
	if full && result["jsonrpc"] != "2.0" {
		t.Fatalf("full auth result = %#v, want jsonrpc 2.0", result)
	}
	room := c.read(t)
	if room["method"] != "room" {
		t.Fatalf("auth follow-up = %#v, want room", room)
	}
	return c
}

func (c *testClient) write(t *testing.T, value any) {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

func (c *testClient) read(t *testing.T) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, payload, err := c.ws.Read(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var frame map[string]any
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("decode frame %q: %v", payload, err)
	}
	return frame
}

func resultEventID(t *testing.T, frame map[string]any) string {
	t.Helper()
	result, ok := frame["result"].(map[string]any)
	if !ok {
		t.Fatalf("frame has no result: %#v", frame)
	}
	eventID, ok := result["event_id"].(string)
	if !ok {
		t.Fatalf("result has no event_id: %#v", result)
	}
	return eventID
}

func eventFromBroadcast(t *testing.T, frame map[string]any) map[string]any {
	t.Helper()
	params, ok := frame["params"].(map[string]any)
	if !ok || frame["method"] != "event" {
		t.Fatalf("not an event frame: %#v", frame)
	}
	event, ok := params["event"].(map[string]any)
	if !ok {
		t.Fatalf("event frame has no event: %#v", frame)
	}
	return event
}

func updateFromBroadcast(t *testing.T, frame map[string]any) map[string]any {
	t.Helper()
	params, ok := frame["params"].(map[string]any)
	if !ok || frame["method"] != "update" {
		t.Fatalf("not an update frame: %#v", frame)
	}
	return params
}

func TestAnonymousSendHistoryAndOwnEdit(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	first := dialTestClient(t, httpServer, "a", true)
	second := dialTestClient(t, httpServer, "b", false)

	first.write(t, map[string]any{
		"jsonrpc": "2.0",
		"method":  "send",
		"id":      "m1",
		"params": map[string]any{
			"room": "general",
			"body": map[string]any{
				"text":   "hello",
				"format": "plain",
				"embeds": []any{map[string]any{"kind": "custom", "url": "https://example.test/view"}},
			},
		},
	})
	sendResult := first.read(t)
	if sendResult["jsonrpc"] != "2.0" || sendResult["id"] != "m1" {
		t.Fatalf("send result = %#v", sendResult)
	}
	messageID := resultEventID(t, sendResult)
	firstEvent := eventFromBroadcast(t, first.read(t))
	secondEvent := eventFromBroadcast(t, second.read(t))
	if firstEvent["event_id"] != messageID || secondEvent["event_id"] != messageID {
		t.Fatalf("broadcast IDs = %#v and %#v, want %q", firstEvent["event_id"], secondEvent["event_id"], messageID)
	}
	if firstEvent["sender"].(map[string]any)["id"] != "guest_1" {
		t.Fatalf("sender = %#v", firstEvent["sender"])
	}

	second.write(t, map[string]any{
		"method": "history",
		"id":     "h1",
		"params": map[string]any{"room": "general", "after": "0", "limit": 10},
	})
	history := second.read(t)
	entries := history["result"].(map[string]any)["entries"].([]any)
	if len(entries) != 1 || entries[0].(map[string]any)["event_id"] != messageID {
		t.Fatalf("history entries = %#v", entries)
	}

	first.write(t, map[string]any{
		"method": "update_request",
		"id":     "u1",
		"params": map[string]any{
			"room":   "general",
			"target": messageID,
			"set":    map[string]any{"body": map[string]any{"text": "edited", "embeds": nil}},
		},
	})
	updateResult := first.read(t)
	updateID := resultEventID(t, updateResult)
	firstUpdate := updateFromBroadcast(t, first.read(t))
	secondUpdate := updateFromBroadcast(t, second.read(t))
	for _, update := range []map[string]any{firstUpdate, secondUpdate} {
		if update["event_id"] != updateID || update["target"] != messageID {
			t.Fatalf("update = %#v", update)
		}
		set := update["set"].(map[string]any)
		if set["body"].(map[string]any)["text"] != "edited" {
			t.Fatalf("update set = %#v", set)
		}
	}

	second.write(t, map[string]any{
		"method": "history",
		"id":     "h2",
		"params": map[string]any{"room": "general", "after": messageID, "limit": 10},
	})
	updatedHistory := second.read(t)["result"].(map[string]any)
	updatedEntries := updatedHistory["entries"].([]any)
	if len(updatedEntries) != 2 {
		t.Fatalf("history after edit = %#v", updatedHistory)
	}
	lastTransition := updatedEntries[1].(map[string]any)
	if lastTransition["event_id"] != updateID || lastTransition["target"] != messageID {
		t.Fatalf("history update transition = %#v", lastTransition)
	}

	second.write(t, map[string]any{
		"method": "update_request",
		"id":     "u2",
		"params": map[string]any{
			"room": "general", "target": messageID, "set": map[string]any{"body": map[string]any{"text": "forged"}},
		},
	})
	denied := second.read(t)
	if denied["error"].(map[string]any)["code"] != float64(codeDenied) {
		t.Fatalf("unauthorized update = %#v", denied)
	}

	first.write(t, map[string]any{
		"method": "update_request",
		"id":     "u3",
		"params": map[string]any{
			"room": "general", "target": messageID, "set": map[string]any{"body": "invalid"},
		},
	})
	invalid := first.read(t)
	if invalid["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
		t.Fatalf("invalid update body = %#v", invalid)
	}
}

func TestThreadsCreationReplyHistoryAndReauthentication(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	owner := dialTestClient(t, httpServer, "owner", false)
	observer := dialTestClient(t, httpServer, "observer", false)

	owner.write(t, map[string]any{
		"method": "send", "id": "root",
		"params": map[string]any{"room": "general", "body": map[string]any{"text": "root"}},
	})
	rootID := resultEventID(t, owner.read(t))
	rootEvent := eventFromBroadcast(t, owner.read(t))
	if rootEvent["event_id"] != rootID {
		t.Fatalf("root event = %#v, want %q", rootEvent, rootID)
	}
	if eventFromBroadcast(t, observer.read(t))["event_id"] != rootID {
		t.Fatalf("observer did not receive root event")
	}

	owner.write(t, map[string]any{
		"method": "update_request", "id": "thread-create",
		"params": map[string]any{
			"room": "general", "target": rootID,
			"set": map[string]any{"thread": "t_release"},
		},
	})
	threadUpdateID := resultEventID(t, owner.read(t))
	ownerUpdate := updateFromBroadcast(t, owner.read(t))
	ownerThread := owner.read(t)
	if ownerUpdate["event_id"] != threadUpdateID || ownerUpdate["target"] != rootID {
		t.Fatalf("thread creation update = %#v", ownerUpdate)
	}
	if ownerUpdate["set"].(map[string]any)["thread"] != "t_release" {
		t.Fatalf("thread creation set = %#v", ownerUpdate["set"])
	}
	if ownerThread["method"] != "thread" {
		t.Fatalf("thread creation announcement = %#v", ownerThread)
	}
	threadParams := ownerThread["params"].(map[string]any)
	if threadParams["room"] != "general" || threadParams["thread"] != "t_release" || threadParams["name"] != "t_release" || threadParams["root"] != rootID {
		t.Fatalf("thread metadata = %#v", threadParams)
	}
	observerUpdate := updateFromBroadcast(t, observer.read(t))
	if observerUpdate["event_id"] != threadUpdateID {
		t.Fatalf("observer thread update = %#v", observerUpdate)
	}
	observerThread := observer.read(t)
	if observerThread["method"] != "thread" {
		t.Fatalf("observer thread announcement = %#v", observerThread)
	}

	owner.write(t, map[string]any{
		"method": "send", "id": "reply",
		"params": map[string]any{
			"room": "general", "thread": "t_release",
			"body": map[string]any{"text": "reply"},
		},
	})
	replyID := resultEventID(t, owner.read(t))
	replyEvent := eventFromBroadcast(t, owner.read(t))
	if replyEvent["event_id"] != replyID || replyEvent["thread"] != "t_release" {
		t.Fatalf("thread reply = %#v", replyEvent)
	}
	if eventFromBroadcast(t, observer.read(t))["event_id"] != replyID {
		t.Fatalf("observer did not receive thread reply")
	}

	owner.write(t, map[string]any{
		"method": "history", "id": "history",
		"params": map[string]any{"room": "general", "after": "0", "limit": 10},
	})
	history := owner.read(t)["result"].(map[string]any)
	entries := history["entries"].([]any)
	if len(entries) != 3 {
		t.Fatalf("thread history entries = %#v", entries)
	}
	if entries[1].(map[string]any)["event_id"] != threadUpdateID || entries[2].(map[string]any)["event_id"] != replyID {
		t.Fatalf("thread history ordering = %#v", entries)
	}
	if entries[2].(map[string]any)["thread"] != "t_release" {
		t.Fatalf("thread reply missing from raw history = %#v", entries[2])
	}

	reconnected := dialTestClient(t, httpServer, "reconnected", false)
	reconnectedThread := reconnected.read(t)
	if reconnectedThread["method"] != "thread" {
		t.Fatalf("reauthentication metadata = %#v", reconnectedThread)
	}
	reconnectedParams := reconnectedThread["params"].(map[string]any)
	if reconnectedParams["thread"] != "t_release" || reconnectedParams["name"] != "t_release" || reconnectedParams["root"] != rootID {
		t.Fatalf("reauthentication thread metadata = %#v", reconnectedParams)
	}
}

func TestThreadsMoveRemoveAndAuthorize(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	owner := dialTestClient(t, httpServer, "owner", false)
	other := dialTestClient(t, httpServer, "other", false)

	sendRoot := func(requestID, text string) string {
		t.Helper()
		owner.write(t, map[string]any{
			"method": "send", "id": requestID,
			"params": map[string]any{"room": "general", "body": map[string]any{"text": text}},
		})
		id := resultEventID(t, owner.read(t))
		_ = eventFromBroadcast(t, owner.read(t))
		_ = eventFromBroadcast(t, other.read(t))
		return id
	}
	setThread := func(requestID, target, threadID string) {
		t.Helper()
		owner.write(t, map[string]any{
			"method": "update_request", "id": requestID,
			"params": map[string]any{
				"room": "general", "target": target,
				"set": map[string]any{"thread": threadID},
			},
		})
		_ = resultEventID(t, owner.read(t))
		_ = updateFromBroadcast(t, owner.read(t))
		_ = owner.read(t) // thread announcement
		_ = updateFromBroadcast(t, other.read(t))
		_ = other.read(t) // thread announcement
	}

	firstRoot := sendRoot("root-1", "first")
	setThread("thread-1", firstRoot, "t_first")
	secondRoot := sendRoot("root-2", "second")
	setThread("thread-2", secondRoot, "t_second")

	other.write(t, map[string]any{
		"method": "update_request", "id": "forged-thread",
		"params": map[string]any{
			"room": "general", "target": firstRoot,
			"set": map[string]any{"thread": "t_second"},
		},
	})
	denied := other.read(t)
	if denied["error"].(map[string]any)["code"] != float64(codeDenied) {
		t.Fatalf("unauthorized thread update = %#v", denied)
	}

	owner.write(t, map[string]any{
		"method": "update_request", "id": "move-thread",
		"params": map[string]any{
			"room": "general", "target": firstRoot,
			"set": map[string]any{"thread": "t_second"},
		},
	})
	moveID := resultEventID(t, owner.read(t))
	move := updateFromBroadcast(t, owner.read(t))
	if move["event_id"] != moveID || move["set"].(map[string]any)["thread"] != "t_second" {
		t.Fatalf("thread move = %#v", move)
	}
	if updateFromBroadcast(t, other.read(t))["event_id"] != moveID {
		t.Fatalf("other did not receive thread move")
	}

	owner.write(t, map[string]any{
		"method": "update_request", "id": "remove-thread",
		"params": map[string]any{
			"room": "general", "target": firstRoot,
			"set": map[string]any{"thread": nil},
		},
	})
	removeID := resultEventID(t, owner.read(t))
	remove := updateFromBroadcast(t, owner.read(t))
	if remove["event_id"] != removeID {
		t.Fatalf("thread removal = %#v", remove)
	}
	if value, exists := remove["set"].(map[string]any)["thread"]; !exists || value != nil {
		t.Fatalf("thread removal set = %#v", remove["set"])
	}
	if updateFromBroadcast(t, other.read(t))["event_id"] != removeID {
		t.Fatalf("other did not receive thread removal")
	}

	// Empty thread metadata is retained, so a later reply can still use it.
	owner.write(t, map[string]any{
		"method": "send", "id": "empty-thread-reply",
		"params": map[string]any{
			"room": "general", "thread": "t_first",
			"body": map[string]any{"text": "reply in retained thread"},
		},
	})
	retainedReplyID := resultEventID(t, owner.read(t))
	retainedReply := eventFromBroadcast(t, owner.read(t))
	if retainedReply["event_id"] != retainedReplyID || retainedReply["thread"] != "t_first" {
		t.Fatalf("reply in retained thread = %#v", retainedReply)
	}
	_ = eventFromBroadcast(t, other.read(t))

	owner.write(t, map[string]any{
		"method": "send", "id": "unknown-thread",
		"params": map[string]any{
			"room": "general", "thread": "t_missing",
			"body": map[string]any{"text": "should fail"},
		},
	})
	unknown := owner.read(t)
	if unknown["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
		t.Fatalf("unknown thread send = %#v", unknown)
	}

	owner.write(t, map[string]any{
		"method": "update_request", "id": "empty-thread-id",
		"params": map[string]any{
			"room": "general", "target": firstRoot,
			"set": map[string]any{"thread": ""},
		},
	})
	emptyID := owner.read(t)
	if emptyID["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
		t.Fatalf("empty thread ID update = %#v", emptyID)
	}

	owner.write(t, map[string]any{
		"method": "history", "id": "move-history",
		"params": map[string]any{"room": "general", "after": "0", "limit": 20},
	})
	history := owner.read(t)["result"].(map[string]any)
	entries := history["entries"].([]any)
	if len(entries) != 7 {
		t.Fatalf("failed thread operations changed history = %#v", entries)
	}

	reconnected := dialTestClient(t, httpServer, "reconnected", false)
	threads := map[string]bool{}
	for i := 0; i < 2; i++ {
		announcement := reconnected.read(t)
		if announcement["method"] != "thread" {
			t.Fatalf("retained thread announcement = %#v", announcement)
		}
		params := announcement["params"].(map[string]any)
		threads[params["thread"].(string)] = true
	}
	if !threads["t_first"] || !threads["t_second"] {
		t.Fatalf("reauthenticated thread metadata = %#v", threads)
	}
}

func TestInvalidThreadsLeaveNoMetadataOrHistory(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	owner := dialTestClient(t, httpServer, "owner", false)
	owner.write(t, map[string]any{
		"method": "send", "id": "root",
		"params": map[string]any{"room": "general", "body": map[string]any{"text": "root"}},
	})
	rootID := resultEventID(t, owner.read(t))
	_ = eventFromBroadcast(t, owner.read(t))

	for i, thread := range []any{nil, 42, true, ""} {
		owner.write(t, map[string]any{
			"method": "send", "id": fmt.Sprintf("bad-send-%d", i),
			"params": map[string]any{"room": "general", "thread": thread, "body": map[string]any{"text": "invalid"}},
		})
		if frame := owner.read(t); frame["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
			t.Fatalf("invalid thread send = %#v", frame)
		}
	}
	for i, patch := range []map[string]any{
		{"thread": 42},
		{"thread": "t_failed", "body": "invalid"},
	} {
		owner.write(t, map[string]any{
			"method": "update_request", "id": fmt.Sprintf("bad-update-%d", i),
			"params": map[string]any{"room": "general", "target": rootID, "set": patch},
		})
		if frame := owner.read(t); frame["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
			t.Fatalf("invalid thread update = %#v", frame)
		}
	}

	reader := dialTestClient(t, httpServer, "reader", false)
	reader.write(t, map[string]any{
		"method": "history", "id": "history",
		"params": map[string]any{"room": "general", "after": "0"},
	})
	frame := reader.read(t)
	// Any phantom thread announcement would precede this response.
	if frame["id"] != "history" {
		t.Fatalf("failed update leaked thread metadata: %#v", frame)
	}
	entries := frame["result"].(map[string]any)["entries"].([]any)
	if len(entries) != 1 || entries[0].(map[string]any)["thread"] != nil {
		t.Fatalf("failed operations changed history: %#v", entries)
	}
}

func TestThreadAnnouncementsUseOneQueueBatch(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	owner := dialTestClient(t, httpServer, "owner", false)
	const threadCount = 129
	for i := 0; i < threadCount; i++ {
		requestID := fmt.Sprintf("root-%d", i)
		owner.write(t, map[string]any{
			"method": "send", "id": requestID,
			"params": map[string]any{"room": "general", "body": map[string]any{"text": requestID}},
		})
		rootID := resultEventID(t, owner.read(t))
		_ = eventFromBroadcast(t, owner.read(t))
		owner.write(t, map[string]any{
			"method": "update_request", "id": fmt.Sprintf("thread-%d", i),
			"params": map[string]any{
				"room": "general", "target": rootID,
				"set": map[string]any{"thread": fmt.Sprintf("t_%d", i)},
			},
		})
		_ = resultEventID(t, owner.read(t))
		_ = updateFromBroadcast(t, owner.read(t))
		_ = owner.read(t)
	}

	reconnected := dialTestClient(t, httpServer, "reconnected", false)
	seen := make(map[string]bool, threadCount)
	for i := 0; i < threadCount; i++ {
		announcement := reconnected.read(t)
		if announcement["method"] != "thread" {
			t.Fatalf("batched thread announcement %d = %#v", i, announcement)
		}
		params := announcement["params"].(map[string]any)
		seen[params["thread"].(string)] = true
	}
	if len(seen) != threadCount {
		t.Fatalf("received %d distinct thread announcements, want %d", len(seen), threadCount)
	}
}

func TestHistoryBoundsAndDeduplication(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)

	ids := make([]string, 0, 3)
	for i := 0; i < 3; i++ {
		c.write(t, map[string]any{
			"method": "send", "id": fmt.Sprintf("m%d", i),
			"params": map[string]any{"room": "general", "body": map[string]any{"text": strconv.Itoa(i)}},
		})
		result := c.read(t)
		ids = append(ids, resultEventID(t, result))
		_ = eventFromBroadcast(t, c.read(t))
	}

	// Retrying the first operation returns the same result and does not append a second log entry.
	c.write(t, map[string]any{
		"method": "send", "id": "m0",
		"params": map[string]any{"room": "general", "body": map[string]any{"text": "0"}},
	})
	if got := resultEventID(t, c.read(t)); got != ids[0] {
		t.Fatalf("deduplicated result = %q, want %q", got, ids[0])
	}

	c.write(t, map[string]any{
		"method": "history", "id": "h1",
		"params": map[string]any{"room": "general", "after": "0", "limit": 2},
	})
	page := c.read(t)["result"].(map[string]any)
	if page["first_id"] != ids[0] || page["last_id"] != ids[1] || page["more"] != true {
		t.Fatalf("forward page = %#v", page)
	}
	pageEntries := page["entries"].([]any)
	if len(pageEntries) != 2 {
		t.Fatalf("forward entries = %#v", pageEntries)
	}

	c.write(t, map[string]any{
		"method": "history", "id": "h2",
		"params": map[string]any{"room": "general", "after": ids[1], "limit": 2},
	})
	page = c.read(t)["result"].(map[string]any)
	if page["first_id"] != ids[1] || page["last_id"] != ids[2] || page["more"] != false {
		t.Fatalf("inclusive continuation page = %#v", page)
	}
	pageEntries = page["entries"].([]any)
	if len(pageEntries) != 2 {
		t.Fatalf("inclusive continuation entries = %#v", pageEntries)
	}
}

func TestNotificationsDoNotReceiveRepliesAndHealth(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	c.write(t, map[string]any{"method": "unknown_notification"})
	c.write(t, map[string]any{"method": "send", "params": []any{}})
	c.write(t, map[string]any{"method": "nick", "params": map[string]any{"name": nil}})
	c.write(t, map[string]any{"method": "auth"})
	c.write(t, map[string]any{"method": "nick", "id": "n1", "params": map[string]any{"name": "A"}})
	response := c.read(t)
	if response["id"] != "n1" {
		t.Fatalf("notification produced a response before nick: %#v", response)
	}

	responseHTTP, err := http.Get(httpServer.URL + "/healthz")
	if err != nil {
		t.Fatalf("health request: %v", err)
	}
	defer responseHTTP.Body.Close()
	if responseHTTP.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", responseHTTP.StatusCode)
	}
}

func TestMergePatchRemovesOptionalBodyFields(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "auth", false)
	c.write(t, map[string]any{"method": "send", "id": "send", "params": map[string]any{
		"room": "general", "body": map[string]any{
			"text": "hello", "format": "plain", "embeds": []any{map[string]any{"kind": "file", "url": "https://example.com/a"}},
		},
	}})
	target := resultEventID(t, c.read(t))
	original := eventFromBroadcast(t, c.read(t))
	c.write(t, map[string]any{"method": "update_request", "id": "edit", "params": map[string]any{
		"room": "general", "target": target, "set": map[string]any{"body": map[string]any{"embeds": nil, "format": nil}},
	}})
	resultEventID(t, c.read(t))
	update := updateFromBroadcast(t, c.read(t))
	state := applyMergePatch(original, update["set"].(map[string]any))
	body := state["body"].(map[string]any)
	if body["text"] != "hello" || len(body) != 1 {
		t.Fatalf("merge patch did not preserve text and remove optional fields: %#v", body)
	}
	c.write(t, map[string]any{"method": "update_request", "id": "delete", "params": map[string]any{
		"room": "general", "target": target, "set": map[string]any{"deleted": true, "body": map[string]any{"text": "discard me"}},
	}})
	resultEventID(t, c.read(t))
	deleted := updateFromBroadcast(t, c.read(t))
	state = applyMergePatch(state, deleted["set"].(map[string]any))
	if _, exists := state["body"]; exists || state["deleted"] != true {
		t.Fatalf("delete retained body: %#v", state)
	}
}

func TestStaticDirectoryAndOrigins(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	config := DefaultConfig()
	config.StaticDir = staticDir
	app := New(config)
	httpServer := httptest.NewServer(app.Handler())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = app.Shutdown(ctx)
		cancel()
		httpServer.Close()
	})
	response, err := http.Get(httpServer.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("static status = %d", response.StatusCode)
	}

	// The HTTP request host is authorized by coder/websocket; a configured origin
	// outside the allowlist is rejected during the WebSocket handshake.
	wsURL := "ws" + httpServer.URL[len("http"):]
	badOrigin := "https://untrusted.example"
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	_, _, err = websocket.Dial(ctx, wsURL+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{badOrigin}}})
	cancel()
	if err == nil {
		t.Fatal("untrusted origin unexpectedly connected")
	}
}
