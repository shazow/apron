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

func resultMessageID(t *testing.T, frame map[string]any) string {
	t.Helper()
	result, ok := frame["result"].(map[string]any)
	if !ok {
		t.Fatalf("frame has no result: %#v", frame)
	}
	eventID, ok := result["message_id"].(string)
	if !ok {
		t.Fatalf("result has no message_id: %#v", result)
	}
	return eventID
}

func messageFromBroadcast(t *testing.T, frame map[string]any) map[string]any {
	t.Helper()
	params, ok := frame["params"].(map[string]any)
	if !ok || frame["method"] != "message" {
		t.Fatalf("not a message frame: %#v", frame)
	}
	event, ok := params["message"].(map[string]any)
	if !ok {
		t.Fatalf("message frame has no message: %#v", frame)
	}
	return event
}

func save(t *testing.T, c *testClient, requestID string, params map[string]any) (string, map[string]any) {
	t.Helper()
	params["room_id"] = "general"
	c.write(t, map[string]any{"method": "message", "id": requestID, "params": params})
	id := resultMessageID(t, c.read(t))
	frame := c.read(t)
	notification := frame["params"].(map[string]any)
	if frame["method"] != "message" || notification["echo"] != requestID || notification["room_id"] != "general" || frame["id"] != nil {
		t.Fatalf("bad message notification: %#v", frame)
	}
	message := notification["message"].(map[string]any)
	if message["message_id"] != id {
		t.Fatalf("result and snapshot disagree: %#v", notification)
	}
	return id, notification
}

func createThread(t *testing.T, c *testClient, requestID string, metadata map[string]any) string {
	t.Helper()
	metadata["room_id"] = "general"
	c.write(t, map[string]any{"method": "thread", "id": requestID, "params": metadata})
	result := c.read(t)["result"].(map[string]any)
	id := result["thread_id"].(string)
	announcement := c.read(t)
	params := announcement["params"].(map[string]any)
	if announcement["method"] != "thread" || params["thread_id"] != id {
		t.Fatalf("thread announcement: %#v", announcement)
	}
	for key, value := range metadata {
		if params[key] != value {
			t.Fatalf("metadata %s = %#v, want %#v", key, params[key], value)
		}
	}
	return id
}

func historyPage(t *testing.T, c *testClient, params map[string]any) map[string]any {
	t.Helper()
	params["room_id"] = "general"
	c.write(t, map[string]any{"method": "history", "params": params, "id": fmt.Sprintf("h-%d", time.Now().UnixNano())})
	frame := c.read(t)
	result, ok := frame["result"].(map[string]any)
	if !ok {
		t.Fatalf("history failed: %#v", frame)
	}
	return result
}

func TestMessageSnapshotsReplaceEditableState(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	owner := dialTestClient(t, httpServer, "a", true)
	observer := dialTestClient(t, httpServer, "b", false)
	owner.write(t, map[string]any{"method": "nick", "id": "nick", "params": map[string]any{"name": "Alice"}})
	_ = owner.read(t)
	id, creation := save(t, owner, "create", map[string]any{
		"from":   map[string]any{"user_id": "forged"},
		"body":   map[string]any{"text": "hello", "format": "plain", "embeds": []any{map[string]any{"kind": "file"}}},
		"custom": map[string]any{"a": true},
	})
	first := messageFromBroadcast(t, observer.read(t))
	if first["message_id"] != id || creation["log_id"] != id {
		t.Fatalf("creation: %#v", creation)
	}
	from := first["from"].(map[string]any)
	if from["user_id"] == "forged" || from["name"] != "Alice" {
		t.Fatalf("from: %#v", from)
	}
	owner.write(t, map[string]any{"method": "nick", "id": "rename", "params": map[string]any{"name": "Later"}})
	_ = owner.read(t)
	stable, edit := save(t, owner, "edit", map[string]any{"message_id": id, "body": map[string]any{"text": "edited"}, "extension": nil, "from": nil})
	edited := messageFromBroadcast(t, observer.read(t))
	if stable != id || edit["log_id"] == id || edited["custom"] != nil {
		t.Fatalf("replacement: %#v", edit)
	}
	if len(edited["body"].(map[string]any)) != 1 || edited["from"].(map[string]any)["name"] != "Alice" {
		t.Fatalf("replacement merged editable fields or changed author: %#v", edited)
	}
	if value, exists := edited["extension"]; !exists || value != nil {
		t.Fatalf("literal null lost: %#v", edited)
	}
	_, deleted := save(t, owner, "delete", map[string]any{"message_id": id, "deleted": true, "body": "discard even invalid body"})
	_ = observer.read(t)
	tombstone := deleted["message"].(map[string]any)
	if _, exists := tombstone["body"]; exists || tombstone["deleted"] != true {
		t.Fatalf("tombstone: %#v", tombstone)
	}
	page := historyPage(t, owner, map[string]any{"after": "0"})
	entries := page["entries"].([]any)
	if len(entries) != 3 {
		t.Fatalf("history: %#v", page)
	}
	for i, expected := range []map[string]any{creation, edit, deleted} {
		entry := entries[i].(map[string]any)
		if len(entry) != 2 || entry["log_id"] != expected["log_id"] {
			t.Fatalf("history shape: %#v", entry)
		}
	}
	// Earlier log snapshots remain unchanged after replacements.
	original := entries[0].(map[string]any)["message"].(map[string]any)
	if original["body"].(map[string]any)["text"] != "hello" {
		t.Fatalf("historical snapshot changed: %#v", original)
	}
	observer.write(t, map[string]any{"method": "message", "id": "forged", "params": map[string]any{"room_id": "general", "message_id": id, "body": map[string]any{"text": "forged"}}})
	if observer.read(t)["error"].(map[string]any)["code"] != float64(codeDenied) {
		t.Fatal("non-author save accepted")
	}
}

