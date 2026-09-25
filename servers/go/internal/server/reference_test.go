package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// httpDo sends one HTTP request and returns the status, headers, and body.
func httpDo(t *testing.T, method, url string, body io.Reader, contentType string) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, data
}

func testPNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 3, 2))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func embedsOf(t *testing.T, snapshot map[string]any) []map[string]any {
	t.Helper()
	body, _ := snapshot["body"].(map[string]any)
	list, _ := body["embeds"].([]any)
	embeds := make([]map[string]any, len(list))
	for i, value := range list {
		embeds[i] = value.(map[string]any)
	}
	return embeds
}

func methods(frames []map[string]any) []string {
	names := make([]string, len(frames))
	for i, frame := range frames {
		names[i], _ = frame["method"].(string)
		if names[i] == "" {
			names[i] = "reply"
		}
	}
	return names
}

func memberIDs(entry map[string]any) []string {
	var ids []string
	for _, member := range entry["members"].([]any) {
		ids = append(ids, member.(map[string]any)["user_id"].(string))
	}
	return ids
}

func TestServerFrameAdvertisesReferenceFeatures(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	_, frame := dialRaw(t, httpServer)
	params := frame["params"].(map[string]any)
	if !reflect.DeepEqual(params["push"], map[string]any{"relay": map[string]any{}}) {
		t.Fatalf("push: %#v", params["push"])
	}
	limits := params["ext"].(map[string]any)["apron-go"].(map[string]any)
	if limits["max_upload_bytes"] != float64(defaultMaxUploadBytes) || limits["stream_keep_bytes"] != float64(defaultStreamKeepBytes) {
		t.Fatalf("ext limits: %#v", limits)
	}

	config := DefaultConfig()
	config.DisablePush = true
	_, quiet := newTestServer(t, config)
	c, frame := dialRaw(t, quiet)
	if _, has := frame["params"].(map[string]any)["push"]; has {
		t.Fatal("push advertised while disabled")
	}
	c.write(t, map[string]any{"method": "auth", "id": "a", "params": map[string]any{"scheme": "guest"}})
	c.drain(t)
	c.expectError(t, "push_register", "p", map[string]any{"kind": "relay", "url": "https://relay.example/p"}, codeUnsupported)
}

func TestRoomListFiltersAndOrder(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "a", "b")
	a, b := clients[0], clients[1]
	ops, _ := saveRoom(t, a, "ops", map[string]any{"title": "Ops"})
	deploy, _ := saveRoom(t, a, "deploy", map[string]any{"parent_room_id": ops, "title": "Deploy"})
	random, _ := saveRoom(t, b, "random", map[string]any{"title": "Random"})
	idle, _ := saveRoom(t, b, "idle", map[string]any{"parent_room_id": "general", "title": "Idle"})
	roomUpdated(t, a, "updated")
	save(t, a, "post", map[string]any{"room_id": ops, "body": map[string]any{"text": "most recent"}})

	// joined holds joined rooms at every depth, most recently active first;
	// rooms holds visible unjoined top-level rooms.
	listed := listRooms(t, a, map[string]any{})
	if got := roomIDs(t, listed["joined"]); !reflect.DeepEqual(got, []string{ops, deploy, "general"}) {
		t.Fatalf("joined: %v", got)
	}
	if got := roomIDs(t, listed["rooms"]); !reflect.DeepEqual(got, []string{random}) {
		t.Fatalf("rooms: %v", got)
	}
	general := listed["joined"].([]any)[2].(map[string]any)
	if general["member_count"] != float64(2) || !reflect.DeepEqual(memberIDs(general), []string{"guest_1", "guest_2"}) {
		t.Fatalf("general members: %#v", general)
	}
	wantUsers := []any{map[string]any{"user_id": "guest_1"}, map[string]any{"user_id": "guest_2"}}
	if !reflect.DeepEqual(listed["users"], wantUsers) {
		t.Fatalf("users: %#v", listed["users"])
	}
	if opsEntry := listed["joined"].([]any)[0].(map[string]any); opsEntry["title"] != "Ops" || opsEntry["latest_log_id"] == nil || opsEntry["member_count"] != float64(1) {
		t.Fatalf("ops entry: %#v", opsEntry)
	}

	// only_joined and not_joined leave out the other array.
	if only := listRooms(t, a, map[string]any{"only_joined": true}); only["rooms"] != nil || len(only["joined"].([]any)) != 3 {
		t.Fatalf("only_joined: %#v", only)
	}
	if not := listRooms(t, a, map[string]any{"not_joined": true}); not["joined"] != nil || !reflect.DeepEqual(roomIDs(t, not["rooms"]), []string{random}) {
		t.Fatalf("not_joined: %#v", not)
	}
	// parent_room_id lists that room's threads, joined or not.
	threads := listRooms(t, a, map[string]any{"parent_room_id": "general"})
	if len(threads["joined"].([]any)) != 0 || !reflect.DeepEqual(roomIDs(t, threads["rooms"]), []string{idle}) {
		t.Fatalf("general's threads: %#v", threads)
	}
	if threads := listRooms(t, b, map[string]any{"parent_room_id": ops}); !reflect.DeepEqual(roomIDs(t, threads["rooms"]), []string{deploy}) {
		t.Fatalf("ops threads for a non-member: %#v", threads)
	}
	// room_id lists one room and overrides parent_room_id.
	one := listRooms(t, b, map[string]any{"room_id": ops, "parent_room_id": "general"})
	if !reflect.DeepEqual(roomIDs(t, one["rooms"]), []string{ops}) || len(one["joined"].([]any)) != 0 {
		t.Fatalf("one room: %#v", one)
	}
	// latest_log_id lists only rooms active since.
	since := listed["joined"].([]any)[1].(map[string]any)["latest_log_id"]
	if recent := listRooms(t, a, map[string]any{"latest_log_id": since}); !reflect.DeepEqual(roomIDs(t, recent["joined"]), []string{ops}) || len(recent["rooms"].([]any)) != 1 {
		t.Fatalf("latest_log_id filter: %#v", recent)
	}
	for i, params := range []map[string]any{
		{"parent_room_id": "missing"}, {"room_id": "missing"}, {"only_joined": "yes"},
		{"latest_log_id": 5}, {"parent_room_id": 5},
	} {
		a.expectError(t, "room_list", fmt.Sprint("bad-", i), params, codeInvalidParams)
	}
	a.expectQuiet(t)
	b.expectQuiet(t)
}

