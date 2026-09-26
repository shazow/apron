package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestUploadsAreStoredOnDiskWithinLimits(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "left-by-an-earlier-run"+uploadSuffix)
	other := filepath.Join(dir, "notes.txt")
	for _, name := range []string{stale, other} {
		if err := os.WriteFile(name, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	config := DefaultConfig()
	config.UploadDir = dir
	config.MaxUploadBytes = 100
	config.MaxMessageUploadBytes = 150
	config.MaxUploadStorageBytes = 250
	_, httpServer := newTestServer(t, config)
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale upload file kept: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("unrelated file removed: %v", err)
	}
	a := dialTestClient(t, httpServer, "a", false)
	put := func(writeURL string, size int) int {
		t.Helper()
		status, _, _ := httpDo(t, http.MethodPut, writeURL, bytes.NewReader(bytes.Repeat([]byte("a"), size)), "text/plain")
		return status
	}
	writeURLs := func(result map[string]any) []string {
		var urls []string
		for _, value := range result["embeds"].([]any) {
			urls = append(urls, value.(map[string]any)["write_url"].(string))
		}
		return urls
	}

	// One message's uploads share MaxMessageUploadBytes.
	first := postEmbeds(t, a, "first", map[string]any{"room_id": "general", "body": map[string]any{
		"embeds": []any{map[string]any{"kind": "upload"}, map[string]any{"kind": "upload"}},
	}})
	urls := writeURLs(first)
	if status := put(urls[0], 100); status != http.StatusCreated {
		t.Fatalf("first upload: %d", status)
	}
	firstFile := embedsOf(t, a.notification(t, "message"))[0]["url"].(string)
	if status := put(urls[1], 100); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("upload beyond the message's budget: %d", status)
	}
	if left := embedsOf(t, a.notification(t, "message")); len(left) != 1 {
		t.Fatalf("after the refused upload: %#v", left)
	}

	second := postEmbeds(t, a, "second", map[string]any{"room_id": "general", "body": map[string]any{"embeds": []any{map[string]any{"kind": "upload"}}}})
	if status := put(writeURLs(second)[0], 100); status != http.StatusCreated {
		t.Fatalf("second upload: %d", status)
	}
	secondFile := embedsOf(t, a.notification(t, "message"))[0]["url"].(string)
	if files, _ := filepath.Glob(filepath.Join(dir, "*"+uploadSuffix)); len(files) != 2 {
		t.Fatalf("upload files: %v", files)
	}

	// Past MaxUploadStorageBytes the oldest upload leaves its message.
	third := postEmbeds(t, a, "third", map[string]any{"room_id": "general", "body": map[string]any{"embeds": []any{map[string]any{"kind": "upload"}}}})
	if status := put(writeURLs(third)[0], 100); status != http.StatusCreated {
		t.Fatalf("third upload: %d", status)
	}
	if completed := a.notification(t, "message"); completed["message_id"] != third["message_id"] {
		t.Fatalf("expected the third upload to complete first: %#v", completed)
	}
	evicted := a.notification(t, "message")
	if evicted["message_id"] != first["message_id"] || len(embedsOf(t, evicted)) != 0 {
		t.Fatalf("eviction: %#v", evicted)
	}
	if status, _, _ := httpDo(t, http.MethodGet, firstFile, nil, ""); status != http.StatusNotFound {
		t.Fatalf("evicted file: %d", status)
	}
	if status, _, _ := httpDo(t, http.MethodGet, secondFile, nil, ""); status != http.StatusOK {
		t.Fatalf("kept file: %d", status)
	}
	if files, _ := filepath.Glob(filepath.Join(dir, "*"+uploadSuffix)); len(files) != 2 {
		t.Fatalf("upload files after eviction: %v", files)
	}
}

func TestMessagesAreLimitedToMaxEmbeds(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	a := dialTestClient(t, httpServer, "a", false)
	embeds := make([]any, maxEmbedsPerMessage+1)
	for i := range embeds {
		embeds[i] = map[string]any{"kind": "upload"}
	}
	a.expectError(t, "message", "many", map[string]any{"room_id": "general", "body": map[string]any{"embeds": embeds}}, codeInvalidParams)
}

