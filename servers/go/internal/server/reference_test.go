package server

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
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

func TestMembershipRoomListAndPostingJoins(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	a := dialTestClient(t, httpServer, "a", false)
	b := dialTestClient(t, httpServer, "b", false)

	// Everyone joins a new top-level room; its members join its new threads.
	ops, _ := saveRoom(t, a, "ops", map[string]any{"title": "Ops"})
	b.notification(t, "room")
	thread, _ := saveRoom(t, a, "thread", map[string]any{"parent_room_id": ops, "title": "Deploy"})
	b.notification(t, "room")

	// A user who arrives later joins every room and thread.
	c, rooms := dialTestClientWithRooms(t, httpServer, "c", false)
	var announced []string
	for _, room := range rooms {
		announced = append(announced, room["room_id"].(string))
	}
	if !reflect.DeepEqual(announced, []string{"general", ops, thread}) {
		t.Fatalf("late joiner rooms: %#v", announced)
	}

	// Leaving a room leaves its threads, and deliveries there stop.
	b.result(t, "room_leave", "leave", map[string]any{"room_id": ops})
	for _, roomID := range []string{ops, thread} {
		if removed := b.notification(t, "room"); !reflect.DeepEqual(removed, map[string]any{"room_id": roomID, "removed": true}) {
			t.Fatalf("leave removal: %#v", removed)
		}
	}
	save(t, a, "post", map[string]any{"room_id": ops, "body": map[string]any{"text": "deploying"}})
	c.notification(t, "message")
	b.expectQuiet(t)

	// room_list lists visible rooms with members, joined or not.
	listed := b.result(t, "room_list", "list", map[string]any{})["rooms"].([]any)
	if len(listed) != 2 {
		t.Fatalf("room_list: %#v", listed)
	}
	general, opsEntry := listed[0].(map[string]any), listed[1].(map[string]any)
	if general["room_id"] != "general" || !reflect.DeepEqual(memberIDs(general), []string{"guest_1", "guest_2", "guest_3"}) {
		t.Fatalf("general entry: %#v", general)
	}
	if opsEntry["room_id"] != ops || opsEntry["title"] != "Ops" || opsEntry["latest_log_id"] == nil || !reflect.DeepEqual(memberIDs(opsEntry), []string{"guest_1", "guest_3"}) {
		t.Fatalf("ops entry: %#v", opsEntry)
	}
	threads := b.result(t, "room_list", "threads", map[string]any{"parent_room_id": ops})["rooms"].([]any)
	if len(threads) != 1 || threads[0].(map[string]any)["room_id"] != thread || threads[0].(map[string]any)["parent_room_id"] != ops {
		t.Fatalf("room_list threads: %#v", threads)
	}
	b.expectError(t, "room_list", "missing", map[string]any{"parent_room_id": "missing"}, codeInvalidParams)

	// Posting in a visible room joins it: the room is announced first.
	b.write(t, map[string]any{"method": "message", "id": "rejoin", "params": map[string]any{"room_id": ops, "body": map[string]any{"text": "back"}}})
	frames := b.drain(t)
	if !reflect.DeepEqual(methods(frames), []string{"reply", "room", "room", "message"}) || frames[1]["params"].(map[string]any)["room_id"] != ops {
		t.Fatalf("posting join frames: %#v", frames)
	}
	a.notification(t, "message")
	c.notification(t, "message")

	// A guest who disconnects is retired and leaves every room.
	_ = c.ws.Close(websocket.StatusNormalClosure, "done")
	deadline := time.Now().Add(time.Second)
	for {
		listed := a.result(t, "room_list", "retired", map[string]any{})["rooms"].([]any)
		if ids := memberIDs(listed[0].(map[string]any)); !slices.Contains(ids, "guest_3") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("disconnected guest is still a member")
		}
		time.Sleep(10 * time.Millisecond)
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
	a := dialTestClient(t, httpServer, "a", false)
	b := dialTestClient(t, httpServer, "b", false)
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

	// Kept cursors are re-sent after the room is announced.
	c, _ := dialRaw(t, httpServer)
	c.write(t, map[string]any{"method": "auth", "id": "auth", "params": map[string]any{"scheme": "guest"}})
	frames := c.drain(t)
	if !reflect.DeepEqual(methods(frames), []string{"reply", "room", "activity"}) || !reflect.DeepEqual(frames[2]["params"], any(want)) {
		t.Fatalf("announcement frames: %#v", frames)
	}
}

