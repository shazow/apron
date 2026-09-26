package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/shazow/apron/servers/go/internal/store"
)

// startWithStore starts a passkey-enabled server on a store and returns a
// function that shuts it down, closing the store.
func startWithStore(t *testing.T, s store.Store, uploadDir string) (*Server, *httptest.Server, func()) {
	t.Helper()
	w, err := webauthn.New(&webauthn.Config{RPID: "localhost", RPDisplayName: "Apron", RPOrigins: []string{testPasskeyOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	config := DefaultConfig()
	config.WebAuthn = w
	config.Store = s
	config.UploadDir = uploadDir
	app, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(app.Handler())
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
		httpServer.Close()
	}
	t.Cleanup(stop)
	return app, httpServer, stop
}

func TestStateSurvivesRestart(t *testing.T) {
	for name, open := range map[string]func(t *testing.T, path string) store.Store{
		"memory": func(t *testing.T, path string) store.Store {
			// The same Memory is reused across the restart below.
			return sharedMemory
		},
		"sqlite": func(t *testing.T, path string) store.Store {
			s, err := store.OpenSQLite(path)
			if err != nil {
				t.Fatal(err)
			}
			return s
		},
	} {
		t.Run(name, func(t *testing.T) {
			sharedMemory = store.NewMemory()
			dir := t.TempDir()
			dbPath, uploadDir := filepath.Join(dir, "aprond.db"), filepath.Join(dir, "uploads")

			app, httpServer, stop := startWithStore(t, open(t, dbPath), uploadDir)
			owner := passkeyTestClient(t, httpServer, testPasskeyOrigin)
			registered := registerTestPasskey(t, owner, newTestAuthenticator(t))
			ownerID := registered["you"].(map[string]any)["user_id"].(string)
			token := registered["token"].(string)
			guest := dialTestClient(t, httpServer, "guest", false)
			owner.drain(t)

			hello, _ := save(t, owner, "hello", map[string]any{"body": map[string]any{"text": "Hello <world> & all"}})
			guest.drain(t)
			react(t, guest, "react", hello, "👍")
			owner.drain(t)
			gone, _ := save(t, owner, "gone", map[string]any{"body": map[string]any{"text": "Secret first line\nmore"}})
			guest.drain(t)
			thread, _ := saveRoom(t, owner, "thread", map[string]any{"parent_room_id": "general", "intro_message": map[string]any{"message_id": hello}})
			ops, _ := saveRoom(t, owner, "ops", map[string]any{"title": "Ops"})
			owner.request(t, "message", "delete", map[string]any{"room_id": "general", "message_id": gone, "deleted": true})
			attached := postEmbeds(t, owner, "attach", map[string]any{"room_id": ops, "body": map[string]any{"text": "file", "embeds": []any{map[string]any{"kind": "upload", "title": "dots.png"}}}})
			writeURL := attached["embeds"].([]any)[0].(map[string]any)["write_url"].(string)
			image := testPNG(t)
			if status, _, _ := httpDo(t, http.MethodPut, writeURL, bytes.NewReader(image), "image/png"); status != http.StatusCreated {
				t.Fatalf("upload: %d", status)
			}
			fileURL := embedsOf(t, owner.notification(t, "message"))[0]["url"].(string)
			owner.drain(t)
			guest.drain(t)

			// The guest leaves first, so that shutdown changes nothing more.
			_ = guest.ws.Close(websocket.StatusNormalClosure, "bye")
			for deadline := time.Now().Add(2 * time.Second); ; time.Sleep(10 * time.Millisecond) {
				app.mu.RLock()
				retired := app.users[guest.userID] == nil
				app.mu.RUnlock()
				if retired {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("guest not retired")
				}
			}
			owner.drain(t)
			// Every change reached the store: after shutdown it holds exactly
			// the state the server had.
			app.mu.Lock()
			want := make(map[string]string)
			for _, entry := range app.dumpLocked() {
				want[entry.Kind+"/"+entry.ID] = string(entry.Value)
			}
			app.mu.Unlock()

			before := map[string]map[string]any{}
			for _, room := range []string{"general", thread, ops} {
				before[room] = historyPage(t, owner, room, map[string]any{"limit": 1000})
			}
			stop()
			reopened := open(t, dbPath)
			stored := make(map[string]string)
			if err := reopened.Load(func(e store.Entry) error {
				stored[e.Kind+"/"+e.ID] = string(e.Value)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			_ = reopened.Close()
			for key, value := range want {
				if stored[key] != value {
					t.Errorf("stored %s = %s\nwant %s", key, stored[key], value)
				}
			}
			for key := range stored {
				if _, ok := want[key]; !ok {
					t.Errorf("stored %s is not in the server's state", key)
				}
			}
			if t.Failed() {
				t.FailNow()
			}

			_, httpServer, _ = startWithStore(t, open(t, dbPath), uploadDir)
			resumed := passkeyTestClient(t, httpServer, testPasskeyOrigin)
			result := passkeyResult(t, passkeyCall(t, resumed, "resume", "token", "", map[string]any{"token": token}))
			if result["you"].(map[string]any)["user_id"] != ownerID {
				t.Fatalf("resumed as %v, want %s", result["you"], ownerID)
			}
			for room, page := range before {
				after := historyPage(t, resumed, room, map[string]any{"limit": 1000})
				for _, key := range []string{"rooms", "messages", "reactions"} {
					if !reflect.DeepEqual(after[key], page[key]) {
						t.Fatalf("%s %s after restart:\n%#v\nwant\n%#v", room, key, after[key], page[key])
					}
				}
				if room == "general" {
					// The guest's leave is in the log.
					membership := records(t, after, "membership")
					last := membership[len(membership)-1].(map[string]any)["members"].([]any)[0].(map[string]any)
					if last["user"].(map[string]any)["user_id"] != guest.userID || last["joined"] != false {
						t.Fatalf("guest after restart: %#v", last)
					}
				}
			}
			listed := listRooms(t, resumed, map[string]any{"filter": "joined"})
			if ids := roomIDs(t, listed["joined"]); len(ids) != 3 {
				t.Fatalf("joined rooms after restart: %v", ids)
			}
			parsed, _ := url.Parse(fileURL)
			status, _, content := httpDo(t, http.MethodGet, httpServer.URL+parsed.Path, nil, "")
			if status != http.StatusOK || !bytes.Equal(content, image) {
				t.Fatalf("upload after restart: %d", status)
			}
			// Guest IDs are never reissued, across restarts too.
			if next := dialTestClient(t, httpServer, "next", false); next.userID == guest.userID {
				t.Fatalf("guest ID %s reissued", next.userID)
			}
			// A new message's log_id follows every restored record.
			resumed.drain(t)
			id, _ := save(t, resumed, "after", map[string]any{"body": map[string]any{"text": "after"}})
			if parseID(t, id) <= parseID(t, before["general"]["latest_log_id"]) {
				t.Fatalf("log_id %s does not follow %v", id, before["general"]["latest_log_id"])
			}
		})
	}
}

var sharedMemory *store.Memory

// TestRestoreAfterACrash restores a store written while a guest was
// connected and an upload was pending, as after a crash: the guest is
// retired and the pending embed leaves its message.
func TestRestoreAfterACrash(t *testing.T) {
	app, httpServer, _ := startWithStore(t, store.NewMemory(), t.TempDir())
	guest := dialTestClient(t, httpServer, "guest", false)
	pending := postEmbeds(t, guest, "pending", map[string]any{"room_id": "general", "body": map[string]any{"text": "soon", "embeds": []any{map[string]any{"kind": "upload"}}}})
	app.mu.Lock()
	crashed := store.NewMemory()
	if err := crashed.Apply(app.dumpLocked()); err != nil {
		t.Fatal(err)
	}
	app.mu.Unlock()

	restored, httpServer, _ := startWithStore(t, crashed, t.TempDir())
	restored.mu.RLock()
	_, guestKept := restored.users[guest.userID]
	restored.mu.RUnlock()
	if guestKept {
		t.Fatal("a guest outlived the restart")
	}
	c := dialTestClient(t, httpServer, "after", false)
	page := historyPage(t, c, "general", map[string]any{})
	messages := records(t, page, "messages")
	last := messages[len(messages)-1].(map[string]any)
	if last["message_id"] != pending["message_id"] || len(embedsOf(t, last)) != 0 {
		t.Fatalf("pending upload after restart: %#v", last)
	}
	membership := records(t, page, "membership")
	var left bool
	for _, value := range membership {
		for _, member := range value.(map[string]any)["members"].([]any) {
			m := member.(map[string]any)
			left = left || (m["user"].(map[string]any)["user_id"] == guest.userID && m["joined"] == false)
		}
	}
	if !left {
		t.Fatalf("no leave logged for the retired guest: %#v", membership)
	}
}
