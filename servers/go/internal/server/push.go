package server

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	maxPushTextRunes = 1000
	maxPushesPerUser = 10
	maxPushURLBytes  = 2048
	maxPushTokenLen  = 4096
	pushTimeout      = 10 * time.Second
	// Deliveries run in lanes per relay host, at most maxPushPerHost at once
	// to one host, and at most maxConcurrentPushPOST in all. A user has at
	// most maxPushQueuedPerUser deliveries waiting or running, and the server
	// at most maxPushQueued; beyond them a delivery is dropped, as pushes are
	// best effort.
	maxConcurrentPushPOST = 32
	maxPushPerHost        = 8
	maxPushQueuedPerUser  = 20
	maxPushQueued         = 1024
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
	if len(endpoint) > maxPushURLBytes || len(token) > maxPushTokenLen {
		return nil, false, invalidParams("url is at most %d bytes and token at most %d", maxPushURLBytes, maxPushTokenLen)
	}
	if problem := s.checkPushURL(endpoint); problem != "" {
		return nil, false, invalidParams("%s", problem)
	}
	s.mu.Lock()
	defer s.unlock()
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
	s.touchPush(endpoint)
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
	defer s.unlock()
	if registration := s.pushes[endpoint]; registration != nil && registration.userID == c.user.id {
		delete(s.pushes, endpoint)
		s.touchPush(endpoint)
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
					s.touchPush(registration.url)
				}
				s.unlock()
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
	return encodeJSON(value)
}

// pushDeliverer POSTs push payloads in the background, off the paths that
// deliver messages. Each relay host has its own lane of bounded concurrency,
// so a slow or stalling relay delays only pushes to itself. Unless insecure
// pushes are allowed, it refuses to connect to loopback, private,
// link-local, and other non-public addresses, checked on the dialed address
// so DNS cannot redirect it.
type pushDeliverer struct {
	client  *http.Client
	slots   chan struct{}
	pending sync.WaitGroup

	mu     sync.Mutex
	queued int
	users  map[string]int
	hosts  map[string]*pushLane
}

// pushLane bounds concurrent deliveries to one relay host; queued counts the
// deliveries waiting for it or running, so an unused lane is forgotten.
type pushLane struct {
	slots  chan struct{}
	queued int
}

// nonPublicPrefixes are special-purpose ranges that netip's classification
// does not already exclude: shared address space (CGNAT), IETF protocol
// assignments, benchmarking, the reserved class E range, and IPv6
// translation and tunneling prefixes that embed IPv4 addresses.
var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2002::/16"),
}

// publicAddress reports whether a dialed address is on the public internet.
func publicAddress(host string) bool {
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() {
		return false
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func newPushDeliverer(allowInternal bool) *pushDeliverer {
	dialer := &net.Dialer{Timeout: pushTimeout}
	if !allowInternal {
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if !publicAddress(host) {
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
		users: make(map[string]int),
		hosts: make(map[string]*pushLane),
	}
}

// deliver POSTs payload to a relay registration with its token as bearer.
// done reports whether the relay said the endpoint is gone (404 or 410). A
// delivery beyond the user's or the server's queue bound is dropped.
func (p *pushDeliverer) deliver(registration pushRegistration, payload []byte, done func(gone bool)) {
	parsed, err := url.Parse(registration.url)
	if err != nil {
		return
	}
	host := parsed.Host
	p.mu.Lock()
	if p.queued >= maxPushQueued || p.users[registration.userID] >= maxPushQueuedPerUser {
		p.mu.Unlock()
		return
	}
	p.queued++
	p.users[registration.userID]++
	lane := p.hosts[host]
	if lane == nil {
		lane = &pushLane{slots: make(chan struct{}, maxPushPerHost)}
		p.hosts[host] = lane
	}
	lane.queued++
	p.mu.Unlock()
	p.pending.Add(1)
	go func() {
		defer p.pending.Done()
		defer p.release(registration.userID, host, lane)
		// The host's lane first, then a shared slot: a stalled host holds at
		// most its lane's share of the slots.
		lane.slots <- struct{}{}
		defer func() { <-lane.slots }()
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

// release ends a delivery's accounting, forgetting an unused host lane.
func (p *pushDeliverer) release(userID, host string, lane *pushLane) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.queued--
	if p.users[userID]--; p.users[userID] == 0 {
		delete(p.users, userID)
	}
	if lane.queued--; lane.queued == 0 {
		delete(p.hosts, host)
	}
}

func (p *pushDeliverer) wait() {
	p.pending.Wait()
}
