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

func passkeyCall(t *testing.T, c *testClient, id, action, step string, extra map[string]any) map[string]any {
	t.Helper()
	params := map[string]any{"scheme": "webauthn", "action": action}
	if action == "token" {
		params = map[string]any{"scheme": "token"}
	} else if step != "" {
		params["step"] = step
		if step == "finish" && c.passkeyChallenge != "" {
			params["challenge_id"] = c.passkeyChallenge
		}
	}
	for key, value := range extra {
		params[key] = value
	}
	c.write(t, map[string]any{"method": "auth", "id": id, "params": params})
	frame := c.read(t)
	if frame["id"] != id {
		t.Fatalf("unexpected response: %#v", frame)
	}
	if action != "token" && step == "begin" {
		if result, ok := frame["result"].(map[string]any); ok {
			if challengeID, ok := result["challenge_id"].(string); ok {
				c.passkeyChallenge = challengeID
			}
		}
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

func passkeyPublicKey(t *testing.T, result map[string]any) map[string]any {
	t.Helper()
	publicKey, ok := result["public_key"].(map[string]any)
	if !ok {
		t.Fatalf("passkey result has no public_key: %#v", result)
	}
	return publicKey
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
	publicKey := passkeyPublicKey(t, options)
	user, ok := publicKey["user"].(map[string]any)
	if !ok {
		t.Fatalf("registration public key: %#v", publicKey)
	}
	a.handle = user["id"].(string)
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
	publicKey := passkeyPublicKey(t, options)
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
	c.write(t, map[string]any{"method": "auth", "id": "guest", "params": map[string]any{"scheme": "guest"}})
	guest := passkeyResult(t, c.read(t))["you"].(map[string]any)["user_id"]
	c.read(t)
	options := passkeyResult(t, passkeyCall(t, c, "register-start", "register", "begin", nil))
	publicKey := passkeyPublicKey(t, options)
	selection, ok := publicKey["authenticatorSelection"].(map[string]any)
	if !ok || selection["residentKey"] != "required" || selection["userVerification"] != "required" {
		t.Fatalf("registration did not require resident key and user verification: %#v", publicKey)
	}
	result := passkeyResult(t, passkeyCall(t, c, "register-end", "register", "finish", map[string]any{"credential": a.registration(t, options, testPasskeyOrigin)}))
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
	options := passkeyResult(t, passkeyCall(t, other, "begin", "login", "begin", nil))
	publicKey := passkeyPublicKey(t, options)
	if _, ok := publicKey["allowCredentials"]; ok {
		t.Fatalf("discoverable login unexpectedly constrained credentials: %#v", publicKey)
	}
	if publicKey["userVerification"] != "required" {
		t.Fatalf("login did not require user verification: %#v", publicKey)
	}
	credential := a.assertion(t, options, testPasskeyOrigin, "localhost", 0x05)
	finish := map[string]any{"credential": credential}
	loggedIn := passkeyResult(t, passkeyCall(t, other, "finish", "login", "finish", finish))
	other.read(t)
	if loggedIn["you"].(map[string]any)["user_id"] != identity {
		t.Fatal("login changed identity")
	}
	// Even the identical request ID cannot replay a completed ceremony.
	passkeyDenied(t, passkeyCall(t, other, "finish", "login", "finish", finish))
	resumed := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	token := loggedIn["token"].(string)
	result := passkeyResult(t, passkeyCall(t, resumed, "resume", "token", "", map[string]any{"token": token}))
	resumed.read(t)
	if result["you"].(map[string]any)["user_id"] != identity {
		t.Fatal("resume changed identity")
	}
	// Token sign-out is local to the client: drop the connection and reconnect.
	// The server retains the token until its normal expiry.
	_ = resumed.ws.Close(websocket.StatusNormalClosure, "signed out")
	reconnected := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	result = passkeyResult(t, passkeyCall(t, reconnected, "resume", "token", "", map[string]any{"token": token}))
	reconnected.read(t)
	if result["you"].(map[string]any)["user_id"] != identity {
		t.Fatal("reconnect changed identity")
	}
	// A resume renews the session: a token close to expiry is good for a full
	// lifetime again after use.
	app.mu.Lock()
	for key, session := range app.sessions {
		session.expires = time.Now().Add(time.Minute)
		app.sessions[key] = session
	}
	app.mu.Unlock()
	renewed := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	result = passkeyResult(t, passkeyCall(t, renewed, "resume", "token", "", map[string]any{"token": token}))
	renewed.read(t)
	if result["token"] != token {
		t.Fatalf("resume did not return the presented token: %#v", result["token"])
	}
	app.mu.Lock()
	renewedExpiry := app.sessions[sha256.Sum256([]byte(token))].expires
	app.mu.Unlock()
	if renewedExpiry.Before(time.Now().Add(sessionLifetime - time.Minute)) {
		t.Fatalf("resume did not renew the session: expires %v", renewedExpiry)
	}
	app.mu.Lock()
	for key, session := range app.sessions {
		session.expires = time.Now().Add(-time.Second)
		app.sessions[key] = session
	}
	app.mu.Unlock()
	passkeyDenied(t, passkeyCall(t, reconnected, "expired", "token", "", map[string]any{"token": registered["token"]}))
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
			passkeyResult(t, passkeyCall(t, other, "resume", "token", "", map[string]any{"token": registered["token"]}))
			other.read(t)
			rename := func() {
				owner.write(t, map[string]any{"method": "me", "id": "rename", "params": map[string]any{"name": "Updated nickname"}})
				result := passkeyResult(t, owner.read(t))
				if result["you"].(map[string]any)["name"] != "Updated nickname" {
					t.Fatalf("rename was not accepted: %#v", result)
				}
			}
			if !renameDuringRegistration {
				rename()
			}
			options := passkeyResult(t, passkeyCall(t, other, "begin", "register", "begin", nil))
			if renameDuringRegistration {
				rename()
			}
			additional := newTestAuthenticator(t)
			result := passkeyResult(t, passkeyCall(t, other, "finish", "register", "finish", map[string]any{
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
				options := passkeyResult(t, passkeyCall(t, fresh, "login-begin", "login", "begin", nil))
				result := passkeyResult(t, passkeyCall(t, fresh, "login-finish", "login", "finish", map[string]any{
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
			options := passkeyResult(t, passkeyCall(t, c, "begin", "login", "begin", nil))
			proof := a.assertion(t, options, test.origin, test.rpID, test.flags)
			passkeyDenied(t, passkeyCall(t, c, "finish", "login", "finish", map[string]any{"credential": proof}))
			passkeyDenied(t, passkeyCall(t, c, "retry", "login", "finish", map[string]any{"credential": proof}))
		})
	}
	c := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	first := passkeyResult(t, passkeyCall(t, c, "first", "login", "begin", nil))
	second := passkeyResult(t, passkeyCall(t, c, "second", "login", "begin", nil))
	proof := a.assertion(t, first, testPasskeyOrigin, "localhost", 0x05)
	passkeyDenied(t, passkeyCall(t, c, "superseded", "login", "finish", map[string]any{
		"challenge_id": first["challenge_id"], "credential": proof,
	}))
	current := a.assertion(t, second, testPasskeyOrigin, "localhost", 0x05)
	passkeyResult(t, passkeyCall(t, c, "current", "login", "finish", map[string]any{
		"challenge_id": second["challenge_id"], "credential": current,
	}))
	c.read(t)
	other := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	passkeyDenied(t, passkeyCall(t, other, "cross-connection", "login", "finish", map[string]any{
		"challenge_id": first["challenge_id"], "credential": proof,
	}))
	options := passkeyResult(t, passkeyCall(t, c, "expire", "login", "begin", nil))
	app.mu.Lock()
	for client := range app.clients {
		if client.ceremony != nil {
			client.ceremony.expires = time.Now().Add(-time.Second)
		}
	}
	app.mu.Unlock()
	passkeyDenied(t, passkeyCall(t, c, "expired", "login", "finish", map[string]any{"credential": a.assertion(t, options, testPasskeyOrigin, "localhost", 0x05)}))
	passkeyDenied(t, passkeyCall(t, other, "unauth-register", "register", "begin", nil))
	wrongOrigin := passkeyTestClient(t, httpServer, "http://localhost:9999")
	passkeyDenied(t, passkeyCall(t, wrongOrigin, "origin", "login", "begin", nil))
}

func TestPasskeyRejectsInvalidRegistration(t *testing.T) {
	app, httpServer := passkeyTestServer(t)
	c := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	c.write(t, map[string]any{"method": "auth", "id": "guest", "params": map[string]any{"scheme": "guest"}})
	passkeyResult(t, c.read(t))
	c.read(t)
	a := newTestAuthenticator(t)
	options := passkeyResult(t, passkeyCall(t, c, "begin", "register", "begin", nil))
	proof := a.registration(t, options, "https://evil.example")
	passkeyDenied(t, passkeyCall(t, c, "bad-origin", "register", "finish", map[string]any{"credential": proof}))
	proof = a.registration(t, options, testPasskeyOrigin)
	passkeyDenied(t, passkeyCall(t, c, "consumed", "register", "finish", map[string]any{"credential": proof}))
	for _, malformed := range []any{nil, "invalid", []any{}, map[string]any{}} {
		passkeyResult(t, passkeyCall(t, c, "begin", "register", "begin", nil))
		failure := passkeyCall(t, c, "malformed", "register", "finish", map[string]any{"credential": malformed})
		if failure["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
			t.Fatalf("malformed credential: %#v", failure)
		}
	}
	app.mu.RLock()
	defer app.mu.RUnlock()
	if len(app.users) != 0 || len(app.credentials) != 0 || len(app.sessions) != 0 {
		t.Fatal("failed registration retained an account, credential, or session")
	}
}

func TestPasskeyNotificationsDoNotRunCeremonies(t *testing.T) {
	_, httpServer := passkeyTestServer(t)
	c := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	c.write(t, map[string]any{"method": "auth", "id": "guest", "params": map[string]any{"scheme": "guest"}})
	passkeyResult(t, c.read(t))
	c.read(t)
	a := newTestAuthenticator(t)
	options := passkeyResult(t, passkeyCall(t, c, "begin", "register", "begin", nil))
	proof := a.registration(t, options, testPasskeyOrigin)
	challengeID := options["challenge_id"].(string)

	// This notification carries the current challenge and a malformed proof. It
	// must not consume the ceremony or produce a response.
	c.write(t, map[string]any{"method": "auth", "params": map[string]any{
		"scheme": "webauthn", "action": "register", "step": "finish",
		"challenge_id": challengeID, "credential": map[string]any{},
	}})
	result := passkeyResult(t, passkeyCall(t, c, "finish", "register", "finish", map[string]any{"credential": proof}))
	if result["you"].(map[string]any)["user_id"] == "" {
		t.Fatalf("registration result lost identity: %#v", result)
	}
	c.read(t)
}

func TestPasskeyCanonicalMalformedFields(t *testing.T) {
	_, httpServer := passkeyTestServer(t)
	c := passkeyTestClient(t, httpServer, testPasskeyOrigin)
	c.write(t, map[string]any{"method": "auth", "id": "guest", "params": map[string]any{"scheme": "guest"}})
	passkeyResult(t, c.read(t))
	c.read(t)

	// Canonical actions require a valid step and reject unknown action names.
	for id, params := range map[string]map[string]any{
		"unknown-action": {"scheme": "webauthn", "action": "other", "step": "begin"},
		"no-step":        {"scheme": "webauthn", "action": "register"},
		"bad-step":       {"scheme": "webauthn", "action": "register", "step": "middle"},
	} {
		c.write(t, map[string]any{"method": "auth", "id": id, "params": params})
		frame := c.read(t)
		if frame["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
			t.Fatalf("%s: %#v", id, frame)
		}
	}

	a := newTestAuthenticator(t)
	options := passkeyResult(t, passkeyCall(t, c, "begin", "register", "begin", nil))
	proof := a.registration(t, options, testPasskeyOrigin)
	// The opaque ID matches, but the action does not. The bound ceremony is
	// consumed before this policy failure and cannot be retried as register.
	passkeyDenied(t, passkeyCall(t, c, "wrong-action", "login", "finish", map[string]any{
		"challenge_id": options["challenge_id"], "credential": proof,
	}))
	passkeyDenied(t, passkeyCall(t, c, "wrong-action-retry", "register", "finish", map[string]any{
		"credential": proof,
	}))
	options = passkeyResult(t, passkeyCall(t, c, "begin-again", "register", "begin", nil))
	proof = a.registration(t, options, testPasskeyOrigin)
	// Missing challenge_id is malformed and leaves the pending challenge in
	// place because no challenge can be matched.
	c.write(t, map[string]any{"method": "auth", "id": "missing-challenge", "params": map[string]any{
		"scheme": "webauthn", "action": "register", "step": "finish", "credential": proof,
	}})
	missing := c.read(t)
	if missing["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
		t.Fatalf("missing challenge_id: %#v", missing)
	}
	// A matching malformed credential is invalid_params and consumes the
	// challenge, so its later retry is a denied missing challenge.
	failure := passkeyCall(t, c, "malformed", "register", "finish", map[string]any{"credential": map[string]any{}})
	if failure["error"].(map[string]any)["code"] != float64(codeInvalidParams) {
		t.Fatalf("malformed credential: %#v", failure)
	}
	passkeyDenied(t, passkeyCall(t, c, "retry", "register", "finish", map[string]any{"credential": proof}))
}
