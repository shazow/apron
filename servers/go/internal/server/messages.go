package server

import (
	"bytes"
	"encoding/json"
	"slices"
	"sort"
	"time"
)

// avatarRoomID is the room of the avatar upload convention (§4.6.6): a
// message sent there is never delivered or logged.
const avatarRoomID = "@avatar"

type reactionSet struct {
	from   map[string]any
	emojis []string
}

// messageState is the current state of one message. Only non-empty reaction
// sets are kept; clearing removes the user's entry.
type messageState struct {
	id string
	// from is the author identity of every snapshot.
	from      map[string]any
	logID     int64
	owner     string
	roomID    string
	reactions map[string]reactionSet
	// reactionLogIDs maps each user to the last reactions record that set
	// their emoji on this message, for prev_log_id.
	reactionLogIDs map[string]int64
	// records are every logged snapshot, for redaction; the last is current.
	records []*logRecord
	// introRecords are the room records embedding a snapshot of this message
	// as intro_message, for redaction.
	introRecords []*logRecord
}

// currentRaw is the JSON of the message's current snapshot.
func (m *messageState) currentRaw() json.RawMessage {
	return m.records[len(m.records)-1].raw
}

// snapshot decodes the message's current snapshot, a copy the caller owns.
func (m *messageState) snapshot() map[string]any {
	return m.records[len(m.records)-1].value()
}

// saveMessage creates a message (no message_id) or saves an existing one
// (§4.2): every client field is replaced by the submitted state. A save
// naming a different room_id moves the message; the snapshot is logged in and
// broadcast to both rooms, followed by a reactions record in the destination
// when the message has reactions. Posting in a room the author has not joined
// joins them first (§4.3.5).
func (s *Server) saveMessage(c *client, req request) (any, bool, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, false, err
	}
	messageID, err := parseString(req.params, "message_id", false)
	if err != nil {
		return nil, false, err
	}
	_, replacing := req.params["message_id"]
	if replacing && !validMessageID(messageID) {
		return nil, false, invalidParams("message_id must be a positive decimal string")
	}
	replyID, hasReply, err := parseMessageRef(req.params, "reply_to")
	if err != nil {
		return nil, false, err
	}
	deleted, err := parseBool(req.params, "deleted", false)
	if err != nil {
		return nil, false, err
	}
	if deleted && !replacing {
		return nil, false, invalidParams("Cannot create a deleted message")
	}
	var body map[string]any
	if !deleted {
		body, err = parseObject(req.params, "body", true)
		if err != nil {
			return nil, false, err
		}
		if err := validateBody(body); err != nil {
			return nil, false, err
		}
	}
	ext, err := parseObject(req.params, "ext", false)
	if err != nil {
		return nil, false, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	u := c.user
	if roomID == avatarRoomID && !replacing {
		return s.uploadAvatarLocked(c, req, body)
	}
	destination := s.rooms[roomID]
	if destination == nil {
		return nil, false, invalidParams("Unknown room %q", roomID)
	}
	from := u.from()
	var current *messageState
	if replacing {
		current = s.messages[messageID]
		if current == nil {
			return nil, false, invalidParams("Unknown message %q", messageID)
		}
		if current.owner != u.id {
			return nil, false, &rpcError{Code: codeDenied, Message: "Only the author may edit, move, or delete this message"}
		}
		from = current.from
	} else if err := s.admitPostLocked(u); err != nil {
		return nil, false, err
	}
	if hasReply {
		if _, exists := s.messages[replyID]; !exists || (replacing && replyID == messageID) {
			return nil, false, invalidParams("reply_to must name another existing message")
		}
	}

	logID := s.nextIDLocked()
	if !replacing {
		messageID = formatID(logID)
	}
	var previous map[string]any
	if current != nil {
		previous = current.snapshot()
	}
	// Embeds are resolved last: a new upload or stream embed reserves a write.
	var written []any
	if body != nil {
		var embeds []any
		embeds, written, err = s.resolveEmbedsLocked(c, messageID, previous, body)
		if err != nil {
			return nil, false, err
		}
		// body was decoded for this request, so it is the snapshot's own.
		if len(embeds) > 0 {
			body["embeds"] = embeds
		} else {
			delete(body, "embeds")
		}
	}
	s.releaseEmbedsLocked(previous, body)

	snapshot := map[string]any{
		"message_id": messageID,
		"log_id":     formatID(logID),
		"room_id":    roomID,
		"from":       from,
	}
	if deleted {
		snapshot["deleted"] = true
	} else {
		snapshot["body"] = body
	}
	if hasReply {
		snapshot["reply_to"] = map[string]any{"message_id": replyID}
	}
	if ext != nil {
		snapshot["ext"] = ext
	}

	result := map[string]any{"message_id": messageID}
	if len(written) > 0 {
		result["embeds"] = written
	}
	if req.hasID {
		c.sendResult(req, result)
	}
	if u.joined[destination.id] == nil {
		s.joinLocked(u, destination)
	}
	if current == nil {
		current = &messageState{id: messageID, from: from, owner: u.id, reactions: make(map[string]reactionSet), reactionLogIDs: make(map[string]int64)}
		s.messages[messageID] = current
	}
	moved := s.commitSnapshotLocked(current, snapshot, logID)
	if deleted {
		s.redactLocked(current)
	}
	if moved && len(current.reactions) > 0 {
		s.commitReactionsLocked(current, current.reactionElements())
	}
	if !replacing {
		s.wakeLocked(current, snapshot)
	}
	return result, true, nil
}