func TestRoomListTruncatesOnlyUnjoinedRooms(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "owner", "other")
	owner, other := clients[0], clients[1]
	var threads []string
	for i := range maxListedRooms + 1 {
		thread, _ := saveRoom(t, owner, fmt.Sprint("thread-", i), map[string]any{"parent_room_id": "general"})
		roomUpdated(t, other, "updated")
		threads = append(threads, thread)
	}
	if joined := listRooms(t, owner, map[string]any{"only_joined": true})["joined"].([]any); len(joined) != maxListedRooms+2 {
		t.Fatalf("owner joined %d rooms", len(joined))
	}
	// The unjoined listing keeps the most recently active.
	rooms := roomIDs(t, listRooms(t, other, map[string]any{"parent_room_id": "general"})["rooms"])
	if len(rooms) != maxListedRooms || rooms[0] != threads[len(threads)-1] || slices.Contains(rooms, threads[0]) {
		t.Fatalf("unjoined threads: %d, first %v", len(rooms), rooms[0])
	}
}

func TestJoinLeaveAndDeliveries(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "a", "b")
	a, b := clients[0], clients[1]
	ops, opsRecord := saveRoom(t, a, "ops", map[string]any{"title": "Ops"})

	// A member receives the room's records; a poster who has not joined gets
	// only the result.
	b.write(t, map[string]any{"method": "message", "id": "outside", "params": map[string]any{"room_id": ops, "body": map[string]any{"text": "from outside"}}})
	if frames := b.drain(t); !reflect.DeepEqual(methods(frames), []string{"reply"}) {
		t.Fatalf("non-member post: %#v", frames)
	}
	outside := a.notification(t, "message")
	if outside["from"].(map[string]any)["user_id"] != "guest_2" {
		t.Fatalf("non-member post broadcast: %#v", outside)
	}
	// Reactions and typing in a room not joined reach only its members.
	react(t, a, "react", outside["message_id"].(string), "👍")
	b.write(t, map[string]any{"method": "activity", "params": map[string]any{"room_id": ops, "typing": 5}})
	a.notification(t, "activity")
	b.expectQuiet(t)

	// Joining sends the room to the joiner and announces them to members.
	record := joinRoom(t, b, ops)
	if record["title"] != "Ops" || record["log_id"] != opsRecord["log_id"] || record["latest_log_id"] == nil {
		t.Fatalf("joined record: %#v", record)
	}
	if joined := expectJoin(t, a, ops); joined["user_id"] != "guest_2" {
		t.Fatalf("join: %#v", joined)
	}
	save(t, a, "inside", map[string]any{"room_id": ops, "body": map[string]any{"text": "welcome"}})
	b.notification(t, "message")
	// Joining again re-sends the record to the calling connection only.
	joinRoom(t, b, ops)
	a.expectQuiet(t)
	b.expectError(t, "room_join", "missing", map[string]any{"room_id": "missing"}, codeInvalidParams)

	// Leaving stops deliveries, and a result sent after the leave reflects it.
	b.write(t, map[string]any{"method": "room_leave", "id": "leave", "params": map[string]any{"room_id": ops}})
	b.write(t, map[string]any{"method": "room_list", "id": "after-leave", "params": map[string]any{"only_joined": true}})
	frames := b.drain(t)
	if !reflect.DeepEqual(methods(frames), []string{"room_update", "reply", "reply"}) ||
		!reflect.DeepEqual(frames[0]["params"], map[string]any{"left": []any{map[string]any{"room_id": ops}}}) {
		t.Fatalf("leave frames: %#v", frames)
	}
	if got := roomIDs(t, frames[2]["result"].(map[string]any)["joined"]); !reflect.DeepEqual(got, []string{"general"}) {
		t.Fatalf("joined after leave: %v", got)
	}
	expectLeave(t, a, ops, "guest_2")
	save(t, a, "after", map[string]any{"room_id": ops, "body": map[string]any{"text": "gone"}})
	b.expectQuiet(t)
	// Leaving a room not joined changes nothing.
	b.result(t, "room_leave", "again", map[string]any{"room_id": ops})
	b.expectError(t, "room_leave", "missing", map[string]any{"room_id": "missing"}, codeInvalidParams)
	a.expectQuiet(t)

	// Leaving the last shared room also says the users share no room.
	leaveRoom(t, b, "general")
	expectLeave(t, a, "general", "guest_2")
	if gone := a.notification(t, "user"); !reflect.DeepEqual(gone, map[string]any{"old": map[string]any{"user_id": "guest_2"}}) {
		t.Fatalf("no longer sharing a room: %#v", gone)
	}
	joinRoom(t, b, ops)
	expectJoin(t, a, ops)

	// A guest who disconnects is retired: those who shared a room with it
	// learn it no longer shares one, and it leaves every room.
	_ = b.ws.Close(websocket.StatusNormalClosure, "done")
	if gone := a.notification(t, "user"); !reflect.DeepEqual(gone, map[string]any{"old": map[string]any{"user_id": "guest_2"}}) {
		t.Fatalf("retirement: %#v", gone)
	}
	if entry := listRooms(t, a, map[string]any{"room_id": ops})["joined"].([]any)[0].(map[string]any); !reflect.DeepEqual(memberIDs(entry), []string{"guest_1"}) {
		t.Fatalf("retired guest is still a member: %#v", entry)
	}
}