func TestThreadCreationAndFilteredHistory(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	body := map[string]any{"text": "root"}
	id, _ := save(t, c, "create", map[string]any{"body": body})
	thread := createThread(t, c, "thread", map[string]any{"title": "Deploy", "summary": "", "root_message_id": id})
	other := createThread(t, c, "other", map[string]any{})
	empty := historyPage(t, c, map[string]any{"thread_id": thread})
	if len(empty["entries"].([]any)) != 0 || empty["more"] != false || empty["first_id"] != nil {
		t.Fatalf("creation moved root: %#v", empty)
	}
	_, moveIn := save(t, c, "in", map[string]any{"message_id": id, "body": body, "thread_id": thread})
	_, _ = save(t, c, "unrelated", map[string]any{"body": body})
	_, moveOut := save(t, c, "out", map[string]any{"message_id": id, "body": body, "thread_id": other})
	_, deletion := save(t, c, "delete", map[string]any{"message_id": id, "deleted": true})
	page := historyPage(t, c, map[string]any{"thread_id": thread, "after": "0", "limit": 1})
	if page["first_id"] != moveIn["log_id"] || page["last_id"] != moveIn["log_id"] || page["more"] != true {
		t.Fatalf("filtered first page: %#v", page)
	}
	// Even with the prior membership outside the bounds, departures must match.
	page = historyPage(t, c, map[string]any{"thread_id": thread, "after": moveOut["log_id"], "before": moveOut["log_id"], "limit": 1})
	if page["first_id"] != moveOut["log_id"] || page["more"] != false || len(page["entries"].([]any)) != 1 {
		t.Fatalf("departure page: %#v", page)
	}
	page = historyPage(t, c, map[string]any{"thread_id": thread, "limit": 1})
	if page["first_id"] != moveOut["log_id"] || page["more"] != true {
		t.Fatalf("backward page: %#v", page)
	}
	page = historyPage(t, c, map[string]any{"thread_id": other, "after": deletion["log_id"]})
	if page["last_id"] != deletion["log_id"] {
		t.Fatalf("deletion departure missing: %#v", page)
	}
	// Empty threads retain their metadata and can receive future messages.
	_, _ = save(t, c, "reply", map[string]any{"body": body, "thread_id": thread})
	reconnected := dialTestClient(t, httpServer, "again", false)
	seen := map[string]bool{}
	for range 2 {
		frame := reconnected.read(t)
		params := frame["params"].(map[string]any)
		seen[params["thread_id"].(string)] = true
	}
	if !seen[thread] || !seen[other] {
		t.Fatalf("missing reannouncements: %#v", seen)
	}
	page = historyPage(t, c, map[string]any{"after": "0"})
	if len(page["entries"].([]any)) != 6 {
		t.Fatalf("unfiltered room history omits threads: %#v", page)
	}
}

func TestInvalidSavesAndThreadRequestsLeaveStateUnchanged(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	id, _ := save(t, c, "create", map[string]any{"body": map[string]any{"text": "hello"}})
	cases := []struct {
		method string
		params map[string]any
	}{
		{"message", map[string]any{"body": map[string]any{}, "deleted": true}},
		{"message", map[string]any{"message_id": "999", "body": map[string]any{}}},
		{"message", map[string]any{"message_id": nil, "body": map[string]any{}}},
		{"message", map[string]any{"message_id": id}},
		{"message", map[string]any{"message_id": id, "body": nil}},
		{"message", map[string]any{"message_id": id, "body": map[string]any{"text": nil}}},
		{"message", map[string]any{"message_id": id, "body": map[string]any{"format": nil}}},
		{"message", map[string]any{"message_id": id, "body": map[string]any{"embeds": nil}}},
		{"message", map[string]any{"message_id": id, "body": map[string]any{}, "thread_id": nil}},
		{"message", map[string]any{"message_id": id, "body": map[string]any{}, "thread_id": "missing"}},
		{"message", map[string]any{"body": map[string]any{}, "deleted": nil}},
		{"message", map[string]any{"body": map[string]any{}, "log_id": "123"}},
		{"thread", map[string]any{"thread_id": "chosen"}},
		{"thread", map[string]any{"title": nil}},
		{"thread", map[string]any{"summary": 12}},
		{"thread", map[string]any{"root_message_id": "bad"}},
		{"history", map[string]any{"thread_id": "missing"}},
	}
	for i, tc := range cases {
		tc.params["room_id"] = "general"
		c.write(t, map[string]any{"method": tc.method, "id": fmt.Sprint("bad-", i), "params": tc.params})
		frame := c.read(t)
		failure, ok := frame["error"].(map[string]any)
		if !ok || failure["code"] != float64(codeInvalidParams) {
			t.Fatalf("case %d: %#v", i, frame)
		}
	}
	page := historyPage(t, c, map[string]any{})
	if len(page["entries"].([]any)) != 1 {
		t.Fatalf("invalid operations appended history: %#v", page)
	}
	reconnected := dialTestClient(t, httpServer, "again", false)
	// A phantom metadata announcement would precede this reply.
	_ = historyPage(t, reconnected, map[string]any{})
}

