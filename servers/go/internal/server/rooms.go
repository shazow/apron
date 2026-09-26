package server

import (
	"cmp"
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"strings"
)

// maxListedRooms caps `not_joined` in a room_list result; `joined` is never
// truncated (§4.3.1).
const maxListedRooms = 200

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
	// titleFrom is the message_id of the intro message the current title was
	// derived from, empty for a title the client chose.
	titleFrom string
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

// logMembershipLocked logs one membership record (§4.3.2) of u in r,
// advancing the room's latest_log_id, and returns its notification for
// delivery. The record carries u as a recorded object: user_id and name.
func (s *Server) logMembershipLocked(u *userState, r *roomState, joined bool) json.RawMessage {
	logID := s.nextIDLocked()
	record := newLogRecord(logID, kindMembership, map[string]any{
		"log_id":  formatID(logID),
		"room_id": r.id,
		"members": []any{map[string]any{"user": u.from(), "joined": joined}},
	})
	s.appendLocked(record, r)
	if !joined {
		u.leftAt[r.id] = logID
	}
	return rawNotification("membership", record.raw)
}

// addMemberLocked joins u to r and delivers the logged membership to the
// room's members, u's connections included (§4.3.2). It reports whether u
// was not a member before.
func (s *Server) addMemberLocked(u *userState, r *roomState) bool {
	if u.joined[r.id] != nil {
		return false
	}
	u.joined[r.id] = r
	r.members[u.id] = u
	delete(u.leftAt, r.id)
	s.deliverLocked(s.logMembershipLocked(u, r, true), r)
	return true
}

// joinLocked joins u to r: the membership goes to the room's members, then
// the room to all of u's connections as room_update joined (§4.3.3). It
// reports whether u was not a member before.
func (s *Server) joinLocked(u *userState, r *roomState) bool {
	if !s.addMemberLocked(u, r) {
		return false
	}
	u.send(s.joinedUpdateLocked(r))
	return true
}

// joinedUpdateLocked renders room_update joined for r: its record with its
// complete members, as bare user objects, and their current objects in
// `users` (§4.3.3).
func (s *Server) joinedUpdateLocked(r *roomState) json.RawMessage {
	record := s.roomParamsLocked(r)
	record["members"] = memberRefs(r)
	return notification("room_update", map[string]any{"joined": []any{record}, "users": profiles(r.members)})
}

// memberRefs lists a room's members as user objects carrying only user_id,
// ordered by user_id.
func memberRefs(r *roomState) []any {
	ids := slices.Sorted(maps.Keys(r.members))
	refs := make([]any, len(ids))
	for i, id := range ids {
		refs[i] = map[string]any{"user_id": id}
	}
	return refs
}

// leaveLocked removes u from r (§4.3.2): the logged membership goes to the
// room's members, u's connections included, and then u's connections
// receive room_update left. It reports whether u was a member.
func (s *Server) leaveLocked(u *userState, r *roomState) bool {
	if u.joined[r.id] == nil {
		return false
	}
	s.deliverLocked(s.logMembershipLocked(u, r, false), r)
	delete(u.joined, r.id)
	delete(r.members, u.id)
	u.send(roomUpdate("left", map[string]any{"room_id": r.id}))
	return true
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
	value := maps.Clone(record)
	delete(value, "intro_message")
	logged := newLogRecord(logID, kindRoom, value)
	if intro, ok := fields["intro_message"].(map[string]any); ok {
		// The record embeds the intro snapshot current now, by reference, so
		// deleting the intro message redacts it here too (§4.2).
		m := s.messages[intro["message_id"].(string)]
		logged.intro = m.records[len(m.records)-1]
	}
	s.appendLocked(logged, r)
	return r
}

// announceRoomLocked sends a room's current record as room_update updated to
// its members, the parent's members for a thread, and editor, if any.
func (s *Server) announceRoomLocked(r *roomState, editor *userState) {
	audience := maps.Clone(r.members)
	if r.parent != nil {
		maps.Copy(audience, r.parent.members)
	}
	if editor != nil {
		audience[editor.id] = editor
	}
	frame := roomUpdate("updated", s.roomParamsLocked(r))
	for _, member := range audience {
		member.send(frame)
	}
}