func TestPrevLogIDLinksRecords(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	c := dialTestClient(t, httpServer, "a", false)
	id, creation := save(t, c, "create", map[string]any{"body": map[string]any{"text": "one"}})
	if _, has := creation["prev_log_id"]; has {
		t.Fatalf("creation has prev_log_id: %#v", creation)
	}
	_, edit := save(t, c, "edit", map[string]any{"message_id": id, "body": map[string]any{"text": "two"}})
	if edit["prev_log_id"] != id {
		t.Fatalf("edit prev_log_id: %#v", edit)
	}
	room, record := saveRoom(t, c, "room", map[string]any{"title": "A"})
	_, updated := saveRoom(t, c, "update", map[string]any{"room_id": room, "title": "B"})
	if _, has := record["prev_log_id"]; has || updated["prev_log_id"] != record["log_id"] {
		t.Fatalf("room prev_log_id: %#v then %#v", record, updated)
	}
	first := react(t, c, "r1", id, "👍")
	second := react(t, c, "r2", id, "🎉")
	if _, has := first["prev_log_id"]; has || second["prev_log_id"] != first["log_id"] {
		t.Fatalf("reactions prev_log_id: %#v then %#v", first, second)
	}
}

func TestReadCursors(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "a", "b")
	a, b := clients[0], clients[1]
	first, _ := save(t, a, "one", map[string]any{"body": map[string]any{"text": "one"}})
	b.notification(t, "message")
	second, _ := save(t, a, "two", map[string]any{"body": map[string]any{"text": "two"}})
	b.notification(t, "message")

	a.write(t, map[string]any{"method": "activity", "params": map[string]any{"room_id": "general", "read_message_id": second}})
	want := map[string]any{"room_id": "general", "from": map[string]any{"user_id": "guest_1"}, "read_message_id": second}
	for _, c := range []*testClient{a, b} {
		if cursor := c.notification(t, "activity"); !reflect.DeepEqual(cursor, want) {
			t.Fatalf("read cursor = %#v, want %#v", cursor, want)
		}
	}
	// A cursor that moves back is ignored.
	a.write(t, map[string]any{"method": "activity", "params": map[string]any{"room_id": "general", "read_message_id": first}})
	b.expectQuiet(t)
	a.expectQuiet(t)
	a.expectError(t, "activity", "unknown", map[string]any{"room_id": "general", "read_message_id": "999"}, codeInvalidParams)

	// Kept cursors follow a room_list result that lists the room: every
	// member's for a joined room, only the user's own for another.
	c := dialTestClient(t, httpServer, "c", false)
	expectJoin(t, a, "general")
	expectJoin(t, b, "general")
	c.write(t, map[string]any{"method": "room_list", "id": "list", "params": map[string]any{"only_joined": true}})
	frames := c.drain(t)
	if !reflect.DeepEqual(methods(frames), []string{"reply", "activity"}) || !reflect.DeepEqual(frames[1]["params"], any(want)) {
		t.Fatalf("room_list frames: %#v", frames)
	}
	thread, _ := saveRoom(t, b, "thread", map[string]any{"parent_room_id": "general"})
	roomUpdated(t, a, "updated")
	roomUpdated(t, c, "updated")
	b.write(t, map[string]any{"method": "activity", "params": map[string]any{"room_id": thread, "read_message_id": second}})
	b.notification(t, "activity")
	a.write(t, map[string]any{"method": "activity", "params": map[string]any{"room_id": thread, "read_message_id": first}})
	a.notification(t, "activity")
	b.notification(t, "activity")
	a.write(t, map[string]any{"method": "room_list", "id": "threads", "params": map[string]any{"parent_room_id": "general"}})
	frames = a.drain(t)
	if !reflect.DeepEqual(methods(frames), []string{"reply", "activity"}) || frames[1]["params"].(map[string]any)["from"].(map[string]any)["user_id"] != "guest_1" {
		t.Fatalf("unjoined room cursors: %#v", frames)
	}
}

func TestProfilesAndUserNotifications(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "a", "b")
	a, b := clients[0], clients[1]
	ext := map[string]any{"example.org": map[string]any{"pronouns": "she/her"}}
	you := a.result(t, "me", "profile", map[string]any{"name": "  Ada  ", "avatar": "data:image/png;base64,iVBORw0KGgo=", "ext": ext})["you"]
	want := map[string]any{"user_id": "guest_1", "name": "Ada", "avatar": "data:image/png;base64,iVBORw0KGgo=", "ext": ext}
	if !reflect.DeepEqual(you, any(want)) {
		t.Fatalf("you = %#v", you)
	}
	if notice := b.notification(t, "user"); !reflect.DeepEqual(notice, map[string]any{"new": want}) {
		t.Fatalf("user notification: %#v", notice)
	}
	// Avatars and ext travel in profiles, not in every from.
	_, snapshot := save(t, a, "post", map[string]any{"body": map[string]any{"text": "hi"}})
	b.notification(t, "message")
	if !reflect.DeepEqual(snapshot["from"], map[string]any{"user_id": "guest_1", "name": "Ada"}) {
		t.Fatalf("from: %#v", snapshot["from"])
	}
	// room_list sends members bare, with complete objects in users.
	listed := listRooms(t, b, map[string]any{"only_joined": true})
	if members := listed["joined"].([]any)[0].(map[string]any)["members"].([]any); !reflect.DeepEqual(members[0], map[string]any{"user_id": "guest_1"}) {
		t.Fatalf("members: %#v", members)
	}
	if users := listed["users"].([]any); !reflect.DeepEqual(users[0], any(want)) {
		t.Fatalf("users: %#v", users)
	}
	// History pages carry the authors' current objects.
	if users := historyPage(t, b, "general", map[string]any{})["users"]; !reflect.DeepEqual(users, []any{want}) {
		t.Fatalf("history users: %#v", users)
	}
	// An unchanged profile sends no notification; omitted fields stay.
	a.result(t, "me", "same", map[string]any{"name": "Ada"})
	b.expectQuiet(t)
	// An empty value removes a field, announced as that empty value.
	you = a.result(t, "me", "clear", map[string]any{"ext": map[string]any{}, "avatar": ""})["you"]
	cleared := map[string]any{"user_id": "guest_1", "name": "Ada", "avatar": "", "ext": map[string]any{}}
	if !reflect.DeepEqual(you, any(cleared)) {
		t.Fatalf("removal result: %#v", you)
	}
	if notice := b.notification(t, "user"); !reflect.DeepEqual(notice, map[string]any{"new": cleared}) {
		t.Fatalf("removal notification: %#v", notice)
	}
	if users := listRooms(t, b, map[string]any{"room_id": "general"})["users"].([]any); !reflect.DeepEqual(users[0], map[string]any{"user_id": "guest_1", "name": "Ada"}) {
		t.Fatalf("profile after removal: %#v", users[0])
	}
	b.expectQuiet(t)
}

