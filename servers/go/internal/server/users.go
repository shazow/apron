package server

import (
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	maxNameRunes = 64
	// maxAvatarDataURLBytes bounds an avatar given inline as a data: URL;
	// larger images go through an @avatar upload (§4.6.6).
	maxAvatarDataURLBytes = 64 << 10
	maxDedupEntries       = 1024
)

// userState is everything the server keeps for one user_id across its
// connections: the profile (§3.3), joined rooms (§4.3.2), request
// deduplication (§1.2), and push registrations (§4.7). Guest users
// are retired when their last connection closes; passkey users persist.
type userState struct {
	id     string
	name   string
	avatar string
	ext    map[string]any
	// avatarEmbed is the hosted @avatar upload behind avatar, if any.
	avatarEmbed *embedState

	// fromValue caches from(); it is cleared when the name changes.
	fromValue map[string]any

	clients map[*client]struct{}
	joined  map[string]*roomState
	dedup   dedupCache
	passkey *passkeyUser
	// posts holds recent message creation times for MessagesPerMinute.
	posts []int64
}

func newUserState(id, name string) *userState {
	return &userState{
		id:      id,
		name:    name,
		clients: make(map[*client]struct{}),
		joined:  make(map[string]*roomState),
	}
}

// from is the author identity carried in logged records: user_id and name.
// Avatars and ext travel only in you, user, and members (§4.6.6). Every
// record by the user shares the returned map until the name changes, so it
// must not be modified.
func (u *userState) from() map[string]any {
	if u.fromValue == nil {
		u.fromValue = map[string]any{"user_id": u.id}
		if u.name != "" {
			u.fromValue["name"] = u.name
		}
	}
	return u.fromValue
}

// profile is the complete user object for you, user, and members.
func (u *userState) profile() map[string]any {
	value := maps.Clone(u.from())
	if u.avatar != "" {
		value["avatar"] = u.avatar
	}
	if len(u.ext) > 0 {
		value["ext"] = cloneObject(u.ext)
	}
	return value
}

type dedupEntry struct {
	fingerprint string
	done        chan struct{}
	result      any
	err         *rpcError
}

// dedupCache keeps the most recent request IDs of one user. Guarded by s.mu.
type dedupCache struct {
	entries map[string]*dedupEntry
	order   []string
}

func (d *dedupCache) get(id string) *dedupEntry {
	return d.entries[id]
}

func (d *dedupCache) put(id string, entry *dedupEntry) {
	if d.entries == nil {
		d.entries = make(map[string]*dedupEntry)
	}
	d.entries[id] = entry
	d.order = append(d.order, id)
	for len(d.order) > maxDedupEntries {
		oldest := d.order[0]
		d.order = d.order[1:]
		if e := d.entries[oldest]; e != nil && isClosed(e.done) {
			delete(d.entries, oldest)
		}
	}
}

func (d *dedupCache) remove(id string, entry *dedupEntry) {
	if d.entries[id] == entry {
		delete(d.entries, id)
	}
}

func isClosed(done chan struct{}) bool {
	select {
	case <-done:
		return true
	default:
		return false
	}
}

// normalizeName trims a requested display name and caps its length; the
// server may alter names (§3.3) and `you.name` is the answer.
func normalizeName(name string) string {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > maxNameRunes {
		name = strings.TrimSpace(string([]rune(name)[:maxNameRunes]))
	}
	return name
}

var avatarDataURL = regexp.MustCompile(`^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$`)

// validAvatar accepts https: URLs and small image data: URLs (§4.6.6).
func validAvatar(value string) bool {
	if strings.HasPrefix(value, "data:") {
		return len(value) <= maxAvatarDataURLBytes && avatarDataURL.MatchString(value)
	}
	return strings.HasPrefix(value, "https://") && len(value) <= 2048 && !strings.ContainsAny(value, " \t\r\n\"'<>")
}

func (s *Server) authenticate(c *client, req request) (any, *rpcError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	scheme, err := parseString(req.params, "scheme", true)
	if err != nil {
		return nil, err
	}
	switch scheme {
	case "webauthn":
		return s.authenticatePasskey(c, req)
	case "token":
		if s.config.WebAuthn == nil {
			return nil, &rpcError{Code: codeUnsupported, Message: "This server has no sign-in sessions; use guest"}
		}
		return s.authenticateToken(c, req)
	case "guest":
	default:
		return nil, &rpcError{Code: codeUnsupported, Message: fmt.Sprintf("Unsupported authentication scheme %q", scheme)}
	}
	name, err := parseString(req.params, "name", false)
	if err != nil {
		return nil, err
	}
	if c.user != nil {
		result := map[string]any{"you": c.user.profile()}
		if req.hasID {
			c.sendResult(req, result)
		}
		return result, nil
	}
	s.guestNumber++
	user := newUserState(fmt.Sprintf("guest_%d", s.guestNumber), normalizeName(name))
	s.users[user.id] = user
	s.joinDefaultRoomsLocked(user)
	return s.switchUserLocked(c, req, user, nil), nil
}