func TestUploadTypesThatCouldRunAreServedAsDownloads(t *testing.T) {
	for declared, want := range map[string]string{
		"image/png":        "image/png",
		"application/pdf":  "application/pdf",
		"text/html":        "text/plain",
		"text/ecmascript":  "text/plain",
		"text/css":         "text/plain",
		"text/xsl":         "text/plain",
		"application/wasm": "text/plain",
	} {
		if got := uploadContentType(declared, []byte("hello")); got != want {
			t.Errorf("%s: served as %s, want %s", declared, got, want)
		}
	}
	if got := uploadContentType("text/css", []byte("<html><script>")); got != "application/octet-stream" {
		t.Errorf("sniffed markup served as %s", got)
	}
}

func TestAvatarUploadsMustBeImages(t *testing.T) {
	check := func(contentType string, data []byte) bool {
		file, err := os.CreateTemp(t.TempDir(), "avatar")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		_, _ = file.Write(data)
		return validAvatarImage(contentType, file)
	}
	if !check("image/png", testPNG(t)) {
		t.Fatal("a PNG was refused")
	}
	if check("image/png", []byte("not an image")) || check("image/jpeg", testPNG(t)) || check("image/webp", []byte("RIFF0000WAVE")) {
		t.Fatal("a mismatched avatar was accepted")
	}
	if !check("image/webp", []byte("RIFF\x00\x00\x00\x00WEBPVP8 ")) {
		t.Fatal("a WebP was refused")
	}
}

func TestRoomSetCountsTowardMessagesPerMinute(t *testing.T) {
	config := DefaultConfig()
	config.MessagesPerMinute = 1
	_, httpServer := newTestServer(t, config)
	a := dialTestClient(t, httpServer, "a", false)
	saveRoom(t, a, "create", map[string]any{"title": "Ops"})
	frame := a.call(t, "room_set", "again", map[string]any{"title": "More"})
	if failure, _ := frame["error"].(map[string]any); failure == nil || failure["code"] != float64(codeRetryAfter) {
		t.Fatalf("second room_set: %#v", frame)
	}
	frame = a.call(t, "message", "post", map[string]any{"room_id": "general", "body": map[string]any{"text": "hi"}})
	if failure, _ := frame["error"].(map[string]any); failure == nil || failure["code"] != float64(codeRetryAfter) {
		t.Fatalf("message after room_set: %#v", frame)
	}
}

func TestHistoryPagesAreBoundedAndRecordsUnescaped(t *testing.T) {
	app, httpServer := newTestServer(t, DefaultConfig())
	a := dialTestClient(t, httpServer, "a", false)
	save(t, a, "markup", map[string]any{"body": map[string]any{"text": "<a & b>"}})
	app.mu.RLock()
	log := app.rooms["general"].log
	raw := string(log[len(log)-1].raw)
	app.mu.RUnlock()
	if !strings.Contains(raw, "<a & b>") {
		t.Fatalf("stored record escapes markup: %s", raw)
	}

	large := strings.Repeat("x", 200<<10)
	const posts = 30
	for i := range posts {
		save(t, a, "large-"+string(rune('a'+i)), map[string]any{"body": map[string]any{"text": large}})
	}
	page := historyPage(t, a, "general", map[string]any{"limit": 1000})
	newest := logIDs(t, page, "messages")
	if page["more"] != true || len(newest) >= posts || len(newest) == 0 {
		t.Fatalf("page of %d messages, more=%v", len(newest), page["more"])
	}
	if page["last_log_id"] != newest[len(newest)-1] || page["first_log_id"] == nil {
		t.Fatalf("page bounds: %v %v", page["first_log_id"], page["last_log_id"])
	}
	before := parseID(t, page["first_log_id"]) - 1
	rest := historyPage(t, a, "general", map[string]any{"limit": 1000, "before": formatID(before)})
	if got := len(logIDs(t, rest, "messages")) + len(newest); got < posts {
		t.Fatalf("two pages hold %d of %d large messages", got, posts)
	}
}