func TestUploadsAreHostedWithOpenGraph(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "a", "b")
	a, b := clients[0], clients[1]
	result := a.result(t, "message", "attach", map[string]any{"room_id": "general", "body": map[string]any{
		"text": "Before the fix:",
		"embeds": []any{
			map[string]any{"kind": "upload", "title": "dots.png", "url": "https://forged.example/x", "og": map[string]any{"image": map[string]any{"alt": "Three dots"}}},
			map[string]any{"kind": "iframe", "url": "https://backend.example/term", "height": 300},
		},
	}})
	written := result["embeds"].([]any)
	if len(written) != 1 {
		t.Fatalf("written embeds: %#v", result)
	}
	write := written[0].(map[string]any)
	embedID, writeURL := write["embed_id"].(string), write["write_url"].(string)
	if write["kind"] != "upload" || !strings.HasPrefix(writeURL, httpServer.URL+writePath) {
		t.Fatalf("write: %#v", write)
	}
	pending := a.notification(t, "message")
	b.notification(t, "message")
	embeds := embedsOf(t, pending)
	if !reflect.DeepEqual(embeds[0], map[string]any{"embed_id": embedID, "kind": "upload", "title": "dots.png"}) || embeds[1]["embed_id"] == nil || embeds[1]["url"] != "https://backend.example/term" {
		t.Fatalf("pending embeds: %#v", embeds)
	}

	image := testPNG(t)
	if status, _, _ := httpDo(t, http.MethodPut, writeURL, bytes.NewReader(image), "image/png"); status != http.StatusCreated {
		t.Fatalf("upload status %d", status)
	}
	completed := a.notification(t, "message")
	b.notification(t, "message")
	upload := embedsOf(t, completed)[0]
	fileURL, _ := upload["url"].(string)
	wantOG := map[string]any{"title": "dots.png", "image": map[string]any{"url": fileURL, "type": "image/png", "width": float64(3), "height": float64(2), "alt": "Three dots"}}
	if !strings.HasPrefix(fileURL, httpServer.URL+filePath+embedID+"/") || !reflect.DeepEqual(upload["og"], any(wantOG)) || completed["prev_log_id"] != pending["log_id"] {
		t.Fatalf("completed upload: %#v", completed)
	}
	status, header, content := httpDo(t, http.MethodGet, fileURL, nil, "")
	if status != http.StatusOK || !bytes.Equal(content, image) || header.Get("Content-Type") != "image/png" ||
		header.Get("X-Content-Type-Options") != "nosniff" || !strings.HasPrefix(header.Get("Content-Security-Policy"), "sandbox") ||
		!strings.HasPrefix(header.Get("Content-Disposition"), "inline") {
		t.Fatalf("file: %d %#v", status, header)
	}
	if status, _, _ := httpDo(t, http.MethodGet, httpServer.URL+filePath+embedID+"/wrong", nil, ""); status != http.StatusNotFound {
		t.Fatalf("wrong secret: %d", status)
	}
	if status, _, _ := httpDo(t, http.MethodPut, writeURL, strings.NewReader("again"), ""); status != http.StatusNotFound {
		t.Fatalf("reused write URL: %d", status)
	}

	// A save keeps an embed by embed_id; the server restores what it owns.
	messageID := result["message_id"].(string)
	kept := []any{
		map[string]any{"embed_id": embedID, "kind": "stream", "title": "renamed.png", "url": "https://forged.example/y"},
		embeds[1],
	}
	_, edited := save(t, a, "keep", map[string]any{"message_id": messageID, "body": map[string]any{"text": "edited", "embeds": kept}})
	b.notification(t, "message")
	restored := embedsOf(t, edited)[0]
	if restored["kind"] != "upload" || restored["url"] != fileURL || !reflect.DeepEqual(restored["og"], any(wantOG)) || restored["title"] != "renamed.png" {
		t.Fatalf("restored embed: %#v", restored)
	}
	a.expectError(t, "message", "unknown", map[string]any{"message_id": messageID, "room_id": "general", "body": map[string]any{"embeds": []any{map[string]any{"embed_id": "embed_999", "kind": "upload"}}}}, codeInvalidParams)

	// Removing the embed deletes its content.
	save(t, a, "remove", map[string]any{"message_id": messageID, "body": map[string]any{"text": "no file"}})
	b.notification(t, "message")
	if status, _, _ := httpDo(t, http.MethodGet, fileURL, nil, ""); status != http.StatusNotFound {
		t.Fatalf("removed file: %d", status)
	}
}