func TestThreadAnnouncementsUseOneQueueBatch(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	owner := dialTestClient(t, httpServer, "owner", false)
	const count = 129
	for i := range count {
		createThread(t, owner, fmt.Sprint("thread-", i), map[string]any{})
	}
	reconnected := dialTestClient(t, httpServer, "again", false)
	seen := make(map[string]bool)
	for range count {
		frame := reconnected.read(t)
		if frame["method"] != "thread" {
			t.Fatalf("announcement: %#v", frame)
		}
		seen[frame["params"].(map[string]any)["thread_id"].(string)] = true
	}
	if len(seen) != count {
		t.Fatalf("received %d threads", len(seen))
	}
}

func TestHistoryBoundsAndDeduplication(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)

	ids := make([]string, 0, 3)
	for i := 0; i < 3; i++ {
		c.write(t, map[string]any{
			"method": "message", "id": fmt.Sprintf("m%d", i),
			"params": map[string]any{"room_id": "general", "body": map[string]any{"text": strconv.Itoa(i)}},
		})
		result := c.read(t)
		ids = append(ids, resultMessageID(t, result))
		_ = messageFromBroadcast(t, c.read(t))
	}

	// Retrying the first operation returns the same result and does not append a second log entry.
	c.write(t, map[string]any{
		"method": "message", "id": "m0",
		"params": map[string]any{"room_id": "general", "body": map[string]any{"text": "0"}},
	})
	if got := resultMessageID(t, c.read(t)); got != ids[0] {
		t.Fatalf("deduplicated result = %q, want %q", got, ids[0])
	}

	c.write(t, map[string]any{
		"method": "history", "id": "h1",
		"params": map[string]any{"room_id": "general", "after": "0", "limit": 2},
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
		"params": map[string]any{"room_id": "general", "after": ids[1], "limit": 2},
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
	c.write(t, map[string]any{"method": "message", "params": []any{}})
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

func TestThreadAndReplacementDeduplication(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	thread := createThread(t, c, "thread", map[string]any{"title": "Deploy"})
	c.write(t, map[string]any{"jsonrpc": "2.0", "method": "thread", "id": "thread", "params": map[string]any{"room_id": "general", "title": "Deploy"}})
	if c.read(t)["result"].(map[string]any)["thread_id"] != thread {
		t.Fatal("thread retry minted another ID")
	}
	id, _ := save(t, c, "create", map[string]any{"body": map[string]any{"text": "initial"}})
	params := map[string]any{"room_id": "general", "message_id": id, "body": map[string]any{"text": "edited"}, "thread_id": thread}
	_, edit := save(t, c, "edit", params)
	c.write(t, map[string]any{"method": "message", "id": "edit", "params": params})
	if resultMessageID(t, c.read(t)) != id {
		t.Fatal("replacement retry changed message ID")
	}
	params["body"] = map[string]any{"text": "conflicting retry"}
	c.write(t, map[string]any{"method": "message", "id": "edit", "params": params})
	frame := c.read(t)
	if frame["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
		t.Fatalf("conflicting retry: %#v", frame)
	}
	page := historyPage(t, c, map[string]any{"after": "0"})
	if len(page["entries"].([]any)) != 2 || page["last_id"] != edit["log_id"] {
		t.Fatalf("retry appended log entries: %#v", page)
	}
}

func TestTypingUsesInlineIdentity(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	c.write(t, map[string]any{"method": "typing", "params": map[string]any{"room_id": "general", "active": true, "from": map[string]any{"user_id": "forged"}}})
	frame := c.read(t)
	params := frame["params"].(map[string]any)
	if frame["method"] != "typing" || frame["id"] != nil || params["room_id"] != "general" || params["from"].(map[string]any)["user_id"] != "guest_1" {
		t.Fatalf("typing: %#v", frame)
	}
}
