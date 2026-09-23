package server

import (
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"strings"
)

// maxListedMembers caps `members` in each room_list entry (Appendix C).
const maxListedMembers = 100

// roomState is a room's current record, its log, and its members. Every room,
// including threads (rooms with parent_room_id), is visible to every
// authenticated user; members are the users it is announced to (§3.4).
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
	// reads holds each member's latest read cursor (Appendix D.1).
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

// announcementFramesLocked renders a room's announcement followed by the read
// cursors kept for it, which the server re-sends after announcing the room
// (Appendix D.1).
func (s *Server) announcementFramesLocked(r *roomState) []any {
	frames := []any{roomFrame(s.embedIntroLocked(r.record), r)}
	for _, userID := range slices.Sorted(maps.Keys(r.reads)) {
		cursor := r.reads[userID]
		frames = append(frames, map[string]any{"method": "activity", "params": map[string]any{
			"room_id": r.id, "from": cloneObject(cursor.from), "read_message_id": cursor.messageID,
		}})
	}
	return frames
}

func roomFrame(record map[string]any, r *roomState) map[string]any {
	params := cloneObject(record)
	maps.Copy(params, r.deliveryFields())
	return map[string]any{"method": "room", "params": params}
}

// embedIntroLocked returns a copy of a room record whose bare intro_message
// reference is replaced by the referenced message's current snapshot.
func (s *Server) embedIntroLocked(record map[string]any) map[string]any {
	value := cloneObject(record)
	if intro, ok := value["intro_message"].(map[string]any); ok {
		if id, ok := intro["message_id"].(string); ok {
			if m := s.messages[id]; m != nil {
				value["intro_message"] = cloneObject(m.snapshot)
			}
		}
	}
	return value
}

