package server

import (
	"cmp"
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"strings"
)

const (
	// maxListedMembers caps `members` in each room_list entry (§4.3.1).
	maxListedMembers = 100
	// maxListedRooms caps `rooms`, the unjoined rooms of a room_list result;
	// `joined` is never truncated (§4.3.1).
	maxListedRooms = 200
)

// roomState is a room's current record, its log, and its members. Every room,
// including threads (rooms with parent_room_id), is visible to every
// authenticated user; members are the users who have joined it and receive
// its deliveries (§3.4, §4.3.2).
type roomState struct {
	id       string
	parent   *roomState
	children []*roomState
	// record holds the latest logged room record with a bare intro_message.
	record      map[string]any
	recordLogID int64
	createdID   int64
	latestID    int64
	log         []*logRecord
	members     map[string]*userState
	// creator is the user_id that created the room, empty for the seeded
	// room; only the creator may /kick (§4.8).
	creator string
	// reads holds each user's latest read cursor (§4.4).
	reads map[string]readCursor
}

type readCursor struct {
	from      map[string]any
	messageID string
	id        int64
}

// deliveryFields returns the room's log head and the inclusive lower bound of
// retained history. The Go server retains every record, so history always
// starts at the room's creation record. Callers hold s.mu.
func (r *roomState) deliveryFields() map[string]any {
	return map[string]any{
		"latest_log_id":  formatID(r.latestID),
		"history_log_id": formatID(r.createdID),
	}
}

// title is the room's display title, falling back to its room_id (§3.4).
func (r *roomState) title() string {
	if title, _ := r.record["title"].(string); title != "" {
		return title
	}
	return r.id
}

// cursorFramesLocked renders the read cursors kept for a room that the
// server sends after listing it (§4.4): every member's cursor for a room u
// has joined, which delivers read receipts, and otherwise only u's own.
func (s *Server) cursorFramesLocked(u *userState, r *roomState) []any {
	var frames []any
	for _, userID := range slices.Sorted(maps.Keys(r.reads)) {
		if u.joined[r.id] == nil && userID != u.id {
			continue
		}
		cursor := r.reads[userID]
		frames = append(frames, map[string]any{"method": "activity", "params": map[string]any{
			"room_id": r.id, "from": cloneObject(cursor.from), "read_message_id": cursor.messageID,
		}})
	}
	return frames
}

// roomParamsLocked renders a room's current record with delivery fields, its
// bare intro_message replaced by the message's current snapshot. Only the
// top level is new: nested values are shared with records that are replaced
// rather than modified, so the result may be encoded after s.mu is released.
func (s *Server) roomParamsLocked(r *roomState) map[string]any {
	params := maps.Clone(r.record)
	if intro, ok := params["intro_message"].(map[string]any); ok {
		if m := s.messages[intro["message_id"].(string)]; m != nil {
			params["intro_message"] = m.currentRaw()
		}
	}
	maps.Copy(params, r.deliveryFields())
	return params
}

// embedIntroLocked returns a shallow copy of a room record whose bare
// intro_message reference is replaced by the JSON of the referenced message's
// current snapshot.
func (s *Server) embedIntroLocked(record map[string]any) map[string]any {
	value := maps.Clone(record)
	if intro, ok := value["intro_message"].(map[string]any); ok {
		if id, ok := intro["message_id"].(string); ok {
			if m := s.messages[id]; m != nil {
				value["intro_message"] = m.currentRaw()
			}
		}
	}
	return value
}

// deliverLocked sends a frame to every connection of every member of the
// given rooms, once per connection. The frame is encoded once for all of them.
func (s *Server) deliverLocked(frame any, rooms ...*roomState) {
	frame = render(frame)
	seen := make(map[string]bool)
	for _, r := range rooms {
		for id, member := range r.members {
			if !seen[id] {
				seen[id] = true
				member.send(frame)
			}
		}
	}
}