func TestFailedAndExpiredWritesDropTheEmbed(t *testing.T) {
	config := DefaultConfig()
	config.MaxUploadBytes = 4
	config.UploadStartTimeout = 100 * time.Millisecond
	_, httpServer := newTestServer(t, config)
	a := dialTestClient(t, httpServer, "a", false)
	result := a.result(t, "message", "two", map[string]any{"room_id": "general", "body": map[string]any{
		"embeds": []any{map[string]any{"kind": "upload"}, map[string]any{"kind": "stream"}},
	}})
	a.notification(t, "message")
	written := result["embeds"].([]any)
	large := written[0].(map[string]any)["write_url"].(string)
	if status, _, _ := httpDo(t, http.MethodPut, large, strings.NewReader("too large"), "text/plain"); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized upload: %d", status)
	}
	if left := embedsOf(t, a.notification(t, "message")); len(left) != 1 || left[0]["kind"] != "stream" {
		t.Fatalf("after failed upload: %#v", left)
	}
	// The stream's write URL is never used, so it expires.
	if expired := a.notification(t, "message"); len(embedsOf(t, expired)) != 0 {
		t.Fatalf("after expiry: %#v", expired)
	}
	if status, _, _ := httpDo(t, http.MethodPut, written[1].(map[string]any)["write_url"].(string), strings.NewReader("late"), ""); status != http.StatusNotFound {
		t.Fatalf("expired write URL: %d", status)
	}
}

func TestStreamsGrowLiveThenKeepTheirText(t *testing.T) {
	config := DefaultConfig()
	config.StreamKeepBytes = 16
	config.StreamMaxBytes = 64
	_, httpServer := newTestServer(t, config)
	a := dialTestClient(t, httpServer, "a", false)
	result := a.result(t, "message", "stream", map[string]any{"room_id": "general", "body": map[string]any{
		"embeds": []any{map[string]any{"kind": "stream", "format": "terminal", "text": "forged"}},
	}})
	writeURL := result["embeds"].([]any)[0].(map[string]any)["write_url"].(string)
	live := embedsOf(t, a.notification(t, "message"))[0]
	streamURL, _ := live["url"].(string)
	if !strings.HasPrefix(streamURL, httpServer.URL+streamPath) || live["format"] != "terminal" || live["text"] != nil {
		t.Fatalf("live embed: %#v", live)
	}

	reader, err := http.Get(streamURL)
	if err != nil || reader.StatusCode != http.StatusOK {
		t.Fatalf("stream reader: %v %v", reader, err)
	}
	defer reader.Body.Close()
	body, pipe := io.Pipe()
	writerDone := make(chan int, 1)
	go func() {
		request, _ := http.NewRequest(http.MethodPut, writeURL, body)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			writerDone <- 0
			return
		}
		response.Body.Close()
		writerDone <- response.StatusCode
	}()
	if _, err := pipe.Write([]byte("hello ")); err != nil {
		t.Fatal(err)
	}
	first := make([]byte, 6)
	if _, err := io.ReadFull(reader.Body, first); err != nil || string(first) != "hello " {
		t.Fatalf("live read %q: %v", first, err)
	}
	_, _ = pipe.Write([]byte("world, this is a long line\n"))
	_ = pipe.Close()
	// The second write overflows the 16 kept bytes before the reader catches
	// up, so the reader continues from the kept text.
	rest, _ := io.ReadAll(reader.Body)
	if string(rest) != " is a long line\n" {
		t.Fatalf("reader got %q then %q", first, rest)
	}
	if status := <-writerDone; status != http.StatusNoContent {
		t.Fatalf("writer status %d", status)
	}
	finished := embedsOf(t, a.notification(t, "message"))[0]
	if finished["text"] != " is a long line\n" || finished["url"] != nil || finished["format"] != "terminal" {
		t.Fatalf("finished embed: %#v", finished)
	}
	if status, _, _ := httpDo(t, http.MethodGet, streamURL, nil, ""); status != http.StatusNotFound {
		t.Fatalf("finished stream URL: %d", status)
	}

	// At the size limit the stream ends and keeps its trailing text.
	result = a.result(t, "message", "limited", map[string]any{"room_id": "general", "body": map[string]any{"embeds": []any{map[string]any{"kind": "stream"}}}})
	a.notification(t, "message")
	writeURL = result["embeds"].([]any)[0].(map[string]any)["write_url"].(string)
	if status, _, _ := httpDo(t, http.MethodPut, writeURL, strings.NewReader(strings.Repeat("x", 63)+"é"+strings.Repeat("y", 20)), ""); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized stream: %d", status)
	}
	if text := embedsOf(t, a.notification(t, "message"))[0]["text"]; text != strings.Repeat("x", 15)+"\uFFFD" {
		t.Fatalf("limited text %q", text)
	}
}

// A finished stream write leaves its keep-alive connection usable: a live
// stream read next on the same connection follows the stream.
func TestStreamWriteConnectionCanReadAStream(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	a := dialTestClient(t, httpServer, "a", false)
	result := a.result(t, "message", "streams", map[string]any{"room_id": "general", "body": map[string]any{
		"embeds": []any{map[string]any{"kind": "stream"}, map[string]any{"kind": "stream"}},
	}})
	written := result["embeds"].([]any)
	live := embedsOf(t, a.notification(t, "message"))
	// One connection carries the finished write and then the read.
	client := &http.Client{Transport: &http.Transport{MaxConnsPerHost: 1}}
	response, err := client.Post(written[0].(map[string]any)["write_url"].(string), "text/plain", strings.NewReader("done"))
	if err != nil || response.StatusCode != http.StatusNoContent {
		t.Fatalf("first stream write: %v %v", response, err)
	}
	response.Body.Close()
	reader, err := client.Get(live[1]["url"].(string))
	if err != nil || reader.StatusCode != http.StatusOK {
		t.Fatalf("stream reader: %v %v", reader, err)
	}
	defer reader.Body.Close()
	if status, _, _ := httpDo(t, http.MethodPut, written[1].(map[string]any)["write_url"].(string), strings.NewReader("second"), "text/plain"); status != http.StatusNoContent {
		t.Fatalf("second stream write: %d", status)
	}
	if got, _ := io.ReadAll(reader.Body); string(got) != "second" {
		t.Fatalf("reader on the write's connection got %q", got)
	}
}

