package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
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

// pushRegistration is one `relay` endpoint (Appendix F), keyed by its url.
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

// wakeLocked wakes users who have no connection when a new message mentions
// them (Appendix J.3) or replies to one of their messages. Wake policy is
// server-defined (Appendix F).
func (s *Server) wakeLocked(m *messageState, snapshot map[string]any) {
	if len(s.pushes) == 0 {
		return
	}
	targets := make(map[string]bool)
	body, _ := snapshot["body"].(map[string]any)
	text, _ := body["text"].(string)
	format, _ := body["format"].(string)
	for _, id := range mentionedIDs(text, format == "markdown") {
		targets[id] = true
	}
	if ref, ok := snapshot["reply_to"].(map[string]any); ok {
		if target := s.messages[ref["message_id"].(string)]; target != nil {
			targets[target.owner] = true
		}
	}
	delete(targets, m.owner)
	var payload []byte
	for _, registration := range s.pushes {
		user := s.users[registration.userID]
		if !targets[registration.userID] || user == nil || len(user.clients) > 0 {
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
// its text truncated (Appendix F).
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

var (
	mentionPattern = regexp.MustCompile(`@(@?[A-Za-z0-9_.-]+)`)
	fencedCode     = regexp.MustCompile("(?s)(^|\n)(```|~~~).*?(\n(```|~~~)|$)")
	inlineCode     = regexp.MustCompile("`[^`\n]*`")
)

// mentionedIDs finds `@id` mentions (Appendix J.3): not preceded by a letter
// or digit, without trailing `.` or `-`, and outside Markdown code.
func mentionedIDs(text string, markdown bool) []string {
	if markdown {
		text = fencedCode.ReplaceAllString(text, "\n")
		text = inlineCode.ReplaceAllString(text, " ")
	}
	var ids []string
	for _, match := range mentionPattern.FindAllStringSubmatchIndex(text, -1) {
		if start := match[0]; start > 0 {
			previous, _ := utf8.DecodeLastRuneInString(text[:start])
			if isWordRune(previous) {
				continue
			}
		}
		id := strings.TrimRight(text[match[2]:match[3]], ".-")
		if id != "" && id != "@" {
			ids = append(ids, id)
		}
	}
	return ids
}

func isWordRune(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9'
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