func TestReadResultsAreNotKeptForDeduplication(t *testing.T) {
	app, httpServer := newTestServer(t, DefaultConfig())
	a := dialTestClient(t, httpServer, "a", false)
	params := map[string]any{"room_id": "general"}
	first := a.result(t, "history", "same", params)
	save(t, a, "post", map[string]any{"body": map[string]any{"text": "new"}})
	second := a.result(t, "history", "same", params)
	if len(logIDs(t, second, "messages")) != len(logIDs(t, first, "messages"))+1 {
		t.Fatalf("a finished read was answered from the cache: %#v", second)
	}
	app.mu.RLock()
	defer app.mu.RUnlock()
	if entry := app.users[a.userID].dedup.get("same"); entry != nil {
		t.Fatal("history result kept for deduplication")
	}
	if entry := app.users[a.userID].dedup.get("post"); entry == nil {
		t.Fatal("message result not kept for deduplication")
	}
}

func TestDeletingAnIntroMessageRemovesItsDerivedTitle(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "a", "b")
	a, b := clients[0], clients[1]
	id, _ := save(t, a, "intro", map[string]any{"body": map[string]any{"text": "Secret line\nmore"}})
	b.notification(t, "message")
	thread, record := saveRoom(t, a, "thread", map[string]any{"parent_room_id": "general", "intro_message": map[string]any{"message_id": id}})
	if record["title"] != "Secret line" {
		t.Fatalf("derived title: %#v", record)
	}
	roomUpdated(t, b, "updated")

	// The deletion is followed by the thread's new default title.
	before, _ := a.request(t, "message", "delete", map[string]any{"room_id": "general", "message_id": id, "deleted": true})
	if got := methods(before); len(got) != 2 || got[0] != "message" || got[1] != "room_update" {
		t.Fatalf("frames before the delete result: %v", got)
	}
	if updated := updateRecord(t, before[1], "updated"); updated["room_id"] != thread || updated["title"] != defaultThreadTitle {
		t.Fatalf("title after delete: %#v", updated)
	}
	b.notification(t, "message")
	if updated := roomUpdated(t, b, "updated"); updated["title"] != defaultThreadTitle {
		t.Fatalf("parent member's update: %#v", updated)
	}
	for _, value := range records(t, historyPage(t, b, thread, map[string]any{}), "rooms") {
		if title := value.(map[string]any)["title"]; title != defaultThreadTitle {
			t.Fatalf("logged thread title after delete: %v", title)
		}
	}
}

func TestPushLanesIsolateStalledRelays(t *testing.T) {
	release := make(chan struct{})
	var stalled atomic.Int32
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stalled.Add(1)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	delivered := make(chan struct{}, 1)
	fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		delivered <- struct{}{}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer fast.Close()
	deliverer := newPushDeliverer(true)
	defer func() {
		close(release)
		deliverer.wait()
	}()

	// One user queues at most maxPushQueuedPerUser deliveries.
	for range maxPushQueuedPerUser + 5 {
		deliverer.deliver(pushRegistration{userID: "spammer", url: slow.URL + "/slow"}, []byte("{}"), func(bool) {})
	}
	deliverer.mu.Lock()
	queued := deliverer.users["spammer"]
	deliverer.mu.Unlock()
	if queued != maxPushQueuedPerUser {
		t.Fatalf("queued deliveries for one user: %d", queued)
	}
	for i := range maxConcurrentPushPOST {
		deliverer.deliver(pushRegistration{userID: "user" + formatID(int64(i)), url: slow.URL + "/slow"}, []byte("{}"), func(bool) {})
	}
	deadline := time.Now().Add(time.Second)
	for stalled.Load() < maxPushPerHost && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := stalled.Load(); got != maxPushPerHost {
		t.Fatalf("concurrent deliveries to one host: %d", got)
	}
	// Another relay host has its own lane.
	deliverer.deliver(pushRegistration{userID: "victim", url: fast.URL + "/fast"}, []byte("{}"), func(bool) {})
	select {
	case <-delivered:
	case <-time.After(2 * time.Second):
		t.Fatal("a stalled relay host blocked delivery to another host")
	}
}