// switchUserLocked makes user the connection's identity and replies with
// extra fields beside `you`, followed by room announcements (§3.2, §3.3).
// When the identity changes, rooms only the old identity had joined are
// removed. A guest identity left without connections is retired; others who
// shared a room with it learn of the change through a `user` notification.
func (s *Server) switchUserLocked(c *client, req request, user *userState, extra map[string]any) map[string]any {
	previous := c.user
	result := map[string]any{"you": user.profile()}
	maps.Copy(result, extra)
	frames := make([]any, 0, 1+len(s.roomOrder))
	if req.hasID {
		frames = append(frames, response(req.id, req.full, result))
	}
	if previous != user {
		if previous != nil {
			for _, roomID := range s.roomOrder {
				if previous.joined[roomID] != nil && user.joined[roomID] == nil {
					frames = append(frames, map[string]any{"method": "room", "params": map[string]any{"room_id": roomID, "removed": true}})
				}
			}
			delete(previous.clients, c)
		}
		c.user = user
		user.clients[c] = struct{}{}
	}
	for _, roomID := range s.roomOrder {
		if r := user.joined[roomID]; r != nil {
			frames = append(frames, s.announcementFramesLocked(r)...)
		}
	}
	c.enqueueBatch(frames...)
	if previous != nil && previous != user && len(previous.clients) == 0 && previous.passkey == nil {
		old := previous.profile()
		frame := map[string]any{"method": "user", "params": map[string]any{"new": user.profile(), "old": old}}
		for _, other := range s.sharersLocked(previous) {
			if other != user {
				other.send(frame)
			}
		}
		s.retireLocked(previous)
	}
	return result
}

// detachLocked forgets a closed connection, retiring its guest identity.
func (s *Server) detachLocked(c *client) {
	user := c.user
	if user == nil {
		return
	}
	delete(user.clients, c)
	c.user = nil
	if len(user.clients) == 0 && user.passkey == nil {
		s.retireLocked(user)
	}
}

// retireLocked removes a guest identity for good. Its user_id is never
// reissued; its records keep it (§3.3).
func (s *Server) retireLocked(u *userState) {
	for _, r := range u.joined {
		delete(r.members, u.id)
		delete(r.reads, u.id)
	}
	clear(u.joined)
	for key, registration := range s.pushes {
		if registration.userID == u.id {
			delete(s.pushes, key)
		}
	}
	s.setAvatarEmbedLocked(u, nil)
	delete(s.users, u.id)
}

// send queues a frame to every connection of the user.
func (u *userState) send(frames ...any) {
	for c := range u.clients {
		c.enqueueBatch(frames...)
	}
}

// sharersLocked lists the other users who share a joined room with u.
func (s *Server) sharersLocked(u *userState) []*userState {
	seen := make(map[string]*userState)
	for _, r := range u.joined {
		for id, member := range r.members {
			if id != u.id {
				seen[id] = member
			}
		}
	}
	ids := slices.Sorted(maps.Keys(seen))
	users := make([]*userState, len(ids))
	for i, id := range ids {
		users[i] = seen[id]
	}
	return users
}

// notifyProfileLocked sends a `user` notification after a profile change:
// `you` to the user's other connections and `new` to everyone who shares a
// room with them (§3.3).
func (s *Server) notifyProfileLocked(u *userState, except *client) {
	you := map[string]any{"method": "user", "params": map[string]any{"you": u.profile()}}
	for c := range u.clients {
		if c != except {
			c.enqueue(you)
		}
	}
	others := notification("user", map[string]any{"new": u.profile()})
	for _, other := range s.sharersLocked(u) {
		other.send(others)
	}
}

// updateProfile applies a `me` request (§3.3). Given fields replace the
// current ones, omitted fields stay, and an empty value removes the field.
// Names are trimmed and capped; avatars must be https: URLs or small image
// data: URLs, or the current avatar unchanged.
func (s *Server) updateProfile(c *client, req request) (any, bool, *rpcError) {
	name, err := parseString(req.params, "name", false)
	if err != nil {
		return nil, false, err
	}
	avatar, err := parseString(req.params, "avatar", false)
	if err != nil {
		return nil, false, err
	}
	ext, err := parseObject(req.params, "ext", false)
	if err != nil {
		return nil, false, err
	}
	_, hasName := req.params["name"]
	_, hasAvatar := req.params["avatar"]

	s.mu.Lock()
	defer s.mu.Unlock()
	u := c.user
	if hasAvatar && avatar != "" && avatar != u.avatar && !validAvatar(avatar) {
		return nil, false, invalidParams("avatar must be an https: URL or a data:image URL of at most %d bytes; upload larger images to room @avatar", maxAvatarDataURLBytes)
	}
	before := u.profile()
	if hasName {
		u.name = normalizeName(name)
		u.fromValue = nil
	}
	if hasAvatar && avatar != u.avatar {
		s.setAvatarEmbedLocked(u, nil)
		u.avatar = avatar
	}
	if ext != nil {
		u.ext = ext
		if len(ext) == 0 {
			u.ext = nil
		}
	}
	result := map[string]any{"you": u.profile()}
	if !jsonEqual(before, result["you"]) {
		s.notifyProfileLocked(u, c)
	}
	return result, false, nil
}

func jsonEqual(a, b any) bool {
	left, errLeft := json.Marshal(a)
	right, errRight := json.Marshal(b)
	return errLeft == nil && errRight == nil && string(left) == string(right)
}
