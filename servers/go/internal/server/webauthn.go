package server

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

const passkeyLifetime = 2 * time.Minute
const sessionLifetime = 12 * time.Hour

type passkeyUser struct {
	// TODO: Persist complete credentials and stable user handles before using this outside the in-memory example.
	identity    identity
	handle      []byte
	credentials []webauthn.Credential
}

func (u *passkeyUser) WebAuthnID() []byte { return u.handle }
func (u *passkeyUser) WebAuthnName() string {
	if u.identity.Name != "" {
		return u.identity.Name
	}
	return u.identity.ID
}
func (u *passkeyUser) WebAuthnDisplayName() string                { return u.WebAuthnName() }
func (u *passkeyUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

type passkeyCeremony struct {
	challengeID string
	action      string
	identityID  string
	rpID        string
	origin      string
	user        *passkeyUser
	data        *webauthn.SessionData
	expires     time.Time
}

type passkeySession struct {
	user    *passkeyUser
	origin  string
	expires time.Time
}

// authenticatePasskey runs under s.mu. One outstanding challenge is retained per
// connection; finishing consumes it even on failure. Auth responses are never
// deduplicated, so replay cannot resurrect a consumed challenge.
func (s *Server) authenticatePasskey(c *client, req request) (any, *rpcError) {
	// WebAuthn ceremonies are request/response operations. A notification has
	// no request ID to correlate and must not create, consume, or resume any
	// authentication state.
	if !req.hasID {
		return nil, nil
	}
	w := s.config.WebAuthn
	if w == nil {
		return nil, &rpcError{Code: codeUnsupported, Message: "Passkeys are disabled"}
	}
	action, rpcErr := parseString(req.params, "action", true)
	if rpcErr != nil {
		return nil, rpcErr
	}
	if action == "" {
		return nil, invalidParams("action must be a non-empty string")
	}
	if !protocol.IsOriginInHaystack(c.origin, w.Config.RPOrigins) {
		return nil, &rpcError{Code: codeDenied, Message: "Frontend origin is not configured for passkeys"}
	}
	now := time.Now()
	for key, session := range s.sessions {
		if !now.Before(session.expires) {
			delete(s.sessions, key)
		}
	}
	switch action {
	case "register", "login":
		step, rpcErr := parseString(req.params, "step", true)
		if rpcErr != nil {
			return nil, rpcErr
		}
		if step == "" {
			return nil, invalidParams("step must be a non-empty string")
		}
		switch step {
		case "begin":
			return s.beginPasskey(c, req, action, w, now)
		case "finish":
			return s.finishPasskeyCeremony(c, req, action, w, now)
		default:
			return nil, invalidParams("Passkey step must be begin or finish")
		}
	default:
		return nil, invalidParams("Unknown passkey action")
	}
}

func (s *Server) beginPasskey(c *client, req request, action string, w *webauthn.WebAuthn, now time.Time) (any, *rpcError) {
	// Starting any new ceremony replaces the previous pending one. The
	// replacement happens before policy and library errors so a stale pending
	// challenge can never be resumed after a new begin was attempted.
	c.ceremony = nil

	var (
		creation  *protocol.CredentialCreation
		assertion *protocol.CredentialAssertion
		data      *webauthn.SessionData
		err       error
		user      *passkeyUser
	)
	identityID := ""
	if action == "register" {
		if !c.authed {
			return nil, &rpcError{Code: codeDenied, Message: "Authenticate before adding a passkey"}
		}
		identityID = c.identity.ID
		user = s.users[c.identity.ID]
		if user == nil {
			user = &passkeyUser{identity: c.identity, handle: []byte(rand.Text())}
		}
		if len(user.credentials) >= 10 {
			return nil, &rpcError{Code: codeDenied, Message: "This identity already has ten passkeys"}
		}
		exclusions := make([]protocol.CredentialDescriptor, 0, len(user.credentials))
		for _, credential := range user.credentials {
			exclusions = append(exclusions, credential.Descriptor())
		}
		creation, data, err = w.BeginRegistration(user,
			webauthn.WithRegistrationOrigin(c.origin),
			webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
			webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
				ResidentKey:      protocol.ResidentKeyRequirementRequired,
				UserVerification: protocol.VerificationRequired,
			}), webauthn.WithExclusions(exclusions))
		if err != nil {
			return nil, &rpcError{Code: codeDenied, Message: "Unable to begin passkey registration"}
		}
	} else {
		assertion, data, err = w.BeginDiscoverableLogin(webauthn.WithLoginOrigin(c.origin), webauthn.WithUserVerification(protocol.VerificationRequired))
		if err != nil {
			return nil, &rpcError{Code: codeDenied, Message: "Unable to begin passkey sign-in"}
		}
	}

	data.Expires = now.Add(passkeyLifetime)
	var publicKey any
	if creation != nil {
		creation.Response.Timeout = int(passkeyLifetime / time.Millisecond)
		publicKey = creation.Response
	} else {
		assertion.Response.Timeout = int(passkeyLifetime / time.Millisecond)
		publicKey = assertion.Response
	}
	challengeID := rand.Text()
	ceremony := &passkeyCeremony{
		challengeID: challengeID,
		action:      action,
		identityID:  identityID,
		rpID:        w.Config.RPID,
		origin:      c.origin,
		user:        user,
		data:        data,
		expires:     data.Expires,
	}
	c.ceremony = ceremony
	result := map[string]any{"challenge_id": challengeID, "public_key": publicKey}
	c.sendResult(req, result)
	return result, nil
}