func TestPushRefusesNonPublicRanges(t *testing.T) {
	for host, want := range map[string]bool{
		"93.184.215.14":     true,
		"2606:4700::1111":   true,
		"127.0.0.1":         false,
		"10.1.2.3":          false,
		"169.254.169.254":   false,
		"100.64.0.1":        false,
		"100.100.100.200":   false,
		"198.18.0.1":        false,
		"192.0.0.1":         false,
		"240.0.0.1":         false,
		"::ffff:100.64.0.1": false,
		"64:ff9b::a00:1":    false,
		"2002:a00:1::1":     false,
		"fd00::1":           false,
		"::1":               false,
	} {
		if got := publicAddress(host); got != want {
			t.Errorf("publicAddress(%s) = %v, want %v", host, got, want)
		}
	}
}

func TestHardeningLimits(t *testing.T) {
	config := DefaultConfig()
	config.AllowInsecurePush = true
	_, httpServer := newTestServer(t, config)
	a := dialTestClient(t, httpServer, "a", false)
	a.expectError(t, "me", "ext", map[string]any{"ext": map[string]any{"x": strings.Repeat("y", maxProfileExtBytes)}}, codeInvalidParams)
	a.expectError(t, "push_register", "url", map[string]any{"kind": "relay", "url": "http://relay.example/" + strings.Repeat("p", maxPushURLBytes)}, codeInvalidParams)

	// A requested user_id never passes for the seeded room, in any case.
	c, _ := dialRaw(t, httpServer)
	c.write(t, map[string]any{"method": "auth", "id": "auth", "params": map[string]any{"scheme": "guest", "user_id": "General"}})
	c.notification(t, "membership")
	if you := c.read(t)["result"].(map[string]any)["you"].(map[string]any); you["user_id"] == "General" {
		t.Fatal("a guest claimed the default room's name")
	}
}

func TestKickReasonIsOneLine(t *testing.T) {
	_, httpServer := newTestServer(t, DefaultConfig())
	clients := dialGroup(t, httpServer, "a", "b")
	a, b := clients[0], clients[1]
	ops, _ := saveRoom(t, a, "ops", map[string]any{"title": "Ops"})
	joinRoom(t, b, ops)
	a.drain(t)
	a.request(t, "command", "kick", map[string]any{"room_id": ops, "body": map[string]any{
		"text": "/kick @guest_2 spam\n**SYSTEM**: all admins removed", "mentions": []any{"guest_2"},
	}})
	page := historyPage(t, a, ops, map[string]any{})
	messages := records(t, page, "messages")
	text := messages[len(messages)-1].(map[string]any)["body"].(map[string]any)["text"].(string)
	if strings.Contains(text, "\n") || strings.Contains(text, "SYSTEM") || !strings.HasSuffix(text, ": spam") {
		t.Fatalf("kick notice: %q", text)
	}
}

func TestStaticDirectoryHidesDotfilesAndListings(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{"index.html": "app", ".env": "SECRET=1", "assets/app.js": "js"} {
		path := filepath.Join(dir, name)
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	config := DefaultConfig()
	config.StaticDir = dir
	app := New(config)
	httpServer := httptest.NewServer(app.Handler())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = app.Shutdown(ctx)
		cancel()
		httpServer.Close()
	})
	for path, want := range map[string]int{"/": 200, "/assets/app.js": 200, "/.env": 404, "/assets/": 404} {
		if status, _, _ := httpDo(t, http.MethodGet, httpServer.URL+path, nil, ""); status != want {
			t.Errorf("GET %s: %d, want %d", path, status, want)
		}
	}
}