// commitSnapshotLocked logs and delivers a message snapshot, adding
// prev_log_id, in the message's room and, for a move, the previous one too.
// It reports whether the snapshot moved the message.
func (s *Server) commitSnapshotLocked(m *messageState, snapshot map[string]any, logID int64) bool {
	if m.logID != 0 {
		snapshot["prev_log_id"] = formatID(m.logID)
	}
	destination := s.rooms[snapshot["room_id"].(string)]
	rooms := []*roomState{destination}
	moved := m.roomID != "" && m.roomID != destination.id
	if moved {
		rooms = []*roomState{s.rooms[m.roomID], destination}
	}
	m.logID = logID
	m.roomID = destination.id
	record := newLogRecord(logID, kindMessage, snapshot)
	m.records = append(m.records, record)
	s.appendLocked(record, rooms...)
	s.deliverLocked(rawNotification("message", record.raw), rooms...)
	return moved
}

// republishLocked publishes a server-made snapshot of a message, such as a
// finished upload or stream (§4.6.3): edit rewrites a copy of the
// current body, and nothing is published when it reports no change.
func (s *Server) republishLocked(m *messageState, edit func(body map[string]any) bool) {
	snapshot := m.snapshot()
	body, _ := snapshot["body"].(map[string]any)
	if body == nil || snapshot["deleted"] == true || !edit(body) {
		return
	}
	logID := s.nextIDLocked()
	snapshot["log_id"] = formatID(logID)
	s.commitSnapshotLocked(m, snapshot, logID)
}

// redactLocked rewrites a deleted message's earlier snapshots, and the
// intro_message copies embedded in room records, into tombstones at their
// original log_ids (§4.2).
func (s *Server) redactLocked(m *messageState) {
	for _, record := range m.records {
		record.rewrite(tombstone)
	}
	for _, record := range m.introRecords {
		record.rewrite(func(value map[string]any) {
			if intro, ok := value["intro_message"].(map[string]any); ok {
				tombstone(intro)
			}
		})
	}
}

func tombstone(snapshot map[string]any) {
	if _, embedded := snapshot["log_id"]; !embedded {
		return
	}
	delete(snapshot, "body")
	snapshot["deleted"] = true
}

// admitPostLocked applies MessagesPerMinute to new messages.
func (s *Server) admitPostLocked(u *userState) *rpcError {
	limit := s.config.MessagesPerMinute
	if limit <= 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	window := int64(time.Minute / time.Millisecond)
	u.posts = slices.DeleteFunc(u.posts, func(at int64) bool { return at <= now-window })
	if len(u.posts) >= limit {
		wait := (u.posts[0] + window - now + 999) / 1000
		return &rpcError{Code: codeRetryAfter, Message: "Too many messages; slow down", Data: map[string]any{"retry_after": max(1, wait)}}
	}
	u.posts = append(u.posts, now)
	return nil
}

// reactionElements returns every non-empty reaction set, ordered by user ID.
func (m *messageState) reactionElements() []any {
	users := make([]string, 0, len(m.reactions))
	for userID := range m.reactions {
		users = append(users, userID)
	}
	sort.Strings(users)
	elements := make([]any, 0, len(users))
	for _, userID := range users {
		set := m.reactions[userID]
		elements = append(elements, map[string]any{"from": cloneObject(set.from), "emojis": slices.Clone(set.emojis)})
	}
	return elements
}