// render encodes a frame once for sending to many connections.
func render(frame any) json.RawMessage {
	if payload, rendered := frame.(json.RawMessage); rendered {
		return payload
	}
	payload, _ := json.Marshal(frame)
	return payload
}

// roomUpdate renders a room_update notification (§4.3.3) with one field.
func roomUpdate(field string, records ...any) json.RawMessage {
	return notification("room_update", map[string]any{field: records})
}

// addMemberLocked joins u to r and announces the join to the room's other
// members with a `user` notification carrying room_id (§4.3.2). It reports
// whether u was not a member before.
func (s *Server) addMemberLocked(u *userState, r *roomState) bool {
	if u.joined[r.id] != nil {
		return false
	}
	announcement := notification("user", map[string]any{"room_id": r.id, "new": u.profile()})
	for _, member := range r.members {
		member.send(announcement)
	}
	u.joined[r.id] = r
	r.members[u.id] = u
	return true
}

// joinLocked joins u to r and sends the room to all of u's connections as a
// room_update (§4.3.3). It reports whether u was not a member before.
func (s *Server) joinLocked(u *userState, r *roomState) bool {
	if !s.addMemberLocked(u, r) {
		return false
	}
	u.send(roomUpdate("joined", s.roomParamsLocked(r)))
	return true
}

// leaveLocked removes u from r: u's connections receive room_update left, the
// remaining members a `user` notification with room_id and `old`, and those
// who no longer share any room with u one with `old` alone (§3.3, §4.3.2).
func (s *Server) leaveLocked(u *userState, r *roomState) bool {
	if u.joined[r.id] == nil {
		return false
	}
	delete(u.joined, r.id)
	delete(r.members, u.id)
	u.send(roomUpdate("left", map[string]any{"room_id": r.id}))
	old := map[string]any{"user_id": u.id}
	left := notification("user", map[string]any{"room_id": r.id, "old": old})
	gone := notification("user", map[string]any{"old": old})
	for _, member := range r.members {
		if sharesRoom(u, member) {
			member.send(left)
		} else {
			member.send(left, gone)
		}
	}
	return true
}

// sharesRoom reports whether two users have joined a common room.
func sharesRoom(a, b *userState) bool {
	if len(a.joined) > len(b.joined) {
		a, b = b, a
	}
	for id := range a.joined {
		if b.joined[id] != nil {
			return true
		}
	}
	return false
}

// commitRoomLocked logs a room record holding fields, the client fields other
// than parent_room_id. An unknown roomID creates the room; an empty one names
// it by its creation log_id. The logged record's intro_message embeds the
// snapshot current at commit time.
func (s *Server) commitRoomLocked(roomID string, parent *roomState, fields map[string]any) *roomState {
	logID := s.nextIDLocked()
	r := s.rooms[roomID]
	if r == nil {
		if roomID == "" {
			roomID = formatID(logID)
		}
		r = &roomState{id: roomID, parent: parent, createdID: logID, members: make(map[string]*userState), reads: make(map[string]readCursor)}
		s.rooms[roomID] = r
		s.roomOrder = append(s.roomOrder, roomID)
		if parent != nil {
			parent.children = append(parent.children, r)
		}
	}
	record := map[string]any{"room_id": r.id, "log_id": formatID(logID)}
	if r.recordLogID != 0 {
		record["prev_log_id"] = formatID(r.recordLogID)
	}
	if r.parent != nil {
		record["parent_room_id"] = r.parent.id
	}
	maps.Copy(record, fields)
	r.record = record
	r.recordLogID = logID
	logged := newLogRecord(logID, kindRoom, s.embedIntroLocked(record))
	s.appendLocked(logged, r)
	if intro, ok := fields["intro_message"].(map[string]any); ok {
		// Deleting the intro message redacts the copy embedded here.
		m := s.messages[intro["message_id"].(string)]
		m.introRecords = append(m.introRecords, logged)
	}
	return r
}