// untitleLocked replaces the titles derived from a deleted intro message:
// the room records carrying one are redacted to the default thread title
// (§4.2), and each room still titled by it gets a new record with the
// default title.
func (s *Server) untitleLocked(m *messageState) {
	for _, record := range m.titleRecords {
		record.rewrite(func(value map[string]any) {
			value["title"] = defaultThreadTitle
		})
	}
	m.titleRecords = nil
	for _, r := range m.titledRooms {
		if r.titleFrom != m.id {
			continue
		}
		fields := maps.Clone(r.record)
		for _, key := range []string{"room_id", "log_id", "prev_log_id", "parent_room_id"} {
			delete(fields, key)
		}
		fields["title"] = defaultThreadTitle
		r.titleFrom = ""
		s.commitRoomLocked(r.id, r.parent, fields)
		s.announceRoomLocked(r, nil)
	}
	m.titledRooms = nil
}

// setRoom creates a room (no room_id) or replaces an existing room's client
// fields (§4.3.4). parent_room_id is fixed at creation and ignored on
// updates. Any authenticated user may create rooms and threads and update any
// room's client fields.
//
// A new room joins only its creator, logging the creator's membership: the
// creator's connections receive room_update joined, then the membership,
// then the result. A new thread goes to the parent's other members as
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
	if err := s.admitPostLocked(u); err != nil {
		return nil, false, err
	}
	fields := make(map[string]any)
	titleFrom := ""
	if title == "" && parent != nil {
		// Servers title threads so clients unaware of parent_room_id render them.
		title = s.threadTitleLocked(introID)
		if title != defaultThreadTitle {
			titleFrom = introID
		}
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
	r.titleFrom = titleFrom
	if titleFrom != "" {
		// Deleting the intro message removes the title taken from its text.
		m := s.messages[titleFrom]
		m.titleRecords = append(m.titleRecords, r.log[len(r.log)-1])
		m.titledRooms = append(m.titledRooms, r)
	}
	// Room updates precede the result, so the room is known when it arrives.
	if updating {
		s.announceRoomLocked(r, u)
	} else {
		// The room record and the membership are both logged before the
		// room_update, whose latest_log_id is then the membership's.
		u.joined[r.id] = r
		r.members[u.id] = u
		membership := s.logMembershipLocked(u, r, true)
		u.send(s.joinedUpdateLocked(r))
		s.deliverLocked(membership, r)
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

const (
	maxThreadTitleRunes = 60
	defaultThreadTitle  = "Thread"
)

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
	return defaultThreadTitle
}

// listRooms answers room_list (§4.3.1): the rooms matching its filters,
// joined ones in `joined` (never truncated) and visible unjoined ones in
// `not_joined` (the most recently active maxListedRooms), each most recently
// active first. `filter` leaves either array out; one it asks for is present
// even when empty. With `members: true` every room carries its complete
// members as bare user objects, whose complete objects are in `users`.
//
// With `latest_log_id`, only rooms whose latest_log_id is greater are
// listed, and a result with `joined` carries `left`: the rooms among the
// candidates the user left after that position. The server logs every
// membership, so a left room's latest_log_id is at least its leave; a left
// room that is top-level, or a thread listed with parent_room_id or
// room_id, is in `not_joined` too when the filter asks for it.
//
// The result is followed by the read cursors kept for the listed rooms
// (§4.4).
func (s *Server) listRooms(c *client, req request) (any, bool, *rpcError) {
	filter, err := parseString(req.params, "filter", false)
	if err != nil {
		return nil, false, err
	}
	switch filter {
	case "":
		filter = "all"
	case "all", "joined", "not_joined":
	default:
		return nil, false, invalidParams("filter must be joined, not_joined, or all")
	}
	wantJoined, wantOthers := filter != "not_joined", filter != "joined"
	withMembers, err := parseBool(req.params, "members", false)
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
		candidates = slices.Collect(maps.Values(s.rooms))
	}
	var joined, others, left []*roomState
	for _, r := range candidates {
		if hasSince && r.latestID <= since {
			continue
		}
		if u.joined[r.id] != nil {
			if wantJoined {
				joined = append(joined, r)
			}
			continue
		}
		if hasSince && wantJoined && u.leftAt[r.id] > since {
			left = append(left, r)
		}
		// Without parent_room_id or room_id, unjoined threads are left to
		// their parent's listing.
		if wantOthers && (hasRoom || hasParent || r.parent == nil) {
			others = append(others, r)
		}
	}
	byActivity := func(a, b *roomState) int {
		return cmp.Or(cmp.Compare(b.latestID, a.latestID), cmp.Compare(b.createdID, a.createdID))
	}
	slices.SortFunc(joined, byActivity)
	slices.SortFunc(others, byActivity)
	slices.SortFunc(left, byActivity)
	if len(others) > maxListedRooms {
		others = others[:maxListedRooms]
	}

	users := make(map[string]*userState)
	renderRooms := func(rooms []*roomState) []any {
		entries := make([]any, len(rooms))
		for i, r := range rooms {
			entry := s.roomParamsLocked(r)
			if withMembers {
				entry["members"] = memberRefs(r)
				maps.Copy(users, r.members)
			}
			entries[i] = entry
		}
		return entries
	}
	result := map[string]any{}
	if wantJoined {
		result["joined"] = renderRooms(joined)
	}
	if wantOthers {
		result["not_joined"] = renderRooms(others)
	}
	if hasSince && wantJoined {
		gone := make([]any, len(left))
		for i, r := range left {
			gone[i] = map[string]any{"room_id": r.id}
		}
		result["left"] = gone
	}
	if withMembers {
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

// joinRoom joins a visible room (§4.3.2): the logged membership goes to the
// room's members, the user's connections included, then room_update joined
// to the user's connections, then the result. Joining a room already joined
// logs nothing and re-sends room_update joined to the calling connection
// only.
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
		c.enqueue(s.joinedUpdateLocked(r))
	}
	result := map[string]any{}
	if req.hasID {
		c.sendResult(req, result)
	}
	return result, true, nil
}