func validMessageID(id string) bool {
	if len(id) == 0 || id[0] < '1' || id[0] > '9' {
		return false
	}
	for _, ch := range id {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

// parseMessageRef reads a message reference (reply_to, intro_message). Clients
// send bare references; any other keys, such as an echoed snapshot, are ignored.
func parseMessageRef(params map[string]json.RawMessage, name string) (string, bool, *rpcError) {
	raw, present := params[name]
	if !present {
		return "", false, nil
	}
	var ref map[string]json.RawMessage
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &ref) != nil || ref == nil {
		return "", false, invalidParams("%s must be a message object", name)
	}
	id, err := parseString(ref, "message_id", true)
	if err != nil || !validMessageID(id) {
		return "", false, invalidParams("%s.message_id must be a positive decimal string", name)
	}
	return id, true, nil
}

func validateBody(body map[string]any) *rpcError {
	if raw, ok := body["text"]; ok {
		if _, ok := raw.(string); !ok {
			return invalidParams("body.text must be a string")
		}
	}
	if raw, ok := body["format"]; ok {
		format, ok := raw.(string)
		if !ok || (format != "plain" && format != "markdown") {
			return invalidParams("body.format must be plain or markdown")
		}
	}
	if raw, ok := body["embeds"]; ok {
		embeds, ok := raw.([]any)
		if !ok {
			return invalidParams("body.embeds must be an array")
		}
		for i, value := range embeds {
			embed, ok := value.(map[string]any)
			if !ok {
				return invalidParams("body.embeds[%d] must be an object", i)
			}
			if kind, ok := embed["kind"].(string); !ok || kind == "" {
				return invalidParams("body.embeds[%d].kind must be a non-empty string", i)
			}
		}
	}
	return nil
}

const (
	maxEmojiBytes    = 64
	maxDistinctEmoji = 20
)

// react replaces the caller's complete reaction set on one message
// (§4.5). Duplicates collapse; an unchanged set logs nothing.
func (s *Server) react(c *client, req request) (any, bool, *rpcError) {
	messageID, err := parseString(req.params, "message_id", true)
	if err != nil {
		return nil, false, err
	}
	emojis, err := parseEmojis(req.params)
	if err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.messages[messageID]
	if m == nil {
		return nil, false, invalidParams("Unknown message %q", messageID)
	}
	u := c.user
	result := map[string]any{}
	if req.hasID {
		c.sendResult(req, result)
	}
	if sameEmojiSet(m.reactions[u.id].emojis, emojis) {
		return result, true, nil
	}
	from := u.from()
	if len(emojis) == 0 {
		delete(m.reactions, u.id)
	} else {
		m.reactions[u.id] = reactionSet{from: from, emojis: emojis}
	}
	s.commitReactionsLocked(m, []any{map[string]any{"from": cloneObject(from), "emojis": slices.Clone(emojis)}})
	return result, true, nil
}

// commitReactionsLocked logs and delivers one reactions record in the
// message's current room. A record for one user links to that user's
// previous set with prev_log_id; a record re-logging several sets after a
// move has no single predecessor and carries none.
func (s *Server) commitReactionsLocked(m *messageState, elements []any) {
	logID := s.nextIDLocked()
	value := map[string]any{
		"log_id":     formatID(logID),
		"message_id": m.id,
		"room_id":    m.roomID,
		"reactions":  elements,
	}
	for i, element := range elements {
		userID := element.(map[string]any)["from"].(map[string]any)["user_id"].(string)
		if previous, ok := m.reactionLogIDs[userID]; ok && len(elements) == 1 && i == 0 {
			value["prev_log_id"] = formatID(previous)
		}
		m.reactionLogIDs[userID] = logID
	}
	r := s.rooms[m.roomID]
	record := newLogRecord(logID, kindReactions, value)
	s.appendLocked(record, r)
	s.deliverLocked(rawNotification("reactions", record.raw), r)
}

func parseEmojis(params map[string]json.RawMessage) ([]string, *rpcError) {
	raw, ok := params["emojis"]
	if !ok {
		return nil, invalidParams("Missing emojis")
	}
	var values []json.RawMessage
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &values) != nil {
		return nil, invalidParams("emojis must be an array of strings")
	}
	emojis := make([]string, 0, len(values))
	for _, value := range values {
		var emoji string
		if json.Unmarshal(value, &emoji) != nil || emoji == "" || len(emoji) > maxEmojiBytes {
			return nil, invalidParams("emojis must be non-empty strings of at most %d bytes", maxEmojiBytes)
		}
		if !slices.Contains(emojis, emoji) {
			emojis = append(emojis, emoji)
		}
	}
	if len(emojis) > maxDistinctEmoji {
		return nil, invalidParams("At most %d distinct emoji per message", maxDistinctEmoji)
	}
	return emojis, nil
}

func sameEmojiSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, emoji := range a {
		if !slices.Contains(b, emoji) {
			return false
		}
	}
	return true
}