// deliverLocked sends frames to every connection of every member of the
// given rooms, once per connection.
func (s *Server) deliverLocked(frame any, rooms ...*roomState) {
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

// joinDefaultRoomsLocked joins a new user to every top-level room and, with
// them, every thread; the caller announces them.
func (s *Server) joinDefaultRoomsLocked(u *userState) {
	for _, roomID := range s.roomOrder {
		if r := s.rooms[roomID]; r.parent == nil {
			s.joinTreeLocked(u, r, nil)
		}
	}
}

// joinLocked joins a user to a room and its threads, announcing each newly
// joined room to all of the user's connections.
func (s *Server) joinLocked(u *userState, r *roomState) {
	var frames []any
	s.joinTreeLocked(u, r, &frames)
	u.send(frames...)
}

// joinTreeLocked joins r and, recursively, its threads: joining a room joins
// its threads (Appendix C). Parents precede their threads in frames.
func (s *Server) joinTreeLocked(u *userState, r *roomState, frames *[]any) {
	if u.joined[r.id] == nil {
		u.joined[r.id] = r
		r.members[u.id] = u
		if frames != nil {
			*frames = append(*frames, s.announcementFramesLocked(r)...)
		}
	}
	for _, child := range r.children {
		s.joinTreeLocked(u, child, frames)
	}
}

// leaveLocked leaves a room and its threads, removing each from the user's
// announced rooms.
func (s *Server) leaveLocked(u *userState, r *roomState) {
	var frames []any
	var leave func(*roomState)
	leave = func(r *roomState) {
		if u.joined[r.id] != nil {
			delete(u.joined, r.id)
			delete(r.members, u.id)
			frames = append(frames, map[string]any{"method": "room", "params": map[string]any{"room_id": r.id, "removed": true}})
		}
		for _, child := range r.children {
			leave(child)
		}
	}
	leave(r)
	u.send(frames...)
}

// commitRoomLocked logs a room record holding fields, the client fields other
// than parent_room_id. An unknown roomID creates the room; an empty one names
// it by its creation log_id. It returns the logged record, whose
// intro_message embeds the snapshot current at commit time.
func (s *Server) commitRoomLocked(roomID string, parent *roomState, fields map[string]any) (*roomState, map[string]any) {
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
	logged := s.embedIntroLocked(record)
	s.appendLocked(&logRecord{id: logID, kind: kindRoom, value: logged}, r)
	return r, logged
}

// saveRoom creates a room (no room_id) or replaces an existing room's client
// fields (Appendix C). parent_room_id is fixed at creation and ignored on
// updates. Any authenticated user may create rooms and threads and update any
// room's client fields. Everyone joins a new top-level room; the members of
// a room join its new threads, and so does the creator.
func (s *Server) saveRoom(c *client, req request) (any, bool, *rpcError) {
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
	r, record := s.commitRoomLocked(roomID, parent, fields)
	result := map[string]any{"room_id": r.id}
	if req.hasID {
		c.sendResult(req, result)
	}
	if updating {
		s.deliverLocked(roomFrame(record, r), r)
		return result, true, nil
	}
	joining := map[string]*userState{c.user.id: c.user}
	if parent == nil {
		maps.Copy(joining, s.users)
	} else {
		maps.Copy(joining, parent.members)
	}
	for _, id := range slices.Sorted(maps.Keys(joining)) {
		s.joinLocked(joining[id], r)
	}
	return result, true, nil
}

const maxThreadTitleRunes = 60

// threadTitleLocked derives a default thread title from the intro message's
// first line of text.
func (s *Server) threadTitleLocked(introID string) string {
	if m := s.messages[introID]; m != nil {
		if body, ok := m.snapshot["body"].(map[string]any); ok {
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

// listRooms returns the visible top-level rooms, or one room's threads, each
// as a room record with delivery fields and members (Appendix C). Listing a
// room does not join it.
func (s *Server) listRooms(c *client, req request) (any, bool, *rpcError) {
	parentID, err := parseString(req.params, "parent_room_id", false)
	if err != nil {
		return nil, false, err
	}
	_, hasParent := req.params["parent_room_id"]
	s.mu.RLock()
	defer s.mu.RUnlock()
	if hasParent && s.rooms[parentID] == nil {
		return nil, false, invalidParams("Unknown parent room %q", parentID)
	}
	rooms := make([]any, 0)
	for _, roomID := range s.roomOrder {
		r := s.rooms[roomID]
		listedParent := ""
		if r.parent != nil {
			listedParent = r.parent.id
		}
		if listedParent != parentID || (hasParent && r.parent == nil) {
			continue
		}
		entry := roomFrame(s.embedIntroLocked(r.record), r)["params"].(map[string]any)
		ids := slices.Sorted(maps.Keys(r.members))
		if len(ids) > maxListedMembers {
			ids = ids[:maxListedMembers]
		}
		members := make([]any, len(ids))
		for i, id := range ids {
			members[i] = r.members[id].profile()
		}
		entry["members"] = members
		rooms = append(rooms, entry)
	}
	return map[string]any{"rooms": rooms}, false, nil
}

// joinRoom joins a visible room and its threads and announces them; joining
// a room already joined re-announces it on this connection.
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
	result := map[string]any{}
	if req.hasID {
		c.sendResult(req, result)
	}
	if c.user.joined[r.id] != nil {
		c.enqueueBatch(s.announcementFramesLocked(r)...)
	} else {
		s.joinLocked(c.user, r)
	}
	return result, true, nil
}

// leaveRoom leaves a room and its threads; each stays visible in room_list.
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
	result := map[string]any{}
	if req.hasID {
		c.sendResult(req, result)
	}
	s.leaveLocked(c.user, r)
	return result, true, nil
}

// history returns a window of one room's log (Appendix A). limit counts records
// of every kind; the slice is partitioned into rooms, entries, and reactions.
// The server retains all records and does not compact. Every room is visible,
// so history needs no membership.
func (s *Server) history(c *client, req request) (any, bool, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, false, err
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
	matching := make([]*logRecord, 0)
	for _, record := range r.log {
		if (hasAfter && record.id < after) || (hasBefore && record.id > before) {
			continue
		}
		matching = append(matching, record)
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
	for _, record := range matching {
		value := cloneObject(record.value)
		switch record.kind {
		case kindRoom:
			rooms = append(rooms, value)
		case kindMessage:
			entries = append(entries, value)
		case kindReactions:
			reactions = append(reactions, value)
		}
	}
	result := map[string]any{"rooms": rooms, "entries": entries, "reactions": reactions, "more": more}
	maps.Copy(result, r.deliveryFields())
	if len(matching) > 0 {
		result["first_id"] = formatID(matching[0].id)
		result["last_id"] = formatID(matching[len(matching)-1].id)
	}
	return result, false, nil
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

// activity relays a user's typing and read cursor in a room to its members
// (Appendix D.1). A read cursor must name a message and only advances; the
// server keeps the latest per member and re-sends it after announcing the
// room. A frame whose fields change nothing relays nothing.
func (s *Server) activity(c *client, req request) (any, bool, *rpcError) {
	roomID, err := parseString(req.params, "room_id", true)
	if err != nil {
		return nil, false, err
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
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.rooms[roomID]
	if r == nil {
		return nil, false, invalidParams("Unknown room %q", roomID)
	}
	if hasRead && s.messages[readID] == nil {
		return nil, false, invalidParams("Unknown read_message_id %q", readID)
	}
	result := map[string]any{}
	if req.hasID {
		c.sendResult(req, result)
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
