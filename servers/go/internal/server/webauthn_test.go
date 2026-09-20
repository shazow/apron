package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/fxamacker/cbor/v2"
	"github.com/go-webauthn/webauthn/webauthn"
)

const testPasskeyOrigin = "http://localhost:5173"

func passkeyTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	w, err := webauthn.New(&webauthn.Config{RPID: "localhost", RPDisplayName: "Apron", RPOrigins: []string{testPasskeyOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	config := DefaultConfig()
	config.WebAuthn = w
	return newTestServer(t, config)
}

func passkeyTestClient(t *testing.T, server *httptest.Server, origin string) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.Close(websocket.StatusNormalClosure, "test done") })
	c := &testClient{ws: ws}
	c.read(t)
	return c
}

func passkeyCall(t *testing.T, c *testClient, id, action string, extra map[string]any) map[string]any {
	t.Helper()
	params := map[string]any{"scheme": "webauthn", "action": action}
	for key, value := range extra {
		params[key] = value
	}
	c.write(t, map[string]any{"method": "auth", "id": id, "params": params})
	frame := c.read(t)
	if frame["id"] != id {
		t.Fatalf("unexpected response: %#v", frame)
	}
	return frame
}

func passkeyResult(t *testing.T, frame map[string]any) map[string]any {
	t.Helper()
	result, ok := frame["result"].(map[string]any)
	if !ok {
		t.Fatalf("expected success: %#v", frame)
	}
	return result
}

func passkeyDenied(t *testing.T, frame map[string]any) {
	t.Helper()
	err, ok := frame["error"].(map[string]any)
	if !ok || err["code"] != float64(codeDenied) {
		t.Fatalf("expected denial: %#v", frame)
	}
}

// A software authenticator produces real ES256 credentials and signatures;
// the server exercises the same verifier as browser-created credentials.
type testAuthenticator struct {
	key     *ecdsa.PrivateKey
	id      []byte
	handle  string
	counter uint32
}

func newTestAuthenticator(t *testing.T) *testAuthenticator {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &testAuthenticator{key: key, id: []byte(rand.Text())}
}

func b64(value []byte) string { return base64.RawURLEncoding.EncodeToString(value) }

