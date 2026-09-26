package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	maxPushTextRunes      = 1000
	maxPushesPerUser      = 10
	pushTimeout           = 10 * time.Second
	maxConcurrentPushPOST = 8
)

// pushRegistration is one `relay` endpoint (§4.7), keyed by its url.
type pushRegistration struct {
	userID string
	kind   string
	url    string
	token  string
}

// registerPush records a push endpoint for the caller. Registering a url
// again replaces its registration, whoever held it.
func (s *Server) registerPush(c *client, req request) (any, bool, *rpcError) {
	kind, err := parseString(req.params, "kind", true)
	if err != nil {
		return nil, false, err
	}
	if kind != "relay" {
		return nil, false, invalidParams("Unknown push kind %q; this server supports relay", kind)
	}
	endpoint, err := parseString(req.params, "url", true)
	if err != nil {
		return nil, false, err
	}
	token, err := parseString(req.params, "token", false)
	if err != nil {
		return nil, false, err
	}
	if problem := s.checkPushURL(endpoint); problem != "" {
		return nil, false, invalidParams("%s", problem)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, registration := range s.pushes {
		if registration.userID == c.user.id && registration.url != endpoint {
			count++
		}
	}
	if count >= maxPushesPerUser {
		return nil, false, &rpcError{Code: codeDenied, Message: "Too many push endpoints; unregister one first"}
	}
	s.pushes[endpoint] = &pushRegistration{userID: c.user.id, kind: kind, url: endpoint, token: token}
	return map[string]any{}, false, nil
}

// unregisterPush removes the caller's registration for a url; an unknown url
// is already unregistered.
func (s *Server) unregisterPush(c *client, req request) (any, bool, *rpcError) {
	endpoint, err := parseString(req.params, "url", true)
	if err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if registration := s.pushes[endpoint]; registration != nil && registration.userID == c.user.id {
		delete(s.pushes, endpoint)
	}
	return map[string]any{}, false, nil
}

// checkPushURL requires an absolute https URL (http too with
// AllowInsecurePush). Internal addresses are refused when dialing.
func (s *Server) checkPushURL(endpoint string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return "url must be an absolute URL"
	}
	if parsed.Scheme != "https" && !(s.config.AllowInsecurePush && parsed.Scheme == "http") {
		return "url must use https"
	}
	return ""
}

// wakeLocked pushes a message snapshot to the users it newly mentions
// (§3.5) and, for a new message, to the author of the message it replies to.
// previous is the snapshot the save replaced, nil for a new message: an edit
// wakes only the users it adds to body.mentions. Wake policy is
// server-defined (§4.7); this server follows the suggested convention: a
// mention wakes a user in any room they can see, which is every room, and a
// reply wakes its target's author only in a room they have joined, in both
// cases only when every connection of theirs is away or gone (§4.4).
func (s *Server) wakeLocked(m *messageState, snapshot, previous map[string]any) {
	if len(s.pushes) == 0 || snapshot["deleted"] == true {
		return
	}
	// targets maps each user to wake to whether the message mentions them.
	targets := make(map[string]bool)
	body, _ := snapshot["body"].(map[string]any)
	for _, id := range mentions(body) {
		targets[id] = true
	}
	if previous == nil {
		if ref, ok := snapshot["reply_to"].(map[string]any); ok {
			if target := s.messages[ref["message_id"].(string)]; target != nil && !targets[target.owner] {
				targets[target.owner] = false
			}
		}
	} else {
		previousBody, _ := previous["body"].(map[string]any)
		for _, id := range mentions(previousBody) {
			delete(targets, id)
		}
	}
	delete(targets, m.owner)
	var payload []byte
	for _, registration := range s.pushes {
		user := s.users[registration.userID]
		mentioned, targeted := targets[registration.userID]
		if !targeted || user == nil || (!mentioned && user.joined[m.roomID] == nil) || user.attending() {
			continue
		}
		if payload == nil {
			payload = pushPayload(snapshot)
		}
		s.push.deliver(*registration, payload, func(gone bool) {
			if gone {
				s.mu.Lock()
				if current := s.pushes[registration.url]; current != nil && current.userID == registration.userID {
					delete(s.pushes, registration.url)
				}
				s.mu.Unlock()
			}
		})
	}
}

// pushPayload is a message object without log_id, format, or embeds, with
// its text truncated (§4.7).
func pushPayload(snapshot map[string]any) []byte {
	value := map[string]any{
		"message_id": snapshot["message_id"],
		"room_id":    snapshot["room_id"],
		"from":       snapshot["from"],
	}
	if body, ok := snapshot["body"].(map[string]any); ok {
		if text, ok := body["text"].(string); ok && text != "" {
			if utf8.RuneCountInString(text) > maxPushTextRunes {
				text = string([]rune(text)[:maxPushTextRunes-1]) + "…"
			}
			value["body"] = map[string]any{"text": text}
		}
	}
	payload, _ := json.Marshal(value)
	return payload
}

// pushDeliverer POSTs push payloads in the background with bounded
// concurrency. Unless insecure pushes are allowed, it refuses to connect to
// loopback, private, link-local, and other internal addresses, checked on
// the dialed address so DNS cannot redirect it.
type pushDeliverer struct {
	client  *http.Client
	slots   chan struct{}
	pending sync.WaitGroup
}

func newPushDeliverer(allowInternal bool) *pushDeliverer {
	dialer := &net.Dialer{Timeout: pushTimeout}
	if !allowInternal {
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip := net.ParseIP(host)
			if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() {
				return errors.New("push endpoint resolves to an internal address")
			}
			return nil
		}
	}
	transport := &http.Transport{DialContext: dialer.DialContext, TLSHandshakeTimeout: pushTimeout}
	return &pushDeliverer{
		client: &http.Client{
			Timeout:   pushTimeout,
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		slots: make(chan struct{}, maxConcurrentPushPOST),
	}
}

// deliver POSTs payload to a relay registration with its token as bearer.
// done reports whether the relay said the endpoint is gone (404 or 410).
func (p *pushDeliverer) deliver(registration pushRegistration, payload []byte, done func(gone bool)) {
	p.pending.Add(1)
	go func() {
		defer p.pending.Done()
		p.slots <- struct{}{}
		defer func() { <-p.slots }()
		ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
		defer cancel()
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, registration.url, bytes.NewReader(payload))
		if err != nil {
			return
		}
		request.Header.Set("Content-Type", "application/json")
		if registration.token != "" {
			request.Header.Set("Authorization", "Bearer "+registration.token)
		}
		response, err := p.client.Do(request)
		if err != nil {
			return
		}
		response.Body.Close()
		done(response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone)
	}()
}

func (p *pushDeliverer) wait() {
	p.pending.Wait()
}
