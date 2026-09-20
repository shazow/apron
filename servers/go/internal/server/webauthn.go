package server

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"slices"
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
	action  string
	user    *passkeyUser
	data    *webauthn.SessionData
	expires time.Time
}

type passkeySession struct {
	user    *passkeyUser
	origin  string
	expires time.Time
}

// authenticatePasskey runs under s.mu. One outstanding challenge is retained per
// connection; finishing consumes it even on failure. Auth responses are never
// deduplicated, so replay cannot resurrect a consumed challenge or signed-out token.
func (s *Server) authenticatePasskey(c *client, req request) (any, *rpcError) {
	w := s.config.WebAuthn
	if w == nil {
		return nil, &rpcError{Code: codeUnsupported, Message: "Passkeys are disabled"}
	}
	if !req.hasID {
		return nil, invalidParams("Passkey authentication requires a request id")
	}
	if !slices.Contains(w.Config.RPOrigins, c.origin) {
		return nil, &rpcError{Code: codeDenied, Message: "Frontend origin is not configured for passkeys"}
	}
	action, rpcErr := parseString(req.params, "action", true)
	if rpcErr != nil {
		return nil, rpcErr
	}
	now := time.Now()
	for key, session := range s.sessions {
		if !now.Before(session.expires) {
			delete(s.sessions, key)
		}
	}
	denied := func(message string) (any, *rpcError) {
		return nil, &rpcError{Code: codeDenied, Message: message}
	}
	switch action {
	case "register_begin":
		c.ceremony = nil
		if !c.authed {
			return denied("Authenticate before adding a passkey")
		}
		user := s.users[c.identity.ID]
		if user == nil {
			user = &passkeyUser{identity: c.identity, handle: []byte(rand.Text())}
		}
		if len(user.credentials) >= 10 {
			return denied("This identity already has ten passkeys")
		}
		exclusions := make([]protocol.CredentialDescriptor, 0, len(user.credentials))
		for _, credential := range user.credentials {
			exclusions = append(exclusions, credential.Descriptor())
		}
		options, data, err := w.BeginRegistration(user,
			webauthn.WithRegistrationOrigin(c.origin),
			webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
			webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
				ResidentKey:      protocol.ResidentKeyRequirementRequired,
				UserVerification: protocol.VerificationRequired,
			}), webauthn.WithExclusions(exclusions))
		if err != nil {
			return denied("Unable to begin passkey registration")
		}
		data.Expires = now.Add(passkeyLifetime)
		options.Response.Timeout = int(passkeyLifetime / time.Millisecond)
		c.ceremony = &passkeyCeremony{action: "register", user: user, data: data, expires: data.Expires}
		c.sendResult(req, options)
		return options, nil
	case "login_begin":
		c.ceremony = nil
		options, data, err := w.BeginDiscoverableLogin(webauthn.WithLoginOrigin(c.origin), webauthn.WithUserVerification(protocol.VerificationRequired))
		if err != nil {
			return denied("Unable to begin passkey sign-in")
		}
		data.Expires = now.Add(passkeyLifetime)
		options.Response.Timeout = int(passkeyLifetime / time.Millisecond)
		c.ceremony = &passkeyCeremony{action: "login", data: data, expires: data.Expires}
		c.sendResult(req, options)
		return options, nil
	case "register_finish", "login_finish":
		ceremony := c.ceremony
		c.ceremony = nil
		if ceremony == nil || action != ceremony.action+"_finish" || !now.Before(ceremony.expires) {
			return denied("Passkey challenge is missing or expired; try again")
		}
		raw := req.params["credential"]
		var user *passkeyUser
		var credential *webauthn.Credential
		if ceremony.action == "register" {
			if !c.authed || c.identity.ID != ceremony.user.identity.ID {
				return denied("Identity changed; try again")
			}
			parsed, err := protocol.ParseCredentialCreationResponseBytes(raw)
			if err != nil {
				return denied("Passkey verification failed")
			}
			credential, err = w.CreateCredential(ceremony.user, *ceremony.data, parsed)
			if err != nil {
				return denied("Passkey verification failed")
			}
			if s.credentials[string(credential.ID)] != nil {
				return denied("Passkey is already registered")
			}
			user = s.users[c.identity.ID]
			if user == nil {
				user = ceremony.user
				user.identity = c.identity
			}
			if !bytes.Equal(user.handle, ceremony.user.handle) || len(user.credentials) >= 10 {
				return denied("Registration changed; try again")
			}
			user.credentials = append(user.credentials, *credential)
			s.users[user.identity.ID] = user
			s.credentials[string(credential.ID)] = user
		} else {
			parsed, err := protocol.ParseCredentialRequestResponseBytes(raw)
			if err != nil {
				return denied("Passkey verification failed")
			}
			verified, credentialResult, err := w.ValidatePasskeyLogin(func(id, handle []byte) (webauthn.User, error) {
				u := s.credentials[string(id)]
				if u == nil || !bytes.Equal(u.handle, handle) {
					return nil, errors.New("unknown credential")
				}
				return u, nil
			}, *ceremony.data, parsed)
			if err != nil || credentialResult.Authenticator.CloneWarning {
				return denied("Passkey verification failed")
			}
			user, credential = verified.(*passkeyUser), credentialResult
			for i := range user.credentials {
				if bytes.Equal(user.credentials[i].ID, credential.ID) {
					user.credentials[i] = *credential
				}
			}
		}
		delete(s.sessions, c.token)
		secret := make([]byte, 32)
		_, _ = rand.Read(secret)
		token := base64.RawURLEncoding.EncodeToString(secret)
		c.token = sha256.Sum256([]byte(token))
		s.sessions[c.token] = passkeySession{user: user, origin: c.origin, expires: now.Add(sessionLifetime)}
		return s.finishPasskey(c, req, user, token)
	case "resume":
		c.ceremony = nil
		token, err := parseString(req.params, "token", true)
		if err != nil {
			return nil, err
		}
		key := sha256.Sum256([]byte(token))
		session, ok := s.sessions[key]
		if !ok || session.origin != c.origin || !now.Before(session.expires) {
			return denied("Session expired; sign in with your passkey")
		}
		c.token = key
		return s.finishPasskey(c, req, session.user, token)
	case "logout":
		delete(s.sessions, c.token)
		c.token = [32]byte{}
		c.ceremony = nil
		c.authed = false
		c.identity = identity{}
		c.mu.Lock()
		clear(c.dedup)
		c.mu.Unlock()
		result := map[string]any{}
		c.sendResult(req, result)
		return result, nil
	default:
		return nil, invalidParams("Unknown passkey action")
	}
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