// leaveRoom leaves a room (§4.3.2): the logged membership goes to the room's
// members, the leaving user's connections included, then room_update left to
// the user's connections, then the result. The room stays visible in
// room_list. Leaving a room not joined changes nothing.
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
// partitioned into rooms, messages, reactions, and membership, each omitted
// when empty. The server retains all records and does not compact, and it
// discards no prefix, so it never appends a full-member record. Every room is
// visible, so history needs no membership.
//
// A move snapshot is in both rooms' logs and names the source room in
// prev_room_id, so a window bounded to one log_id (after == before) in the
// room a snapshot names walks prev_log_id back through a message's edits
// (§2).
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
	more := len(matching) > limit
	if more {
		if hasAfter {
			matching = matching[:limit]
		} else {
			matching = matching[len(matching)-limit:]
		}
	}
	// A page also stops at maxHistoryReplyBytes of records, keeping at least
	// one, so one request cannot hold the lock to render an unbounded reply.
	size := 0
	for i := range matching {
		k := i
		if !hasAfter {
			k = len(matching) - 1 - i
		}
		if size += matching[k].wireLen(); size > maxHistoryReplyBytes && i > 0 {
			if hasAfter {
				matching = matching[:k]
			} else {
				matching = matching[k+1:]
			}
			more = true
			break
		}
	}
	result := json.RawMessage(renderHistory(r, matching, more, size))
	// The records are already JSON: the reply is assembled from them without
	// decoding or re-encoding.
	if req.hasID {
		c.enqueue(rawResponse(req.id, req.full, result))
	}
	return result, true, nil
}

// renderHistory assembles a history result (§4.1) from a window of records.
func renderHistory(r *roomState, matching []*logRecord, more bool, size int) []byte {
	buf := make([]byte, 0, size+len(matching)+256)
	buf = append(buf, `{"more":`...)
	buf = strconv.AppendBool(buf, more)
	for _, group := range []struct {
		key  string
		kind recordKind
	}{{"rooms", kindRoom}, {"messages", kindMessage}, {"reactions", kindReactions}, {"membership", kindMembership}} {
		first := true
		for _, record := range matching {
			if record.kind != group.kind {
				continue
			}
			if first {
				buf = append(buf, `,"`...)
				buf = append(buf, group.key...)
				buf = append(buf, `":[`...)
				first = false
			} else {
				buf = append(buf, ',')
			}
			buf = record.appendWire(buf)
		}
		if !first {
			buf = append(buf, ']')
		}
	}
	field := func(key string, id int64) {
		buf = append(buf, `,"`...)
		buf = append(buf, key...)
		buf = append(buf, `":"`...)
		buf = strconv.AppendInt(buf, id, 10)
		buf = append(buf, '"')
	}
	field("latest_log_id", r.latestID)
	field("history_log_id", r.createdID)
	if len(matching) > 0 {
		field("first_log_id", matching[0].id)
		field("last_log_id", matching[len(matching)-1].id)
	}
	return append(buf, '}')
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
	// The relays this request causes precede its result (§1).
	defer func() {
		if req.hasID {
			c.sendResult(req, result)
		}
	}()
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
