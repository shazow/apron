package server

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type testClient struct {
	ws               *websocket.Conn
	passkeyChallenge string
	fences           int
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

func dialRaw(t *testing.T, httpServer *httptest.Server) (*testClient, map[string]any) {
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
	return c, serverFrame
}

func dialTestClient(t *testing.T, httpServer *httptest.Server, id string, full bool) *testClient {
	t.Helper()
	c, _ := dialTestClientWithRooms(t, httpServer, id, full)
	return c
}

// dialTestClientWithRooms authenticates as a guest and returns every room
// announcement that followed the auth result, in order.
func dialTestClientWithRooms(t *testing.T, httpServer *httptest.Server, id string, full bool) (*testClient, []map[string]any) {
	t.Helper()
	c, _ := dialRaw(t, httpServer)
	auth := map[string]any{
		"method": "auth",
		"id":     id,
		"params": map[string]any{"scheme": "guest"},
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
	rooms := c.drain(t)
	for _, frame := range rooms {
		if frame["method"] != "room" {
			t.Fatalf("auth follow-up = %#v, want room", frame)
		}
	}
	if len(rooms) == 0 {
		t.Fatal("no room announced after auth")
	}
	return c, paramsOf(rooms)
}

func paramsOf(frames []map[string]any) []map[string]any {
	params := make([]map[string]any, len(frames))
	for i, frame := range frames {
		params[i] = frame["params"].(map[string]any)
	}
	return params
}

// drain returns every frame queued before a fence request's reply.
func (c *testClient) drain(t *testing.T) []map[string]any {
	t.Helper()
	c.fences++
	id := fmt.Sprintf("fence-%d", c.fences)
	c.write(t, map[string]any{"method": "fence", "id": id})
	frames := make([]map[string]any, 0)
	for {
		frame := c.read(t)
		if frame["id"] == id {
			return frames
		}
		frames = append(frames, frame)
	}
}

func (c *testClient) expectQuiet(t *testing.T) {
	t.Helper()
	if frames := c.drain(t); len(frames) != 0 {
		t.Fatalf("unexpected frames: %#v", frames)
	}
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

// call sends a request and returns its reply frame.
func (c *testClient) call(t *testing.T, method, id string, params map[string]any) map[string]any {
	t.Helper()
	c.write(t, map[string]any{"method": method, "id": id, "params": params})
	frame := c.read(t)
	if frame["id"] != id {
		t.Fatalf("%s reply = %#v, want id %q", method, frame, id)
	}
	return frame
}

func (c *testClient) result(t *testing.T, method, id string, params map[string]any) map[string]any {
	t.Helper()
	frame := c.call(t, method, id, params)
	result, ok := frame["result"].(map[string]any)
	if !ok {
		t.Fatalf("%s failed: %#v", method, frame)
	}
	return result
}

func (c *testClient) expectError(t *testing.T, method, id string, params map[string]any, code int) {
	t.Helper()
	frame := c.call(t, method, id, params)
	failure, ok := frame["error"].(map[string]any)
	if !ok || failure["code"] != float64(code) {
		t.Fatalf("%s %s: %#v, want error %d", method, id, frame, code)
	}
}

// notification reads the next frame and requires it to be the named notification.
func (c *testClient) notification(t *testing.T, method string) map[string]any {
	t.Helper()
	frame := c.read(t)
	params, ok := frame["params"].(map[string]any)
	if frame["method"] != method || !ok || frame["id"] != nil {
		t.Fatalf("frame = %#v, want %s notification", frame, method)
	}
	return params
}

// save sends a message request and returns the result ID and the sender's copy
// of the broadcast snapshot.
func save(t *testing.T, c *testClient, requestID string, params map[string]any) (string, map[string]any) {
	t.Helper()
	if _, ok := params["room_id"]; !ok {
		params["room_id"] = "general"
	}
	result := c.result(t, "message", requestID, params)
	id, ok := result["message_id"].(string)
	if !ok || len(result) != 1 {
		t.Fatalf("message result: %#v", result)
	}
	snapshot := c.notification(t, "message")
	if snapshot["message_id"] != id || snapshot["room_id"] != params["room_id"] {
		t.Fatalf("result and snapshot disagree: %#v vs %#v", result, snapshot)
	}
	if _, wrapped := snapshot["message"]; wrapped {
		t.Fatalf("snapshot is not flat: %#v", snapshot)
	}
	return id, snapshot
}

// saveRoom sends a room request and returns the room ID and broadcast record.
func saveRoom(t *testing.T, c *testClient, requestID string, params map[string]any) (string, map[string]any) {
	t.Helper()
	result := c.result(t, "room", requestID, params)
	id, ok := result["room_id"].(string)
	if !ok || len(result) != 1 {
		t.Fatalf("room result: %#v", result)
	}
	record := c.notification(t, "room")
	if record["room_id"] != id {
		t.Fatalf("room result and record disagree: %#v vs %#v", result, record)
	}
	return id, record
}

func react(t *testing.T, c *testClient, requestID, messageID string, emojis ...string) map[string]any {
	t.Helper()
	list := make([]any, len(emojis))
	for i, emoji := range emojis {
		list[i] = emoji
	}
	result := c.result(t, "reactions", requestID, map[string]any{"message_id": messageID, "emojis": list})
	if len(result) != 0 {
		t.Fatalf("reactions result: %#v", result)
	}
	return c.notification(t, "reactions")
}

func historyPage(t *testing.T, c *testClient, roomID string, params map[string]any) map[string]any {
	t.Helper()
	params["room_id"] = roomID
	return c.result(t, "history", fmt.Sprintf("h-%d", time.Now().UnixNano()), params)
}

func logIDs(t *testing.T, page map[string]any, key string) []string {
	t.Helper()
	raw, ok := page[key].([]any)
	if !ok {
		t.Fatalf("history %s missing: %#v", key, page)
	}
	ids := make([]string, len(raw))
	for i, value := range raw {
		ids[i] = value.(map[string]any)["log_id"].(string)
	}
	return ids
}

func parseID(t *testing.T, value any) int64 {
	t.Helper()
	text, ok := value.(string)
	if !ok {
		t.Fatalf("log id %#v is not a string", value)
	}
	id, err := strconv.ParseInt(text, 10, 64)
	if err != nil || id <= 0 {
		t.Fatalf("log id %q is not a positive integer", text)
	}
	return id
}

func TestServerFrameAndGuestAuth(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c, frame := dialRaw(t, httpServer)
	params := frame["params"].(map[string]any)
	if params["protocol"] != float64(3) {
		t.Fatalf("protocol: %#v", params)
	}
	if !reflect.DeepEqual(params["caps"], []any{"history", "edit", "rooms", "reactions"}) {
		t.Fatalf("caps: %#v", params["caps"])
	}
	if !reflect.DeepEqual(params["auth"], []any{"guest"}) {
		t.Fatalf("auth: %#v", params["auth"])
	}

	c.expectError(t, "message", "early", map[string]any{"room_id": "general", "body": map[string]any{}}, codeDenied)
	c.expectError(t, "auth", "bad-scheme", map[string]any{"scheme": "password"}, codeUnsupported)
	you := c.result(t, "auth", "auth", map[string]any{"scheme": "guest", "name": "Ada"})["you"].(map[string]any)
	if you["user_id"] != "guest_1" || you["name"] != "Ada" {
		t.Fatalf("guest identity: %#v", you)
	}
	room := c.notification(t, "room")
	logID := room["log_id"]
	parseID(t, logID)
	want := map[string]any{"room_id": "general", "title": "General", "log_id": logID, "latest_log_id": logID, "history_log_id": logID}
	if !reflect.DeepEqual(room, want) {
		t.Fatalf("general announcement = %#v, want %#v", room, want)
	}
	c.expectQuiet(t)

	// The pre-v3 scheme name remains an alias for guest access.
	alias, _ := dialRaw(t, httpServer)
	you = alias.result(t, "auth", "legacy", map[string]any{"scheme": "anonymous"})["you"].(map[string]any)
	if you["user_id"] != "guest_2" {
		t.Fatalf("anonymous alias identity: %#v", you)
	}
	alias.notification(t, "room")

	// name is the v3 rename request; nick remains accepted.
	for _, method := range []string{"name", "nick"} {
		you = c.result(t, method, method, map[string]any{"name": method})["you"].(map[string]any)
		if you["user_id"] != "guest_1" || you["name"] != method {
			t.Fatalf("%s: %#v", method, you)
		}
	}
}

func TestRemovedAndUnknownMethodsAreUnsupported(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	for _, method := range []string{"thread", "room_create", "push_register"} {
		c.expectError(t, method, method, map[string]any{"room_id": "general"}, codeUnsupported)
	}
	c.expectQuiet(t)
}

func TestMessageSnapshotsReplaceEditableState(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	owner := dialTestClient(t, httpServer, "a", true)
	observer := dialTestClient(t, httpServer, "b", false)
	owner.result(t, "name", "name", map[string]any{"name": "Alice"})
	ext := map[string]any{"irc": map[string]any{"nick": "ada_"}}
	id, creation := save(t, owner, "create", map[string]any{
		"from":    map[string]any{"user_id": "forged"},
		"log_id":  "123",
		"body":    map[string]any{"text": "hello", "format": "plain", "embeds": []any{map[string]any{"kind": "file"}}},
		"ext":     ext,
		"custom":  true,
		"deleted": false,
	})
	if first := observer.notification(t, "message"); !reflect.DeepEqual(first, creation) {
		t.Fatalf("observer snapshot %#v differs from %#v", first, creation)
	}
	wantKeys := []string{"body", "ext", "from", "log_id", "message_id", "room_id"}
	if creation["log_id"] != id || !reflect.DeepEqual(slices.Sorted(maps.Keys(creation)), wantKeys) {
		t.Fatalf("creation snapshot: %#v", creation)
	}
	from := creation["from"].(map[string]any)
	if from["user_id"] != "guest_1" || from["name"] != "Alice" || !reflect.DeepEqual(creation["ext"], ext) {
		t.Fatalf("creation fields: %#v", creation)
	}

	owner.result(t, "name", "rename", map[string]any{"name": "Later"})
	stable, edit := save(t, owner, "edit", map[string]any{"message_id": id, "body": map[string]any{"text": "edited"}, "from": nil})
	observer.notification(t, "message")
	if stable != id || parseID(t, edit["log_id"]) <= parseID(t, id) {
		t.Fatalf("edit snapshot: %#v", edit)
	}
	if _, kept := edit["ext"]; kept || len(edit["body"].(map[string]any)) != 1 || edit["from"].(map[string]any)["name"] != "Alice" {
		t.Fatalf("replacement merged editable fields or changed author: %#v", edit)
	}

	_, deleted := save(t, owner, "delete", map[string]any{"message_id": id, "deleted": true, "body": "discard even invalid body"})
	observer.notification(t, "message")
	if _, exists := deleted["body"]; exists || deleted["deleted"] != true {
		t.Fatalf("tombstone: %#v", deleted)
	}

	page := historyPage(t, owner, "general", map[string]any{"after": "0"})
	entries := page["entries"].([]any)
	if len(entries) != 3 {
		t.Fatalf("history: %#v", page)
	}
	for i, expected := range []map[string]any{creation, edit, deleted} {
		if !reflect.DeepEqual(entries[i], any(expected)) {
			t.Fatalf("history entry %d = %#v, want %#v", i, entries[i], expected)
		}
	}
	observer.expectError(t, "message", "forged", map[string]any{"room_id": "general", "message_id": id, "body": map[string]any{"text": "forged"}}, codeDenied)
}

func TestLogIDsFormOneSequenceAcrossRoomsAndKinds(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c, rooms := dialTestClientWithRooms(t, httpServer, "a", false)
	last := parseID(t, rooms[0]["log_id"])
	check := func(label string, value any) {
		t.Helper()
		id := parseID(t, value)
		if id <= last {
			t.Fatalf("%s log_id %d does not follow %d", label, id, last)
		}
		last = id
	}
	id, message := save(t, c, "m1", map[string]any{"body": map[string]any{"text": "a"}})
	check("message", message["log_id"])
	room, record := saveRoom(t, c, "r1", map[string]any{"title": "Ops"})
	check("room", record["log_id"])
	if room != record["log_id"] {
		t.Fatalf("room_id %q should be its creation log_id %q", room, record["log_id"])
	}
	check("reactions", react(t, c, "x1", id, "👍")["log_id"])
	_, other := save(t, c, "m2", map[string]any{"room_id": room, "body": map[string]any{"text": "b"}})
	check("message in other room", other["log_id"])
}

func TestRepliesMayCrossRooms(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	body := map[string]any{"text": "hello"}
	root, _ := save(t, c, "root", map[string]any{"body": body})
	ops, _ := saveRoom(t, c, "ops", map[string]any{"title": "Ops"})

	reply, created := save(t, c, "reply", map[string]any{"room_id": ops, "body": body, "reply_to": map[string]any{"message_id": root}})
	if !reflect.DeepEqual(created["reply_to"], map[string]any{"message_id": root}) {
		t.Fatalf("cross-room reply_to: %#v", created)
	}
	// A client may pass back a snapshot; only its message_id is used.
	_, echoed := save(t, c, "reply-snapshot", map[string]any{"body": body, "reply_to": map[string]any{"message_id": reply, "room_id": ops, "body": body}})
	if !reflect.DeepEqual(echoed["reply_to"], map[string]any{"message_id": reply}) {
		t.Fatalf("reply_to not bare: %#v", echoed)
	}

	before := historyPage(t, c, "general", map[string]any{})
	for i, params := range []map[string]any{
		{"reply_to": nil}, {"reply_to": 123}, {"reply_to": root}, {"reply_to": map[string]any{}},
		{"reply_to": map[string]any{"message_id": ""}}, {"reply_to": map[string]any{"message_id": "0"}},
		{"reply_to": map[string]any{"message_id": "bad"}}, {"reply_to": map[string]any{"message_id": "999"}},
		{"message_id": root, "reply_to": map[string]any{"message_id": root}},
		{"reply_to": map[string]any{"message_id": root}, "room_id": "missing-room"},
	} {
		if _, ok := params["room_id"]; !ok {
			params["room_id"] = "general"
		}
		params["body"] = body
		c.expectError(t, "message", fmt.Sprint("bad-reply-", i), params, codeInvalidParams)
	}
	after := historyPage(t, c, "general", map[string]any{})
	if before["last_id"] != after["last_id"] {
		t.Fatal("rejected reply changed history")
	}

	// Replies to tombstones remain valid, and omitting reply_to on a save removes it.
	_, _ = save(t, c, "delete-root", map[string]any{"message_id": root, "deleted": true})
	_, _ = save(t, c, "reply-to-tombstone", map[string]any{"body": body, "reply_to": map[string]any{"message_id": root}})
	_, removed := save(t, c, "remove-reply", map[string]any{"message_id": reply, "room_id": ops, "body": body})
	if _, present := removed["reply_to"]; present {
		t.Fatal("omitted reply_to was retained")
	}
}

func TestRoomCreateUpdateAndThreads(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	observer := dialTestClient(t, httpServer, "b", false)
	intro, introSnapshot := save(t, c, "intro", map[string]any{"body": map[string]any{"text": "Deploy status\nsecond line", "format": "markdown"}})
	observer.notification(t, "message")

	// A thread without a title receives one derived from its intro message.
	thread, record := saveRoom(t, c, "thread", map[string]any{"parent_room_id": "general", "intro_message": map[string]any{"message_id": intro}})
	if observed := observer.notification(t, "room"); !reflect.DeepEqual(observed, record) {
		t.Fatalf("observer room %#v differs from %#v", observed, record)
	}
	want := map[string]any{
		"room_id": thread, "log_id": thread, "parent_room_id": "general", "title": "Deploy status",
		"intro_message": introSnapshot, "latest_log_id": thread, "history_log_id": thread,
	}
	if !reflect.DeepEqual(record, want) {
		t.Fatalf("thread record = %#v, want %#v", record, want)
	}
	_, untitled := saveRoom(t, c, "untitled", map[string]any{"parent_room_id": thread})
	observer.notification(t, "room")
	if untitled["title"] != "Thread" || untitled["parent_room_id"] != thread {
		t.Fatalf("nested untitled thread: %#v", untitled)
	}

	// Updates replace every client field except parent_room_id.
	ext := map[string]any{"app": map[string]any{"pinned": true}}
	sameID, updated := saveRoom(t, c, "update", map[string]any{"room_id": thread, "parent_room_id": "ignored", "title": "Renamed", "ext": ext})
	observer.notification(t, "room")
	if sameID != thread || updated["parent_room_id"] != "general" || updated["title"] != "Renamed" || !reflect.DeepEqual(updated["ext"], ext) {
		t.Fatalf("thread update: %#v", updated)
	}
	if _, kept := updated["intro_message"]; kept || updated["history_log_id"] != thread || updated["latest_log_id"] != updated["log_id"] {
		t.Fatalf("thread update fields: %#v", updated)
	}
	top, topRecord := saveRoom(t, observer, "top", map[string]any{"title": "Ops"})
	c.notification(t, "room")
	if _, isThread := topRecord["parent_room_id"]; isThread || topRecord["title"] != "Ops" {
		t.Fatalf("top-level room: %#v", topRecord)
	}
	_, cleared := saveRoom(t, observer, "clear", map[string]any{"room_id": top})
	c.notification(t, "room")
	if _, present := cleared["title"]; present {
		t.Fatalf("omitted title was retained on a top-level room: %#v", cleared)
	}

	// Room records are part of the room's own log.
	page := historyPage(t, c, thread, map[string]any{})
	if got := logIDs(t, page, "rooms"); !reflect.DeepEqual(got, []string{thread, updated["log_id"].(string)}) {
		t.Fatalf("thread room records: %#v", page)
	}
	if page["history_log_id"] != thread || page["latest_log_id"] != updated["log_id"] || len(page["entries"].([]any)) != 0 {
		t.Fatalf("thread history: %#v", page)
	}
	if general := historyPage(t, c, "general", map[string]any{}); len(general["rooms"].([]any)) != 1 {
		t.Fatalf("thread records leaked into the parent log: %#v", general)
	}

	for i, params := range []map[string]any{
		{"room_id": "missing", "title": "x"},
		{"room_id": nil},
		{"parent_room_id": "missing"},
		{"parent_room_id": ""},
		{"parent_room_id": 12},
		{"title": 12},
		{"title": nil},
		{"intro_message": map[string]any{"message_id": "999"}},
		{"intro_message": intro},
		{"ext": []any{}},
		{"ext": nil},
	} {
		c.expectError(t, "room", fmt.Sprint("bad-room-", i), params, codeInvalidParams)
	}
	c.expectQuiet(t)

	// Reconnecting announces every room, parents before threads, with the
	// current intro snapshot embedded.
	_, _ = saveRoom(t, c, "intro-again", map[string]any{"room_id": thread, "title": "Renamed", "intro_message": map[string]any{"message_id": intro}})
	observer.notification(t, "room")
	_, editedIntro := save(t, c, "edit-intro", map[string]any{"message_id": intro, "body": map[string]any{"text": "Deploy done"}})
	observer.notification(t, "message")
	_, rooms := dialTestClientWithRooms(t, httpServer, "again", false)
	order := make([]string, len(rooms))
	for i, room := range rooms {
		order[i] = room["room_id"].(string)
	}
	if !reflect.DeepEqual(order, []string{"general", thread, untitled["room_id"].(string), top}) {
		t.Fatalf("announcement order: %#v", order)
	}
	if !reflect.DeepEqual(rooms[1]["intro_message"], any(editedIntro)) {
		t.Fatalf("announcement did not embed the current intro snapshot: %#v", rooms[1])
	}

	// room_join re-announces; room_leave is denied by policy.
	if result := observer.result(t, "room_join", "join", map[string]any{"room_id": thread}); len(result) != 0 {
		t.Fatalf("room_join result: %#v", result)
	}
	if joined := observer.notification(t, "room"); joined["room_id"] != thread || joined["removed"] != nil {
		t.Fatalf("room_join announcement: %#v", joined)
	}
	observer.expectError(t, "room_join", "join-missing", map[string]any{"room_id": "missing"}, codeInvalidParams)
	observer.expectError(t, "room_leave", "leave", map[string]any{"room_id": thread}, codeDenied)
	observer.expectError(t, "room_leave", "leave-missing", map[string]any{"room_id": "missing"}, codeInvalidParams)
	observer.expectQuiet(t)
}

func TestMoveAppearsInBothRoomsAndCarriesReactions(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	author := dialTestClient(t, httpServer, "a", false)
	reactor := dialTestClient(t, httpServer, "b", false)
	body := map[string]any{"text": "move me"}
	id, created := save(t, author, "create", map[string]any{"body": body})
	reactor.notification(t, "message")
	thread, _ := saveRoom(t, author, "thread", map[string]any{"parent_room_id": "general", "intro_message": map[string]any{"message_id": id}})
	reactor.notification(t, "room")
	first := react(t, author, "react-a", id, "👍")
	reactor.notification(t, "reactions")
	react(t, reactor, "react-b", id, "🎉", "👍")
	author.notification(t, "reactions")
	react(t, reactor, "react-b-clear", id)
	author.notification(t, "reactions")
	react(t, reactor, "react-b-again", id, "🚀")
	author.notification(t, "reactions")

	reactor.expectError(t, "message", "not-owner", map[string]any{"message_id": id, "room_id": thread, "body": body}, codeDenied)
	author.expectError(t, "message", "missing-room", map[string]any{"message_id": id, "room_id": "missing", "body": body}, codeInvalidParams)

	_, moved := save(t, author, "move", map[string]any{"message_id": id, "room_id": thread, "body": body})
	carried := author.notification(t, "reactions")
	if observed := reactor.notification(t, "message"); !reflect.DeepEqual(observed, moved) {
		t.Fatalf("move broadcast differs: %#v", observed)
	}
	if observed := reactor.notification(t, "reactions"); !reflect.DeepEqual(observed, carried) {
		t.Fatalf("carried reactions broadcast differs: %#v", observed)
	}
	if carried["room_id"] != thread || carried["message_id"] != id || parseID(t, carried["log_id"]) <= parseID(t, moved["log_id"]) {
		t.Fatalf("carried reactions record: %#v", carried)
	}
	wantSets := []any{
		map[string]any{"from": map[string]any{"user_id": "guest_1"}, "emojis": []any{"👍"}},
		map[string]any{"from": map[string]any{"user_id": "guest_2"}, "emojis": []any{"🚀"}},
	}
	if !reflect.DeepEqual(carried["reactions"], wantSets) {
		t.Fatalf("carried sets = %#v, want %#v", carried["reactions"], wantSets)
	}

	general := historyPage(t, author, "general", map[string]any{})
	if got := logIDs(t, general, "entries"); !reflect.DeepEqual(got, []string{id, moved["log_id"].(string)}) {
		t.Fatalf("source history entries: %#v", got)
	}
	if got := logIDs(t, general, "reactions"); len(got) != 4 || got[0] != first["log_id"] {
		t.Fatalf("source history keeps earlier reaction records: %#v", got)
	}
	if general["latest_log_id"] != moved["log_id"] {
		t.Fatalf("source latest_log_id: %#v", general)
	}
	threadPage := historyPage(t, author, thread, map[string]any{})
	if got := logIDs(t, threadPage, "entries"); !reflect.DeepEqual(got, []string{moved["log_id"].(string)}) {
		t.Fatalf("destination history entries: %#v", got)
	}
	if got := logIDs(t, threadPage, "reactions"); !reflect.DeepEqual(got, []string{carried["log_id"].(string)}) {
		t.Fatalf("destination history reactions: %#v", got)
	}
	if threadPage["latest_log_id"] != carried["log_id"] || threadPage["history_log_id"] != thread {
		t.Fatalf("destination bounds: %#v", threadPage)
	}
	if historical := general["entries"].([]any)[0]; !reflect.DeepEqual(historical, any(created)) {
		t.Fatalf("earlier snapshot changed: %#v", historical)
	}

	// Later reactions are logged in the message's current room; edits in place
	// stay in one room.
	later := react(t, author, "react-later", id, "✅")
	if later["room_id"] != thread {
		t.Fatalf("reaction after move: %#v", later)
	}
	_, edited := save(t, author, "edit-in-thread", map[string]any{"message_id": id, "room_id": thread, "body": map[string]any{"text": "edited"}})
	if after := historyPage(t, author, "general", map[string]any{}); after["latest_log_id"] != moved["log_id"] {
		t.Fatalf("in-place edit leaked into source room: %#v (edit %v)", after, edited["log_id"])
	}

	// A move without reactions logs no reactions record.
	plain, _ := save(t, author, "plain", map[string]any{"body": body})
	_, _ = save(t, author, "plain-move", map[string]any{"message_id": plain, "room_id": thread, "body": body})
	author.expectQuiet(t)
}

func TestReactions(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	id, _ := save(t, c, "create", map[string]any{"body": map[string]any{"text": "react to me"}})

	set := react(t, c, "set", id, "👍", "🎉", "👍")
	want := map[string]any{
		"log_id": set["log_id"], "message_id": id, "room_id": "general",
		"reactions": []any{map[string]any{"from": map[string]any{"user_id": "guest_1"}, "emojis": []any{"👍", "🎉"}}},
	}
	if !reflect.DeepEqual(set, want) {
		t.Fatalf("reactions broadcast = %#v, want %#v", set, want)
	}
	// An unchanged set, in any order, logs nothing.
	if result := c.result(t, "reactions", "same", map[string]any{"message_id": id, "emojis": []any{"🎉", "👍"}}); len(result) != 0 {
		t.Fatalf("unchanged result: %#v", result)
	}
	c.expectQuiet(t)
	// Request deduplication returns the original result without rebroadcasting.
	c.result(t, "reactions", "set", map[string]any{"message_id": id, "emojis": []any{"👍", "🎉", "👍"}})
	c.expectQuiet(t)
	c.expectError(t, "reactions", "set", map[string]any{"message_id": id, "emojis": []any{"👎"}}, codeInvalidParams)

	cleared := react(t, c, "clear", id)
	if sets := cleared["reactions"].([]any); len(sets) != 1 || len(sets[0].(map[string]any)["emojis"].([]any)) != 0 {
		t.Fatalf("clear broadcast: %#v", cleared)
	}
	c.result(t, "reactions", "clear-again", map[string]any{"message_id": id, "emojis": []any{}})
	c.expectQuiet(t)

	tooMany := make([]any, maxDistinctEmoji+1)
	for i := range tooMany {
		tooMany[i] = strconv.Itoa(i)
	}
	for i, params := range []map[string]any{
		{"message_id": "999", "emojis": []any{"👍"}},
		{"message_id": id},
		{"message_id": id, "emojis": nil},
		{"message_id": id, "emojis": "👍"},
		{"message_id": id, "emojis": []any{12}},
		{"message_id": id, "emojis": []any{""}},
		{"message_id": id, "emojis": tooMany},
		{"emojis": []any{"👍"}},
	} {
		c.expectError(t, "reactions", fmt.Sprint("bad-", i), params, codeInvalidParams)
	}
	c.expectQuiet(t)

	page := historyPage(t, c, "general", map[string]any{})
	if got := logIDs(t, page, "reactions"); !reflect.DeepEqual(got, []string{set["log_id"].(string), cleared["log_id"].(string)}) {
		t.Fatalf("history reactions: %#v", page)
	}
}

func TestHistoryPaginatesAcrossRecordKinds(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c, rooms := dialTestClientWithRooms(t, httpServer, "a", false)
	generalID := rooms[0]["log_id"].(string)
	id, message := save(t, c, "m1", map[string]any{"body": map[string]any{"text": "one"}})
	reaction := react(t, c, "x1", id, "👍")
	_, updated := saveRoom(t, c, "r1", map[string]any{"room_id": "general", "title": "Lobby"})
	_, second := save(t, c, "m2", map[string]any{"body": map[string]any{"text": "two"}})
	all := []string{generalID, message["log_id"].(string), reaction["log_id"].(string), updated["log_id"].(string), second["log_id"].(string)}

	full := historyPage(t, c, "general", map[string]any{})
	if full["first_id"] != all[0] || full["last_id"] != all[4] || full["more"] != false {
		t.Fatalf("full page: %#v", full)
	}
	if full["history_log_id"] != generalID || full["latest_log_id"] != all[4] {
		t.Fatalf("full page bounds: %#v", full)
	}
	if !reflect.DeepEqual(logIDs(t, full, "rooms"), []string{all[0], all[3]}) ||
		!reflect.DeepEqual(logIDs(t, full, "entries"), []string{all[1], all[4]}) ||
		!reflect.DeepEqual(logIDs(t, full, "reactions"), []string{all[2]}) {
		t.Fatalf("partitioned page: %#v", full)
	}
	if lobby := full["rooms"].([]any)[1].(map[string]any); lobby["title"] != "Lobby" || lobby["latest_log_id"] != nil {
		t.Fatalf("logged room record carries delivery fields: %#v", lobby)
	}

	// Forward paging over every record kind, continuing from last_id + 1.
	collected := make([]string, 0)
	after := "0"
	for pages := 0; ; pages++ {
		page := historyPage(t, c, "general", map[string]any{"after": after, "limit": 2})
		ids := append(append(logIDs(t, page, "rooms"), logIDs(t, page, "entries")...), logIDs(t, page, "reactions")...)
		if len(ids) == 0 || len(ids) > 2 || page["latest_log_id"] != all[4] {
			t.Fatalf("forward page: %#v", page)
		}
		collected = append(collected, ids...)
		if page["more"] == false {
			if pages != 2 || page["last_id"] != all[4] {
				t.Fatalf("final forward page: %#v", page)
			}
			break
		}
		after = strconv.FormatInt(parseID(t, page["last_id"])+1, 10)
	}
	if len(collected) != len(all) {
		t.Fatalf("forward paging collected %v, want %v", collected, all)
	}

	// Backward paging selects the newest matches first.
	page := historyPage(t, c, "general", map[string]any{"limit": 2})
	if page["first_id"] != all[3] || page["last_id"] != all[4] || page["more"] != true {
		t.Fatalf("newest page: %#v", page)
	}
	page = historyPage(t, c, "general", map[string]any{"before": strconv.FormatInt(parseID(t, page["first_id"])-1, 10), "limit": 2})
	if page["first_id"] != all[1] || page["last_id"] != all[2] || page["more"] != true {
		t.Fatalf("backward continuation: %#v", page)
	}
	// Inclusive bounds on both sides.
	page = historyPage(t, c, "general", map[string]any{"after": all[2], "before": all[3]})
	if page["first_id"] != all[2] || page["last_id"] != all[3] || page["more"] != false {
		t.Fatalf("inclusive window: %#v", page)
	}
	// Empty windows omit first_id/last_id but keep the room bounds.
	empty := historyPage(t, c, "general", map[string]any{"after": strconv.FormatInt(parseID(t, all[4])+1, 10)})
	if _, present := empty["first_id"]; present || empty["more"] != false || len(empty["entries"].([]any)) != 0 || empty["history_log_id"] != generalID {
		t.Fatalf("empty page: %#v", empty)
	}
	// Removed parameters are ignored; invalid ones are rejected.
	historyPage(t, c, "general", map[string]any{"thread_id": "t_1"})
	for i, params := range []map[string]any{
		{"room_id": "missing"}, {"room_id": "general", "limit": 0}, {"room_id": "general", "after": 5},
		{"room_id": "general", "before": "-1"},
	} {
		c.expectError(t, "history", fmt.Sprint("bad-", i), params, codeInvalidParams)
	}
}

func TestInvalidSavesLeaveStateUnchanged(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	id, _ := save(t, c, "create", map[string]any{"body": map[string]any{"text": "hello"}})
	for i, params := range []map[string]any{
		{"body": map[string]any{}, "deleted": true},
		{"message_id": "999", "body": map[string]any{}},
		{"message_id": nil, "body": map[string]any{}},
		{"message_id": id},
		{"message_id": id, "body": nil},
		{"message_id": id, "body": map[string]any{"text": nil}},
		{"message_id": id, "body": map[string]any{"format": "html"}},
		{"message_id": id, "body": map[string]any{"embeds": nil}},
		{"message_id": id, "body": map[string]any{}, "ext": nil},
		{"message_id": id, "body": map[string]any{}, "ext": "text"},
		{"body": map[string]any{}, "deleted": nil},
		{"body": map[string]any{}, "room_id": nil},
		{"body": map[string]any{}, "room_id": "missing"},
	} {
		if _, ok := params["room_id"]; !ok {
			params["room_id"] = "general"
		}
		c.expectError(t, "message", fmt.Sprint("bad-", i), params, codeInvalidParams)
	}
	c.expectError(t, "message", "no-room", map[string]any{"body": map[string]any{}}, codeInvalidParams)
	c.expectQuiet(t)
	page := historyPage(t, c, "general", map[string]any{})
	if len(page["entries"].([]any)) != 1 || page["latest_log_id"] != id {
		t.Fatalf("invalid operations appended history: %#v", page)
	}
}

func TestRoomAnnouncementsUseOneQueueBatch(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	owner := dialTestClient(t, httpServer, "owner", false)
	const count = 129
	for i := range count {
		saveRoom(t, owner, fmt.Sprint("thread-", i), map[string]any{"parent_room_id": "general"})
	}
	_, rooms := dialTestClientWithRooms(t, httpServer, "again", false)
	seen := make(map[string]bool)
	for _, room := range rooms {
		seen[room["room_id"].(string)] = true
	}
	if len(seen) != count+1 || rooms[0]["room_id"] != "general" {
		t.Fatalf("received %d rooms", len(seen))
	}
}

func TestRequestDeduplication(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	thread, _ := saveRoom(t, c, "thread", map[string]any{"parent_room_id": "general", "title": "Deploy"})
	c.write(t, map[string]any{"jsonrpc": "2.0", "method": "room", "id": "thread", "params": map[string]any{"title": "Deploy", "parent_room_id": "general"}})
	if c.read(t)["result"].(map[string]any)["room_id"] != thread {
		t.Fatal("room retry minted another ID")
	}
	c.expectQuiet(t)

	id, _ := save(t, c, "create", map[string]any{"body": map[string]any{"text": "initial"}})
	params := map[string]any{"room_id": thread, "message_id": id, "body": map[string]any{"text": "edited"}}
	_, move := save(t, c, "edit", params)
	if resultID := c.result(t, "message", "edit", params)["message_id"]; resultID != id {
		t.Fatal("replacement retry changed message ID")
	}
	c.expectQuiet(t)
	params["body"] = map[string]any{"text": "conflicting retry"}
	c.expectError(t, "message", "edit", params, codeInvalidParams)
	c.expectError(t, "history", "edit", map[string]any{"room_id": thread}, codeInvalidParams)
	page := historyPage(t, c, thread, map[string]any{})
	if len(page["entries"].([]any)) != 1 || page["last_id"] != move["log_id"] {
		t.Fatalf("retry appended log entries: %#v", page)
	}
}

func TestNotificationsDoNotReceiveRepliesAndHealth(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	c.write(t, map[string]any{"method": "unknown_notification"})
	c.write(t, map[string]any{"method": "message", "params": []any{}})
	c.write(t, map[string]any{"method": "name", "params": map[string]any{"name": nil}})
	c.write(t, map[string]any{"method": "reactions", "params": map[string]any{"message_id": "999", "emojis": []any{}}})
	c.write(t, map[string]any{"method": "auth"})
	c.write(t, map[string]any{"method": "name", "id": "n1", "params": map[string]any{"name": "A"}})
	response := c.read(t)
	if response["id"] != "n1" {
		t.Fatalf("notification produced a response before name: %#v", response)
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

func TestTypingUsesInlineIdentity(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	thread, _ := saveRoom(t, c, "thread", map[string]any{"parent_room_id": "general"})
	c.write(t, map[string]any{"method": "typing", "params": map[string]any{"room_id": thread, "active": true, "from": map[string]any{"user_id": "forged"}}})
	params := c.notification(t, "typing")
	if params["room_id"] != thread || params["from"].(map[string]any)["user_id"] != "guest_1" {
		t.Fatalf("typing: %#v", params)
	}
	c.expectError(t, "typing", "missing", map[string]any{"room_id": "missing", "active": true}, codeInvalidParams)
}