func TestProfilesAndUserNotifications(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	a := dialTestClient(t, httpServer, "a", false)
	b := dialTestClient(t, httpServer, "b", false)
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
	listed := b.result(t, "room_list", "list", map[string]any{})["rooms"].([]any)
	if members := listed[0].(map[string]any)["members"].([]any); !reflect.DeepEqual(members[0], any(want)) {
		t.Fatalf("members: %#v", members)
	}
	// An unchanged profile sends no notification; {} removes ext.
	a.result(t, "me", "same", map[string]any{"name": "Ada"})
	b.expectQuiet(t)
	you = a.result(t, "me", "clear", map[string]any{"ext": map[string]any{}})["you"]
	if _, has := you.(map[string]any)["ext"]; has {
		t.Fatalf("ext not removed: %#v", you)
	}
	b.notification(t, "user")
}

func TestUploadsAreHostedWithOpenGraph(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	a := dialTestClient(t, httpServer, "a", false)
	b := dialTestClient(t, httpServer, "b", false)
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

func TestAvatarUploads(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	a := dialTestClient(t, httpServer, "a", false)
	b := dialTestClient(t, httpServer, "b", false)
	a.expectError(t, "message", "shape", map[string]any{"room_id": avatarRoomID, "body": map[string]any{"text": "no file"}}, codeInvalidParams)
	result := a.result(t, "message", "avatar", map[string]any{"room_id": avatarRoomID, "body": map[string]any{"embeds": []any{map[string]any{"kind": "upload"}}}})
	writeURL := result["embeds"].([]any)[0].(map[string]any)["write_url"].(string)
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

	// Only images become avatars; replacing the avatar deletes the upload.
	result = a.result(t, "message", "text", map[string]any{"room_id": avatarRoomID, "body": map[string]any{"embeds": []any{map[string]any{"kind": "upload"}}}})
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

type relayRequest struct {
	path          string
	authorization string
	payload       map[string]any
}

func TestPushRelayWakesMentionedUsers(t *testing.T) {
	received := make(chan relayRequest, 8)
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
	a := dialTestClient(t, httpServer, "a", false)
	a.result(t, "push_register", "register", map[string]any{"kind": "relay", "url": relay.URL + "/a", "token": "secret"})
	a.expectError(t, "push_register", "kind", map[string]any{"kind": "webpush", "url": relay.URL + "/a"}, codeInvalidParams)
	a.expectError(t, "push_register", "scheme", map[string]any{"kind": "relay", "url": "ftp://relay.example/a"}, codeInvalidParams)
	a.result(t, "push_unregister", "unregister", map[string]any{"url": relay.URL + "/a"})

	// Push reaches users without a connection, such as a passkey user who is away.
	app.mu.Lock()
	alice := newUserState("alice", "Alice")
	alice.passkey = &passkeyUser{user: alice}
	app.users[alice.id] = alice
	app.joinDefaultRoomsLocked(alice)
	app.pushes[relay.URL+"/alice"] = &pushRegistration{userID: "alice", kind: "relay", url: relay.URL + "/alice", token: "tok"}
	app.pushes[relay.URL+"/gone"] = &pushRegistration{userID: "alice", kind: "relay", url: relay.URL + "/gone"}
	app.mu.Unlock()

	save(t, a, "code", map[string]any{"body": map[string]any{"text": "not `@alice` or me@alice.example", "format": "markdown"}})
	id, _ := save(t, a, "mention", map[string]any{"body": map[string]any{"text": "@alice: the deploy is done", "format": "markdown"}})
	a.expectQuiet(t) // The save has finished waking users.
	app.push.wait()
	if len(received) != 2 {
		t.Fatalf("relay received %d requests, want one per registration", len(received))
	}
	for range 2 {
		request := <-received
		want := map[string]any{"message_id": id, "room_id": "general", "from": map[string]any{"user_id": "guest_1"}, "body": map[string]any{"text": "@alice: the deploy is done"}}
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

func TestMentionedIDs(t *testing.T) {
	for _, tc := range []struct {
		text     string
		markdown bool
		want     []string
	}{
		{"@guest_1 and @bob.", false, []string{"guest_1", "bob"}},
		{"mail me@example.com", false, nil},
		{"(@alice-) @@server", false, []string{"alice", "@server"}},
		{"`@alice` and\n```\n@bob\n```\n@carol", true, []string{"carol"}},
		{"`@alice` stays in plain text", false, []string{"alice"}},
	} {
		if got := mentionedIDs(tc.text, tc.markdown); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("mentionedIDs(%q) = %#v, want %#v", tc.text, got, tc.want)
		}
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