func (s *Server) finishPasskeyCeremony(c *client, req request, action string, w *webauthn.WebAuthn, now time.Time) (any, *rpcError) {
	challengeID, rpcErr := parseString(req.params, "challenge_id", true)
	if rpcErr != nil {
		return nil, rpcErr
	}
	if challengeID == "" {
		return nil, invalidParams("challenge_id must be a non-empty string")
	}
	ceremony := c.ceremony
	// An ID from another connection or a superseded begin does not identify the
	// current ceremony and therefore must not consume the current one. A finish
	// carrying the current ID consumes it before parsing or verifying the proof,
	// including malformed proofs and policy failures.
	if ceremony == nil || ceremony.challengeID != challengeID {
		return nil, &rpcError{Code: codeDenied, Message: "Passkey challenge is missing or expired; try again"}
	}
	c.ceremony = nil
	if ceremony.action != action || ceremony.rpID != w.Config.RPID || ceremony.origin != c.origin || !now.Before(ceremony.expires) {
		return nil, &rpcError{Code: codeDenied, Message: "Passkey challenge is missing or expired; try again"}
	}
	if ceremony.action == "register" && (!c.authed || c.identity.ID != ceremony.identityID || ceremony.user == nil) {
		return nil, &rpcError{Code: codeDenied, Message: "Identity changed; try again"}
	}
	raw, rpcErr := parsePasskeyCredential(req.params, ceremony.action)
	if rpcErr != nil {
		return nil, rpcErr
	}
	var user *passkeyUser
	var credential *webauthn.Credential
	if ceremony.action == "register" {
		parsed, err := protocol.ParseCredentialCreationResponseBytes(raw)
		if err != nil {
			return nil, &rpcError{Code: codeDenied, Message: "Passkey verification failed"}
		}
		credential, err = w.CreateCredential(ceremony.user, *ceremony.data, parsed)
		if err != nil {
			return nil, &rpcError{Code: codeDenied, Message: "Passkey verification failed"}
		}
		if credential == nil {
			return nil, &rpcError{Code: codeDenied, Message: "Passkey verification failed"}
		}
		if s.credentials[string(credential.ID)] != nil {
			return nil, &rpcError{Code: codeDenied, Message: "Passkey is already registered"}
		}
		user = s.users[c.identity.ID]
		if user == nil {
			user = ceremony.user
			user.identity = c.identity
		}
		if !bytes.Equal(user.handle, ceremony.user.handle) || len(user.credentials) >= 10 {
			return nil, &rpcError{Code: codeDenied, Message: "Registration changed; try again"}
		}
		user.credentials = append(user.credentials, *credential)
		s.users[user.identity.ID] = user
		s.credentials[string(credential.ID)] = user
	} else {
		parsed, err := protocol.ParseCredentialRequestResponseBytes(raw)
		if err != nil {
			return nil, &rpcError{Code: codeDenied, Message: "Passkey verification failed"}
		}
		verified, credentialResult, err := w.ValidatePasskeyLogin(func(id, handle []byte) (webauthn.User, error) {
			u := s.credentials[string(id)]
			if u == nil || !bytes.Equal(u.handle, handle) {
				return nil, errors.New("unknown credential")
			}
			return u, nil
		}, *ceremony.data, parsed)
		if err != nil || credentialResult == nil || credentialResult.Authenticator.CloneWarning {
			return nil, &rpcError{Code: codeDenied, Message: "Passkey verification failed"}
		}
		var ok bool
		user, ok = verified.(*passkeyUser)
		if !ok || user == nil {
			return nil, &rpcError{Code: codeDenied, Message: "Passkey verification failed"}
		}
		credential = credentialResult
		for i := range user.credentials {
			if bytes.Equal(user.credentials[i].ID, credential.ID) {
				user.credentials[i] = *credential
			}
		}
	}
	delete(s.sessions, c.token)
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, &rpcError{Code: codeInternalError, Message: "Unable to create passkey session"}
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	c.token = sha256.Sum256([]byte(token))
	s.sessions[c.token] = passkeySession{user: user, origin: c.origin, expires: now.Add(sessionLifetime)}
	return s.finishPasskey(c, req, user, token)
}