func TestSavingWithoutAStreamEndsIt(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	a := dialTestClient(t, httpServer, "a", false)
	result := a.result(t, "message", "stream", map[string]any{"room_id": "general", "body": map[string]any{"embeds": []any{map[string]any{"kind": "stream"}}}})
	a.notification(t, "message")
	writeURL := result["embeds"].([]any)[0].(map[string]any)["write_url"].(string)
	body, pipe := io.Pipe()
	writerDone := make(chan int, 1)
	go func() {
		request, _ := http.NewRequest(http.MethodPost, writeURL, body)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			writerDone <- 0
			return
		}
		response.Body.Close()
		writerDone <- response.StatusCode
	}()
	_, _ = pipe.Write([]byte("partial"))
	save(t, a, "stop", map[string]any{"message_id": result["message_id"], "body": map[string]any{"text": "never mind"}})
	if status := <-writerDone; status != http.StatusGone {
		t.Fatalf("writer status %d", status)
	}
	_ = pipe.Close()
	a.expectQuiet(t)
}

func TestAvatarCommand(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "a", "b")
	a, b := clients[0], clients[1]
	for i, embeds := range []any{nil, []any{}, []any{map[string]any{"kind": "stream"}}, []any{map[string]any{"kind": "upload"}, map[string]any{"kind": "upload"}}} {
		body := map[string]any{"text": "/avatar"}
		if embeds != nil {
			body["embeds"] = embeds
		}
		a.expectError(t, "command", fmt.Sprint("shape-", i), map[string]any{"body": body}, codeInvalidParams)
	}
	result := a.result(t, "command", "avatar", map[string]any{"body": map[string]any{"text": "/avatar", "embeds": []any{map[string]any{"kind": "upload", "title": "me.png"}}}})
	written := result["embeds"].([]any)
	if len(result) != 1 || len(written) != 1 {
		t.Fatalf("avatar result: %#v", result)
	}
	write := written[0].(map[string]any)
	writeURL := write["write_url"].(string)
	if write["kind"] != "upload" || write["embed_id"] == nil || !strings.HasPrefix(writeURL, httpServer.URL+writePath) {
		t.Fatalf("avatar write: %#v", write)
	}
	// A command is never logged or broadcast.
	a.expectQuiet(t)
	b.expectQuiet(t)
	if status, _, _ := httpDo(t, http.MethodPut, writeURL, bytes.NewReader(testPNG(t)), ""); status != http.StatusCreated {
		t.Fatalf("avatar upload: %d", status)
	}
	you := a.notification(t, "user")["you"].(map[string]any)
	avatar, _ := you["avatar"].(string)
	if !strings.HasPrefix(avatar, httpServer.URL+filePath) {
		t.Fatalf("avatar: %#v", you)
	}
	if notice := b.notification(t, "user")["new"].(map[string]any); notice["avatar"] != avatar {
		t.Fatalf("others' notification: %#v", notice)
	}
	if status, _, _ := httpDo(t, http.MethodGet, avatar, nil, ""); status != http.StatusOK {
		t.Fatalf("avatar file: %d", status)
	}
	if page := historyPage(t, a, "general", map[string]any{}); len(page["entries"].([]any)) != 0 {
		t.Fatalf("command was logged: %#v", page)
	}

	// Only images become avatars; replacing the avatar deletes the upload.
	result = a.result(t, "command", "text", map[string]any{"body": map[string]any{"text": "/avatar", "embeds": []any{map[string]any{"kind": "upload"}}}})
	writeURL = result["embeds"].([]any)[0].(map[string]any)["write_url"].(string)
	if status, _, _ := httpDo(t, http.MethodPut, writeURL, strings.NewReader("plain text"), "text/plain"); status != http.StatusUnsupportedMediaType {
		t.Fatalf("text avatar: %d", status)
	}
	a.result(t, "me", "clear", map[string]any{"avatar": ""})
	b.notification(t, "user")
	if status, _, _ := httpDo(t, http.MethodGet, avatar, nil, ""); status != http.StatusNotFound {
		t.Fatalf("replaced avatar file: %d", status)
	}
}