func clientData(kind, challenge, origin string) []byte {
	data, _ := json.Marshal(map[string]any{"type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false})
	return data
}

func (a *testAuthenticator) registration(t *testing.T, options map[string]any, origin string) map[string]any {
	t.Helper()
	publicKey := options["publicKey"].(map[string]any)
	a.handle = publicKey["user"].(map[string]any)["id"].(string)
	cose, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: a.key.X.FillBytes(make([]byte, 32)), -3: a.key.Y.FillBytes(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("localhost"))
	data := append(hash[:], 0x45, 0, 0, 0, 0) // UP, UV, attested credential data.
	data = append(data, make([]byte, 16)...)
	data = binary.BigEndian.AppendUint16(data, uint16(len(a.id)))
	data = append(data, a.id...)
	data = append(data, cose...)
	attestation, err := cbor.Marshal(map[string]any{"fmt": "none", "authData": data, "attStmt": map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{
		"id": b64(a.id), "rawId": b64(a.id), "type": "public-key", "clientExtensionResults": map[string]any{},
		"response": map[string]any{"clientDataJSON": b64(clientData("webauthn.create", publicKey["challenge"].(string), origin)), "attestationObject": b64(attestation)},
	}
}

func (a *testAuthenticator) assertion(t *testing.T, options map[string]any, origin, rpID string, flags byte) map[string]any {
	t.Helper()
	a.counter++
	publicKey := options["publicKey"].(map[string]any)
	client := clientData("webauthn.get", publicKey["challenge"].(string), origin)
	hash := sha256.Sum256([]byte(rpID))
	data := append(hash[:], flags)
	data = binary.BigEndian.AppendUint32(data, a.counter)
	clientHash := sha256.Sum256(client)
	signed := sha256.Sum256(append(append([]byte{}, data...), clientHash[:]...))
	signature, err := ecdsa.SignASN1(rand.Reader, a.key, signed[:])
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{
		"id": b64(a.id), "rawId": b64(a.id), "type": "public-key", "clientExtensionResults": map[string]any{},
		"response": map[string]any{"clientDataJSON": b64(client), "authenticatorData": b64(data), "signature": b64(signature), "userHandle": a.handle},
	}
}

func registerTestPasskey(t *testing.T, c *testClient, a *testAuthenticator) map[string]any {
	t.Helper()
	c.write(t, map[string]any{"method": "auth", "id": "guest", "params": map[string]any{"scheme": "anonymous"}})
	guest := passkeyResult(t, c.read(t))["you"].(map[string]any)["user_id"]
	c.read(t)
	options := passkeyResult(t, passkeyCall(t, c, "register-start", "register_begin", nil))
	result := passkeyResult(t, passkeyCall(t, c, "register-end", "register_finish", map[string]any{"credential": a.registration(t, options, testPasskeyOrigin)}))
	if result["you"].(map[string]any)["user_id"] != guest {
		t.Fatal("registration changed guest identity")
	}
	c.read(t)
	return result
}

func TestPasskeyRegistrationLoginAndSession(t *testing.T) {
	app, httpServer := passkeyTestServer(t)
	owner := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	a := newTestAuthenticator(t)
	registered := registerTestPasskey(t, owner, a)
	identity := registered["you"].(map[string]any)["user_id"]
	other := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	options := passkeyResult(t, passkeyCall(t, other, "begin", "login_begin", nil))
	credential := a.assertion(t, options, testPasskeyOrigin, "localhost", 0x05)
	finish := map[string]any{"credential": credential}
	loggedIn := passkeyResult(t, passkeyCall(t, other, "finish", "login_finish", finish))
	other.read(t)
	if loggedIn["you"].(map[string]any)["user_id"] != identity {
		t.Fatal("login changed identity")
	}
	// Even the identical request ID cannot replay a completed ceremony.
	passkeyDenied(t, passkeyCall(t, other, "finish", "login_finish", finish))
	resumed := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	token := loggedIn["token"].(string)
	result := passkeyResult(t, passkeyCall(t, resumed, "resume", "resume", map[string]any{"token": token}))
	resumed.read(t)
	if result["you"].(map[string]any)["user_id"] != identity {
		t.Fatal("resume changed identity")
	}
	passkeyResult(t, passkeyCall(t, resumed, "logout", "logout", nil))
	passkeyDenied(t, passkeyCall(t, resumed, "resume", "resume", map[string]any{"token": token}))
	app.mu.Lock()
	for key, session := range app.sessions {
		session.expires = time.Now().Add(-time.Second)
		app.sessions[key] = session
	}
	app.mu.Unlock()
	passkeyDenied(t, passkeyCall(t, resumed, "expired", "resume", map[string]any{"token": registered["token"]}))
}

func TestAddingPasskeyPreservesStoredNickname(t *testing.T) {
	for _, renameDuringRegistration := range []bool{false, true} {
		name := "rename before registration"
		if renameDuringRegistration {
			name = "rename during registration"
		}
		t.Run(name, func(t *testing.T) {
			_, httpServer := passkeyTestServer(t)
			owner := passkeyTestClient(t, httpServer, testPasskeyOrigin)
			original := newTestAuthenticator(t)
			registered := registerTestPasskey(t, owner, original)
			other := passkeyTestClient(t, httpServer, testPasskeyOrigin)
			passkeyResult(t, passkeyCall(t, other, "resume", "resume", map[string]any{"token": registered["token"]}))
			other.read(t)
			rename := func() {
				owner.write(t, map[string]any{"method": "nick", "id": "rename", "params": map[string]any{"name": "Updated nickname"}})
				result := passkeyResult(t, owner.read(t))
				if result["you"].(map[string]any)["name"] != "Updated nickname" {
					t.Fatalf("rename was not accepted: %#v", result)
				}
			}
			if !renameDuringRegistration {
				rename()
			}
			options := passkeyResult(t, passkeyCall(t, other, "begin", "register_begin", nil))
			if renameDuringRegistration {
				rename()
			}
			additional := newTestAuthenticator(t)
			result := passkeyResult(t, passkeyCall(t, other, "finish", "register_finish", map[string]any{
				"credential": additional.registration(t, options, testPasskeyOrigin),
			}))
			other.read(t)
			assertIdentity := func(result map[string]any) {
				t.Helper()
				you := result["you"].(map[string]any)
				if you["user_id"] != registered["you"].(map[string]any)["user_id"] || you["name"] != "Updated nickname" {
					t.Fatalf("registration lost the stored identity: %#v", you)
				}
			}
			assertIdentity(result)
			// Both credentials must restore the accepted nickname on fresh connections.
			for _, authenticator := range []*testAuthenticator{original, additional} {
				fresh := passkeyTestClient(t, httpServer, testPasskeyOrigin)
				options := passkeyResult(t, passkeyCall(t, fresh, "login-begin", "login_begin", nil))
				result := passkeyResult(t, passkeyCall(t, fresh, "login-finish", "login_finish", map[string]any{
					"credential": authenticator.assertion(t, options, testPasskeyOrigin, "localhost", 0x05),
				}))
				fresh.read(t)
				assertIdentity(result)
			}
		})
	}
}

func TestPasskeyRejectsInvalidProofs(t *testing.T) {
	app, httpServer := passkeyTestServer(t)
	a := newTestAuthenticator(t)
	owner := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	registerTestPasskey(t, owner, a)
	for _, test := range []struct {
		name, origin, rpID string
		flags              byte
	}{
		{"wrong origin", "https://evil.example", "localhost", 0x05},
		{"wrong RP", testPasskeyOrigin, "evil.example", 0x05},
		{"no user verification", testPasskeyOrigin, "localhost", 0x01},
		{"no user presence", testPasskeyOrigin, "localhost", 0x04},
	} {
		t.Run(test.name, func(t *testing.T) {
			c := passkeyTestClient(t, httpServer, testPasskeyOrigin)
			options := passkeyResult(t, passkeyCall(t, c, "begin", "login_begin", nil))
			proof := a.assertion(t, options, test.origin, test.rpID, test.flags)
			passkeyDenied(t, passkeyCall(t, c, "finish", "login_finish", map[string]any{"credential": proof}))
			passkeyDenied(t, passkeyCall(t, c, "retry", "login_finish", map[string]any{"credential": proof}))
		})
	}
	c := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	first := passkeyResult(t, passkeyCall(t, c, "first", "login_begin", nil))
	passkeyResult(t, passkeyCall(t, c, "second", "login_begin", nil))
	proof := a.assertion(t, first, testPasskeyOrigin, "localhost", 0x05)
	passkeyDenied(t, passkeyCall(t, c, "superseded", "login_finish", map[string]any{"credential": proof}))
	other := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	passkeyDenied(t, passkeyCall(t, other, "cross-connection", "login_finish", map[string]any{"credential": proof}))
	options := passkeyResult(t, passkeyCall(t, c, "expire", "login_begin", nil))
	app.mu.Lock()
	for client := range app.clients {
		if client.ceremony != nil {
			client.ceremony.expires = time.Now().Add(-time.Second)
		}
	}
	app.mu.Unlock()
	passkeyDenied(t, passkeyCall(t, c, "expired", "login_finish", map[string]any{"credential": a.assertion(t, options, testPasskeyOrigin, "localhost", 0x05)}))
	passkeyDenied(t, passkeyCall(t, other, "unauth-register", "register_begin", nil))
	wrongOrigin := passkeyTestClient(t, httpServer, "http://localhost:9999")
	passkeyDenied(t, passkeyCall(t, wrongOrigin, "origin", "login_begin", nil))
}

func TestPasskeyRejectsInvalidRegistration(t *testing.T) {
	app, httpServer := passkeyTestServer(t)
	c := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	c.write(t, map[string]any{"method": "auth", "id": "guest", "params": map[string]any{"scheme": "anonymous"}})
	passkeyResult(t, c.read(t))
	c.read(t)
	a := newTestAuthenticator(t)
	options := passkeyResult(t, passkeyCall(t, c, "begin", "register_begin", nil))
	proof := a.registration(t, options, "https://evil.example")
	passkeyDenied(t, passkeyCall(t, c, "bad-origin", "register_finish", map[string]any{"credential": proof}))
	proof = a.registration(t, options, testPasskeyOrigin)
	passkeyDenied(t, passkeyCall(t, c, "consumed", "register_finish", map[string]any{"credential": proof}))
	for _, malformed := range []any{nil, "invalid", []any{}, map[string]any{}} {
		passkeyResult(t, passkeyCall(t, c, "begin", "register_begin", nil))
		passkeyDenied(t, passkeyCall(t, c, "malformed", "register_finish", map[string]any{"credential": malformed}))
	}
	app.mu.RLock()
	defer app.mu.RUnlock()
	if len(app.users) != 0 || len(app.credentials) != 0 || len(app.sessions) != 0 {
		t.Fatal("failed registration retained an account, credential, or session")
	}
}