// authenticateToken resumes a passkey session through the protocol's token
// scheme. Keeping this outside the WebAuthn action space preserves Appendix I's
// register/login action grammar while retaining the example server's bearer
// token policy.
func (s *Server) authenticateToken(c *client, req request, now time.Time) (any, *rpcError) {
	if !req.hasID {
		return nil, nil
	}
	c.ceremony = nil
	token, err := parseString(req.params, "token", true)
	if err != nil {
		return nil, err
	}
	if token == "" {
		return nil, invalidParams("token must be a non-empty string")
	}
	key := sha256.Sum256([]byte(token))
	session, ok := s.sessions[key]
	if !ok || session.origin != c.origin || !now.Before(session.expires) {
		return nil, &rpcError{Code: codeDenied, Message: "Session expired; sign in with your passkey"}
	}
	// Each successful resume renews the session for a full lifetime, so an
	// active user is never forced back through a ceremony. The token itself is
	// not rotated: several tabs may share one persisted token.
	session.expires = now.Add(sessionLifetime)
	s.sessions[key] = session
	c.token = key
	return s.finishPasskey(c, req, session.user, token)
}

// parsePasskeyCredential performs only wire-shape validation. A syntactically
// shaped credential with invalid base64, authenticator data, origin, RP, UV,
// or signature remains a failed proof and is reported as denied by the caller.
func parsePasskeyCredential(params map[string]json.RawMessage, action string) ([]byte, *rpcError) {
	raw, ok := params["credential"]
	if !ok {
		return nil, invalidParams("Missing credential")
	}
	var credential map[string]json.RawMessage
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &credential) != nil || credential == nil {
		return nil, invalidParams("credential must be an object")
	}
	for _, name := range []string{"id", "rawId", "type"} {
		value, ok := credential[name]
		var text string
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &text) != nil || text == "" {
			return nil, invalidParams("credential.%s must be a non-empty string", name)
		}
	}
	var credentialType string
	if json.Unmarshal(credential["type"], &credentialType) == nil && credentialType != "public-key" {
		return nil, invalidParams("credential.type must be public-key")
	}
	if value, ok := credential["clientExtensionResults"]; ok {
		var extensions map[string]json.RawMessage
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &extensions) != nil || extensions == nil {
			return nil, invalidParams("credential.clientExtensionResults must be an object")
		}
	}
	if value, ok := credential["authenticatorAttachment"]; ok {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			value = nil
		}
		var attachment string
		if value != nil && (json.Unmarshal(value, &attachment) != nil || attachment == "") {
			return nil, invalidParams("credential.authenticatorAttachment must be a non-empty string")
		}
	}
	rawResponse, ok := credential["response"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawResponse), []byte("null")) {
		return nil, invalidParams("credential.response must be an object")
	}
	var response map[string]json.RawMessage
	if json.Unmarshal(rawResponse, &response) != nil || response == nil {
		return nil, invalidParams("credential.response must be an object")
	}
	fields := []string{"clientDataJSON"}
	if action == "register" {
		fields = append(fields, "attestationObject")
	} else {
		fields = append(fields, "authenticatorData", "signature")
	}
	for _, name := range fields {
		value, ok := response[name]
		var text string
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &text) != nil || text == "" {
			return nil, invalidParams("credential.response.%s must be a non-empty string", name)
		}
	}
	if value, ok := response["userHandle"]; ok {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			value = nil
		}
		var handle string
		if value != nil && (json.Unmarshal(value, &handle) != nil || handle == "") {
			return nil, invalidParams("credential.response.userHandle must be a non-empty string")
		}
	}
	if value, ok := response["transports"]; ok {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			value = nil
		}
		var transports []string
		if value != nil && json.Unmarshal(value, &transports) != nil {
			return nil, invalidParams("credential.response.transports must be an array")
		}
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		return nil, invalidParams("credential is invalid")
	}
	return encoded, nil
}

func (s *Server) finishPasskey(c *client, req request, user *passkeyUser, token string) (any, *rpcError) {
	if c.identity.ID != user.identity.ID {
		c.mu.Lock()
		clear(c.dedup)
		c.mu.Unlock()
	}
	c.identity, c.authed = user.identity, true
	result := map[string]any{"you": c.identity.object(), "token": token}
	s.announceAuthenticated(c, req, result)
	return result, nil
}