func TestCommands(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "a", "b", "c")
	a, b, c := clients[0], clients[1], clients[2]
	ops, _ := saveRoom(t, a, "ops", map[string]any{"title": "Ops"})
	joinRoom(t, b, ops)
	expectJoin(t, a, ops)
	joinRoom(t, c, ops)
	expectJoin(t, a, ops)
	expectJoin(t, b, ops)

	// /help replies with a @private notice to the sender's connection, in
	// the command's room, listing what the sender may use there.
	help := func(client *testClient, roomID string) string {
		t.Helper()
		params := map[string]any{"body": map[string]any{"text": "/help"}}
		if roomID != "" {
			params["room_id"] = roomID
		} else {
			roomID = "general"
		}
		if result := client.result(t, "command", fmt.Sprint("help-", time.Now().UnixNano()), params); len(result) != 0 {
			t.Fatalf("help result: %#v", result)
		}
		notice := client.notification(t, "message")
		body := notice["body"].(map[string]any)
		if _, has := notice["message_id"]; has || notice["log_id"] != nil || notice["room_id"] != roomID || body["format"] != "markdown" ||
			!reflect.DeepEqual(notice["from"], map[string]any{"user_id": "@private", "name": "Only you"}) {
			t.Fatalf("help notice: %#v", notice)
		}
		return body["text"].(string)
	}
	if text := help(a, ops); !strings.Contains(text, "`/help`") || !strings.Contains(text, "`/avatar`") || !strings.Contains(text, "`/kick @user [reason]`") {
		t.Fatalf("creator's help: %q", text)
	}
	if text := help(b, ""); strings.Contains(text, "/kick") || !strings.Contains(text, "/avatar") {
		t.Fatalf("member's help: %q", text)
	}
	for _, client := range clients {
		client.expectQuiet(t)
	}

	// Invalid commands are errors whose message the client shows.
	unknown := b.call(t, "command", "unknown", map[string]any{"body": map[string]any{"text": "/Frobnicate now"}})
	if failure := unknown["error"].(map[string]any); failure["code"] != float64(codeInvalidParams) || failure["message"] != "Unknown command /Frobnicate; try /help" {
		t.Fatalf("unknown command: %#v", unknown)
	}
	for i, params := range []map[string]any{
		{"body": map[string]any{"text": "hello"}},
		{"body": map[string]any{"text": ""}},
		{"message_id": "1", "body": map[string]any{"text": "/help"}},
		{"deleted": false, "body": map[string]any{"text": "/help"}},
		{"room_id": "missing", "body": map[string]any{"text": "/help"}},
		{"body": map[string]any{"text": "/help"}, "reply_to": map[string]any{"message_id": "999"}},
		{"body": map[string]any{"text": "/help", "mentions": "x"}},
		{},
	} {
		b.expectError(t, "command", fmt.Sprint("bad-", i), params, codeInvalidParams)
	}

	// /kick is for the room's creator, and names its target in mentions,
	// which notifies no one.
	kick := map[string]any{"room_id": ops, "body": map[string]any{"text": "/kick @guest_3 spamming", "mentions": []any{"guest_3"}}}
	b.expectError(t, "command", "not-creator", kick, codeDenied)
	a.expectError(t, "command", "general", map[string]any{"body": map[string]any{"text": "/kick @guest_3", "mentions": []any{"guest_3"}}}, codeDenied)
	a.expectError(t, "command", "no-target", map[string]any{"room_id": ops, "body": map[string]any{"text": "/kick guest_3"}}, codeInvalidParams)
	a.expectError(t, "command", "self", map[string]any{"room_id": ops, "body": map[string]any{"text": "/kick @guest_1", "mentions": []any{"guest_1"}}}, codeInvalidParams)
	a.expectError(t, "command", "not-member", map[string]any{"room_id": ops, "body": map[string]any{"text": "/kick @nobody", "mentions": []any{"nobody"}}}, codeInvalidParams)
	for _, client := range clients {
		client.expectQuiet(t)
	}
	if result := a.result(t, "command", "kick", kick); len(result) != 0 {
		t.Fatalf("kick result: %#v", result)
	}
	if left := roomUpdated(t, c, "left"); !reflect.DeepEqual(left, map[string]any{"room_id": ops}) {
		t.Fatalf("kicked user's update: %#v", left)
	}
	var notice map[string]any
	for _, member := range []*testClient{a, b} {
		expectLeave(t, member, ops, "guest_3")
		notice = member.notification(t, "message")
	}
	want := map[string]any{
		"message_id": notice["message_id"], "log_id": notice["message_id"], "room_id": ops,
		"from": map[string]any{"user_id": "@room", "name": "Ops"},
		"body": map[string]any{"text": "@guest_3 was removed by @guest_1: spamming"},
	}
	if !reflect.DeepEqual(notice, want) {
		t.Fatalf("@room notice = %#v, want %#v", notice, want)
	}
	c.expectQuiet(t)
	// The notice is logged; the command is not.
	if entries := historyPage(t, a, ops, map[string]any{})["entries"].([]any); len(entries) != 1 || !reflect.DeepEqual(entries[0], any(notice)) {
		t.Fatalf("ops history: %#v", entries)
	}
	// A retried command does not run again.
	if result := a.result(t, "command", "kick", kick); len(result) != 0 {
		t.Fatalf("retried kick: %#v", result)
	}
	for _, client := range clients {
		client.expectQuiet(t)
	}
}

type relayRequest struct {
	path          string
	authorization string
	payload       map[string]any
}