// setRoom creates a room (no room_id) or replaces an existing room's client
// fields (§4.3.4). parent_room_id is fixed at creation and ignored on
// updates. Any authenticated user may create rooms and threads and update any
// room's client fields.
//
// A new room joins only its creator, whose connections receive it as
// room_update joined; a new thread goes to the parent's other members as
// room_update updated, without joining them. An edit goes as updated to the
// room's members, to the parent's members for a thread, and to the editor.
func (s *Server) setRoom(c *client, req request) (any, bool, *rpcError) {
	_, updating := req.params["room_id"]
	var roomID, parentID string
	var err *rpcError
	if updating {
		roomID, err = parseString(req.params, "room_id", true)
		if err != nil {
			return nil, false, err
		}
	} else if _, present := req.params["parent_room_id"]; present {
		parentID, err = parseString(req.params, "parent_room_id", true)
		if err != nil {
			return nil, false, err
		}
		if parentID == "" {
			return nil, false, invalidParams("parent_room_id must be a non-empty string")
		}
	}
	title, err := parseString(req.params, "title", false)
	if err != nil {
		return nil, false, err
	}
	introID, hasIntro, err := parseMessageRef(req.params, "intro_message")
	if err != nil {
		return nil, false, err
	}
	ext, err := parseObject(req.params, "ext", false)
	if err != nil {
		return nil, false, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	u := c.user
	var parent *roomState
	if updating {
		existing := s.rooms[roomID]
		if existing == nil {
			return nil, false, invalidParams("Unknown room %q", roomID)
		}
		parent = existing.parent
	} else if parentID != "" {
		if parent = s.rooms[parentID]; parent == nil {
			return nil, false, invalidParams("Unknown parent room %q", parentID)
		}
	}
	if hasIntro && s.messages[introID] == nil {
		return nil, false, invalidParams("Unknown intro_message %q", introID)
	}
	fields := make(map[string]any)
	if title == "" && parent != nil {
		// Servers title threads so clients unaware of parent_room_id render them.
		title = s.threadTitleLocked(introID)
	}
	if title != "" {
		fields["title"] = title
	}
	if hasIntro {
		fields["intro_message"] = map[string]any{"message_id": introID}
	}
	if ext != nil {
		fields["ext"] = ext
	}
	r := s.commitRoomLocked(roomID, parent, fields)
	if !updating {
		r.creator = u.id
	}
	// Room updates precede the result, so the room is known when it arrives.
	if updating {
		audience := maps.Clone(r.members)
		if parent != nil {
			maps.Copy(audience, parent.members)
		}
		audience[u.id] = u
		frame := roomUpdate("updated", s.roomParamsLocked(r))
		for _, member := range audience {
			member.send(frame)
		}
	} else {
		s.joinLocked(u, r)
		if parent != nil {
			frame := roomUpdate("updated", s.roomParamsLocked(r))
			for id, member := range parent.members {
				if id != u.id {
					member.send(frame)
				}
			}
		}
	}
	result := map[string]any{"room_id": r.id}
	if req.hasID {
		c.sendResult(req, result)
	}
	return result, true, nil
}

const maxThreadTitleRunes = 60

// threadTitleLocked derives a default thread title from the intro message's
// first line of text.
func (s *Server) threadTitleLocked(introID string) string {
	if m := s.messages[introID]; m != nil {
		if body, ok := m.snapshot()["body"].(map[string]any); ok {
			text, _ := body["text"].(string)
			line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
			line = strings.TrimSpace(line)
			if runes := []rune(line); len(runes) > maxThreadTitleRunes {
				line = strings.TrimSpace(string(runes[:maxThreadTitleRunes])) + "…"
			}
			if line != "" {
				return line
			}
		}
	}
	return "Thread"
}

// listRooms answers room_list (§4.3.1): the rooms matching its filters,
// joined ones in `joined` (never truncated) and visible unjoined ones in
// `rooms` (the most recently active maxListedRooms), each most recently
// active first. Every room carries member_count and up to maxListedMembers
// bare members, whose complete objects are in `users`. The result is
// followed by the read cursors kept for the listed rooms (§4.4).
func (s *Server) listRooms(c *client, req request) (any, bool, *rpcError) {
	onlyJoined, err := parseBool(req.params, "only_joined", false)
	if err != nil {
		return nil, false, err
	}
	notJoined, err := parseBool(req.params, "not_joined", false)
	if err != nil {
		return nil, false, err
	}
	parentID, err := parseString(req.params, "parent_room_id", false)
	if err != nil {
		return nil, false, err
	}
	_, hasParent := req.params["parent_room_id"]
	roomID, err := parseString(req.params, "room_id", false)
	if err != nil {
		return nil, false, err
	}
	_, hasRoom := req.params["room_id"]
	since, hasSince, err := parseBound(req.params, "latest_log_id")
	if err != nil {
		return nil, false, err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	u := c.user
	var candidates []*roomState
	switch {
	case hasRoom:
		r := s.rooms[roomID]
		if r == nil {
			return nil, false, invalidParams("Unknown room %q", roomID)
		}
		candidates = []*roomState{r}
	case hasParent:
		parent := s.rooms[parentID]
		if parent == nil {
			return nil, false, invalidParams("Unknown parent room %q", parentID)
		}
		candidates = parent.children
	default:
		candidates = make([]*roomState, 0, len(s.roomOrder))
		for _, id := range s.roomOrder {
			candidates = append(candidates, s.rooms[id])
		}
	}
	var joined, others []*roomState
	for _, r := range candidates {
		switch {
		case hasSince && r.latestID <= since:
		case u.joined[r.id] != nil:
			if !notJoined {
				joined = append(joined, r)
			}
		case onlyJoined:
		case hasRoom || hasParent || r.parent == nil:
			// Without parent_room_id, unjoined threads are left to their
			// parent's listing.
			others = append(others, r)
		}
	}
	byActivity := func(a, b *roomState) int {
		return cmp.Or(cmp.Compare(b.latestID, a.latestID), cmp.Compare(b.createdID, a.createdID))
	}
	slices.SortFunc(joined, byActivity)
	slices.SortFunc(others, byActivity)
	if len(others) > maxListedRooms {
		others = others[:maxListedRooms]
	}

	users := make(map[string]*userState)
	renderRooms := func(rooms []*roomState) []any {
		entries := make([]any, len(rooms))
		for i, r := range rooms {
			entry := s.roomParamsLocked(r)
			ids := slices.Sorted(maps.Keys(r.members))
			entry["member_count"] = len(ids)
			if len(ids) > maxListedMembers {
				ids = ids[:maxListedMembers]
			}
			members := make([]any, len(ids))
			for j, id := range ids {
				members[j] = map[string]any{"user_id": id}
				users[id] = r.members[id]
			}
			entry["members"] = members
			entries[i] = entry
		}
		return entries
	}
	result := map[string]any{}
	if !notJoined {
		result["joined"] = renderRooms(joined)
	}
	if !onlyJoined {
		result["rooms"] = renderRooms(others)
	}
	if len(users) > 0 {
		result["users"] = profiles(users)
	}
	frames := []any{response(req.id, req.full, result)}
	for _, r := range slices.Concat(joined, others) {
		frames = append(frames, s.cursorFramesLocked(u, r)...)
	}
	if !req.hasID {
		frames = frames[1:]
	}
	c.enqueueBatch(frames...)
	return result, true, nil
}

// profiles lists users' complete objects ordered by user_id, for a result's
// `users` (§3.3).
func profiles(users map[string]*userState) []any {
	list := make([]any, 0, len(users))
	for _, id := range slices.Sorted(maps.Keys(users)) {
		list = append(list, users[id].profile())
	}
	return list
}

// joinRoom joins a visible room (§4.3.2): the user's connections receive
// room_update joined, and the room's members a `user` notification. Joining a
// room already joined re-sends its record to the calling connection only.
func (s *Server) joinRoom(c *client, req request) (any, bool, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.rooms[roomID]
	if r == nil {
		return nil, false, invalidParams("Unknown room %q", roomID)
	}
	if !s.joinLocked(c.user, r) {
		c.enqueue(roomUpdate("joined", s.roomParamsLocked(r)))
	}
	result := map[string]any{}
	if req.hasID {
		c.sendResult(req, result)
	}
	return result, true, nil
}

// leaveRoom leaves a room (§4.3.2); it stays visible in room_list. Leaving a
// room not joined changes nothing.
func (s *Server) leaveRoom(c *client, req request) (any, bool, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.rooms[roomID]
	if r == nil {
		return nil, false, invalidParams("Unknown room %q", roomID)
	}
	s.leaveLocked(c.user, r)
	result := map[string]any{}
	if req.hasID {
		c.sendResult(req, result)
	}
	return result, true, nil
}

// history returns a window of one room's log (§4.1), the default room's
// without room_id. limit counts records of every kind; the slice is
// partitioned into rooms, entries, and reactions, and `users` holds the
// current objects of the page's authors and reactors. The server retains all
// records and does not compact. Every room is visible, so history needs no
// membership.
//
// A window bounded to one log_id (after == before) returns that record even
// when it left the room's log, such as a moved message's earlier snapshot,
// so prev_log_id walks back through every record of a key (§2).
func (s *Server) history(c *client, req request) (any, bool, *rpcError) {
	roomID, err := parseString(req.params, "room_id", false)
	if err != nil {
		return nil, false, err
	}
	if _, has := req.params["room_id"]; !has {
		roomID = defaultRoomID
	}
	after, hasAfter, err := parseBound(req.params, "after")
	if err != nil {
		return nil, false, err
	}
	before, hasBefore, err := parseBound(req.params, "before")
	if err != nil {
		return nil, false, err
	}
	limit, err := parseLimit(req.params, s.config.HistoryPageSize)
	if err != nil {
		return nil, false, err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	r := s.rooms[roomID]
	if r == nil {
		return nil, false, invalidParams("Unknown room %q", roomID)
	}
	matching := window(r.log, after, hasAfter, before, hasBefore)
	if len(matching) == 0 && hasAfter && hasBefore && after == before {
		for _, id := range s.roomOrder {
			if found := window(s.rooms[id].log, after, true, before, true); len(found) > 0 {
				matching = found
				break
			}
		}
	}
	more := len(matching) > limit
	if more {
		if hasAfter {
			matching = matching[:limit]
		} else {
			matching = matching[len(matching)-limit:]
		}
	}
	rooms := make([]any, 0)
	entries := make([]any, 0, len(matching))
	reactions := make([]any, 0)
	authors := make(map[string]*userState)
	for _, record := range matching {
		switch record.kind {
		case kindRoom:
			rooms = append(rooms, record.raw)
		case kindMessage:
			entries = append(entries, record.raw)
		case kindReactions:
			reactions = append(reactions, record.raw)
		}
		for _, id := range record.users() {
			if u := s.users[id]; u != nil {
				authors[id] = u
			}
		}
	}
	result := map[string]any{"rooms": rooms, "entries": entries, "reactions": reactions, "more": more}
	maps.Copy(result, r.deliveryFields())
	if len(matching) > 0 {
		result["first_id"] = formatID(matching[0].id)
		result["last_id"] = formatID(matching[len(matching)-1].id)
	}
	if len(authors) > 0 {
		result["users"] = profiles(authors)
	}
	if req.hasID {
		c.sendResult(req, result)
	}
	return result, true, nil
}

// window returns the records of a log, which is in log_id order, within the
// inclusive bounds.
func window(log []*logRecord, after int64, hasAfter bool, before int64, hasBefore bool) []*logRecord {
	if hasAfter {
		start, _ := slices.BinarySearchFunc(log, after, compareLogID)
		log = log[start:]
	}
	if hasBefore {
		end, found := slices.BinarySearchFunc(log, before, compareLogID)
		if found {
			end++
		}
		log = log[:end]
	}
	return log
}

func compareLogID(record *logRecord, id int64) int {
	return cmp.Compare(record.id, id)
}

func parseBound(params map[string]json.RawMessage, name string) (int64, bool, *rpcError) {
	raw, ok := params[name]
	if !ok {
		return 0, false, nil
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return 0, false, invalidParams("%s must be a decimal string", name)
	}
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil || number < 0 {
		return 0, false, invalidParams("%s must be a non-negative decimal string", name)
	}
	return number, true, nil
}

func parseLimit(params map[string]json.RawMessage, defaultLimit int) (int, *rpcError) {
	raw, ok := params["limit"]
	if !ok {
		return defaultLimit, nil
	}
	var value int
	if json.Unmarshal(raw, &value) != nil || value <= 0 {
		return 0, invalidParams("limit must be a positive integer")
	}
	return min(value, maxHistoryPageSize), nil
}

// activity applies a connection's activity (§4.4). typing and a read cursor
// in a room are relayed to the room's members; a read cursor must name a
// message and only advances, and the server keeps the latest per user and
// sends it after the room is listed. A frame whose fields change nothing
// relays nothing. away is kept per connection for push decisions and never
// delivered; typing and a read cursor end it.
func (s *Server) activity(c *client, req request) (any, bool, *rpcError) {
	roomID, err := parseString(req.params, "room_id", false)
	if err != nil {
		return nil, false, err
	}
	if _, has := req.params["room_id"]; !has {
		roomID = defaultRoomID
	}
	var typing any
	if raw, ok := req.params["typing"]; ok {
		var value int
		if json.Unmarshal(raw, &value) != nil || value < 0 {
			return nil, false, invalidParams("typing must be a non-negative integer")
		}
		typing = value
	}
	readID, err := parseString(req.params, "read_message_id", false)
	if err != nil {
		return nil, false, err
	}
	_, hasRead := req.params["read_message_id"]
	away, err := parseBool(req.params, "away", false)
	if err != nil {
		return nil, false, err
	}
	_, hasAway := req.params["away"]
	s.mu.Lock()
	defer s.mu.Unlock()
	inRoom := typing != nil || hasRead
	r := s.rooms[roomID]
	if inRoom && r == nil {
		return nil, false, invalidParams("Unknown room %q", roomID)
	}
	if hasRead && s.messages[readID] == nil {
		return nil, false, invalidParams("Unknown read_message_id %q", readID)
	}
	result := map[string]any{}
	if req.hasID {
		c.sendResult(req, result)
	}
	if inRoom {
		c.away = false
	}
	if hasAway {
		c.away = away
	}
	if !inRoom {
		return result, true, nil
	}
	u := c.user
	params := map[string]any{"room_id": roomID, "from": u.from()}
	if typing != nil {
		params["typing"] = typing
	}
	if hasRead {
		id, _ := strconv.ParseInt(readID, 10, 64)
		if cursor, ok := r.reads[u.id]; !ok || id > cursor.id {
			r.reads[u.id] = readCursor{from: u.from(), messageID: readID, id: id}
			if u.joined[r.id] == nil {
				// A cursor for a room the user has not joined still syncs
				// across their own connections.
				u.send(map[string]any{"method": "activity", "params": map[string]any{"room_id": roomID, "from": u.from(), "read_message_id": readID}})
			}
			params["read_message_id"] = readID
		}
	}
	if len(params) > 2 {
		s.deliverLocked(map[string]any{"method": "activity", "params": params}, r)
	}
	return result, true, nil
}