func TestPushWakesMentionedUsersWhoAreAway(t *testing.T) {
	received := make(chan relayRequest, 16)
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		received <- relayRequest{path: r.URL.Path, authorization: r.Header.Get("Authorization"), payload: payload}
		if r.URL.Path == "/gone" {
			w.WriteHeader(http.StatusGone)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer relay.Close()
	config := DefaultConfig()
	config.AllowInsecurePush = true
	app, httpServer := newTestServer(t, config)
	clients := dialGroup(t, httpServer, "a", "b")
	a, b := clients[0], clients[1]
	a.result(t, "push_register", "register", map[string]any{"kind": "relay", "url": relay.URL + "/a", "token": "secret"})
	a.expectError(t, "push_register", "kind", map[string]any{"kind": "webpush", "url": relay.URL + "/a"}, codeInvalidParams)
	a.expectError(t, "push_register", "scheme", map[string]any{"kind": "relay", "url": "ftp://relay.example/a"}, codeInvalidParams)
	a.result(t, "push_unregister", "unregister", map[string]any{"url": relay.URL + "/a"})

	// Push reaches users without a connection, such as a passkey user who is
	// away, in rooms they have joined.
	app.mu.Lock()
	alice := newUserState("alice", "Alice")
	alice.passkey = &passkeyUser{user: alice}
	app.users[alice.id] = alice
	app.addMemberLocked(alice, app.rooms[defaultRoomID])
	app.pushes[relay.URL+"/alice"] = &pushRegistration{userID: "alice", kind: "relay", url: relay.URL + "/alice", token: "tok"}
	app.pushes[relay.URL+"/gone"] = &pushRegistration{userID: "alice", kind: "relay", url: relay.URL + "/gone"}
	app.mu.Unlock()
	expectJoin(t, a, "general")
	expectJoin(t, b, "general")
	pushes := func() []relayRequest {
		t.Helper()
		a.expectQuiet(t) // Requests before this one have finished waking users.
		app.push.wait()
		var requests []relayRequest
		for len(received) > 0 {
			requests = append(requests, <-received)
		}
		return requests
	}
	post := func(id string, params map[string]any) string {
		t.Helper()
		messageID, _ := save(t, a, id, params)
		b.notification(t, "message")
		return messageID
	}

	// Only body.mentions decides who is mentioned; text is never parsed.
	text := "@alice: the deploy is done"
	id := post("text", map[string]any{"body": map[string]any{"text": text, "format": "markdown"}})
	if got := pushes(); len(got) != 0 {
		t.Fatalf("text mention woke %d", len(got))
	}
	// An edit mentions the users it adds.
	post("add-mention", map[string]any{"message_id": id, "body": map[string]any{"text": text, "mentions": []any{"alice"}}})
	got := pushes()
	if len(got) != 2 {
		t.Fatalf("relay received %d requests, want one per registration", len(got))
	}
	for _, request := range got {
		want := map[string]any{"message_id": id, "room_id": "general", "from": map[string]any{"user_id": "guest_1"}, "body": map[string]any{"text": text}}
		if !reflect.DeepEqual(request.payload, want) {
			t.Fatalf("payload: %#v", request.payload)
		}
		if request.path == "/alice" && request.authorization != "Bearer tok" {
			t.Fatalf("authorization: %q", request.authorization)
		}
	}
	// A relay that answers 410 loses its registration.
	app.mu.RLock()
	_, kept := app.pushes[relay.URL+"/gone"]
	app.mu.RUnlock()
	if kept {
		t.Fatal("gone registration was kept")
	}
	post("same-mention", map[string]any{"message_id": id, "body": map[string]any{"text": "edited", "mentions": []any{"alice"}}})
	if got := pushes(); len(got) != 0 {
		t.Fatalf("an edit re-mentioned: %d", len(got))
	}

	// A connected user is woken only when every connection is away.
	b.result(t, "push_register", "b", map[string]any{"kind": "relay", "url": relay.URL + "/b"})
	mentionB := map[string]any{"body": map[string]any{"text": "@guest_2 ping", "mentions": []any{"guest_2"}}}
	post("attending", maps.Clone(mentionB))
	if got := pushes(); len(got) != 0 {
		t.Fatalf("attending user woken: %d", len(got))
	}
	b.write(t, map[string]any{"method": "activity", "params": map[string]any{"away": true}})
	b.expectQuiet(t)
	post("away", maps.Clone(mentionB))
	if got := pushes(); len(got) != 1 || got[0].path != "/b" {
		t.Fatalf("away user: %#v", got)
	}
	// Typing ends away.
	b.write(t, map[string]any{"method": "activity", "params": map[string]any{"room_id": "general", "typing": 3}})
	a.notification(t, "activity")
	b.notification(t, "activity")
	post("back", maps.Clone(mentionB))
	if got := pushes(); len(got) != 0 {
		t.Fatalf("user back from away woken: %d", len(got))
	}
	// A reply wakes the author of the message it replies to.
	own, _ := save(t, b, "own", map[string]any{"body": map[string]any{"text": "mine"}})
	a.notification(t, "message")
	b.write(t, map[string]any{"method": "activity", "params": map[string]any{"away": true}})
	b.expectQuiet(t)
	post("reply", map[string]any{"body": map[string]any{"text": "a reply"}, "reply_to": map[string]any{"message_id": own}})
	if got := pushes(); len(got) != 1 {
		t.Fatalf("reply woke %d", len(got))
	}
	// Only rooms the user has joined wake them; mentions in commands notify
	// no one.
	ops, _ := saveRoom(t, a, "ops", map[string]any{"title": "Ops"})
	save(t, a, "elsewhere", map[string]any{"room_id": ops, "body": map[string]any{"text": "@guest_2", "mentions": []any{"guest_2"}}})
	a.result(t, "command", "help", map[string]any{"body": map[string]any{"text": "/help", "mentions": []any{"guest_2"}}})
	a.notification(t, "message")
	if got := pushes(); len(got) != 0 {
		t.Fatalf("unjoined room or command woke %d", len(got))
	}
}

func TestPushRefusesInternalAddresses(t *testing.T) {
	var hits int
	relay := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits++ }))
	defer relay.Close()
	deliverer := newPushDeliverer(false)
	called := false
	deliverer.deliver(pushRegistration{url: relay.URL}, []byte("{}"), func(bool) { called = true })
	deliverer.wait()
	if hits != 0 || called {
		t.Fatalf("delivered to a loopback address: hits=%d called=%v", hits, called)
	}
	app := New(DefaultConfig())
	if problem := app.checkPushURL("http://relay.example/p"); problem == "" {
		t.Fatal("http push URL accepted without AllowInsecurePush")
	}
}

func TestConnectionAndRateLimits(t *testing.T) {
	config := DefaultConfig()
	config.MaxConnections = 1
	config.MessagesPerMinute = 2
	_, httpServer := newTestServer(t, config)
	a := dialTestClient(t, httpServer, "a", false)

	// Over capacity: the server frame, then an error without id, then close.
	b, _ := dialRaw(t, httpServer)
	failure := b.read(t)
	if _, has := failure["id"]; has || failure["error"].(map[string]any)["code"] != float64(codeRetryAfter) ||
		failure["error"].(map[string]any)["data"].(map[string]any)["retry_after"] != float64(retryAfterSeconds) {
		t.Fatalf("capacity error: %#v", failure)
	}

	save(t, a, "one", map[string]any{"body": map[string]any{"text": "1"}})
	save(t, a, "two", map[string]any{"body": map[string]any{"text": "2"}})
	frame := a.call(t, "message", "three", map[string]any{"room_id": "general", "body": map[string]any{"text": "3"}})
	limited := frame["error"].(map[string]any)
	if limited["code"] != float64(codeRetryAfter) || limited["data"].(map[string]any)["retry_after"].(float64) < 1 {
		t.Fatalf("rate limit: %#v", frame)
	}
}
