package server

import (
	"fmt"
	"strings"
)

// Scoped system identities (Appendix A.1).
const (
	roomNoticeID    = "@room"
	privateNoticeID = "@private"
)

// serverCommand is one command this server provides (§4.8).
type serverCommand struct {
	name  string
	usage string
	help  string
	// available reports whether the sender may use the command in r.
	available func(u *userState, r *roomState) bool
	// run executes the command, sending the frames it causes, and returns
	// its result, which the caller sends after them (§1).
	run func(s *Server, c *client, r *roomState, body map[string]any, args string) (map[string]any, *rpcError)
}

// serverCommands lists the commands in the order /help shows them. It is
// filled in init because /help refers to it.
var serverCommands []serverCommand

func init() {
	serverCommands = []serverCommand{
		{
			name: "help", usage: "/help", help: "list the commands you can use here",
			run: (*Server).helpCommand,
		},
		{
			name: "avatar", usage: "/avatar", help: "with one image attached: set your avatar",
			run: (*Server).avatarCommand,
		},
		{
			name: "kick", usage: "/kick @user [reason]", help: "remove someone from this room (its creator only)",
			available: func(u *userState, r *roomState) bool { return r.creator == u.id },
			run:       (*Server).kickCommand,
		},
	}
}

// command runs a `command` request (§4.8). It takes the params of a new
// message and is never logged, broadcast, or saved: body.text is the command
// line, and mentions, reply_to, and embeds are arguments that notify no one.
// Without room_id it runs in the default room. The result is {} or, for new
// upload embeds, their write URLs; replies arrive as scoped system notices
// (Appendix A.1) and effects as the frames they cause, all before the
// result (§1).
func (s *Server) command(c *client, req request) (any, bool, *rpcError) {
	for _, name := range []string{"message_id", "deleted"} {
		if _, has := req.params[name]; has {
			return nil, false, invalidParams("A command has no %s; send it as a message instead", name)
		}
	}
	roomID, err := parseString(req.params, "room_id", false)
	if err != nil {
		return nil, false, err
	}
	if _, has := req.params["room_id"]; !has {
		roomID = defaultRoomID
	}
	replyID, hasReply, err := parseMessageRef(req.params, "reply_to")
	if err != nil {
		return nil, false, err
	}
	body, err := parseObject(req.params, "body", true)
	if err != nil {
		return nil, false, err
	}
	if err := validateBody(body); err != nil {
		return nil, false, err
	}
	if _, err := parseObject(req.params, "ext", false); err != nil {
		return nil, false, err
	}
	text, _ := body["text"].(string)
	line := strings.TrimSpace(text)
	if !strings.HasPrefix(line, "/") {
		return nil, false, invalidParams("A command starts with /; try /help")
	}
	word, args, _ := strings.Cut(line[1:], " ")
	name := strings.ToLower(word)

	s.mu.Lock()
	defer s.unlock()
	c.away = false
	r := s.rooms[roomID]
	if r == nil {
		return nil, false, invalidParams("Unknown room %q", roomID)
	}
	if hasReply && s.messages[replyID] == nil {
		return nil, false, invalidParams("reply_to must name an existing message")
	}
	for _, command := range serverCommands {
		if command.name == name {
			result, err := command.run(s, c, r, body, strings.TrimSpace(args))
			if err != nil {
				return nil, false, err
			}
			if req.hasID {
				c.sendResult(req, result)
			}
			return result, true, nil
		}
	}
	return nil, false, invalidParams("Unknown command /%s; try /help", word)
}

// privateNotice renders a notice for one connection's user only: unlogged,
// without message_id or log_id (Appendix A.1).
func privateNotice(r *roomState, text string) map[string]any {
	return map[string]any{"method": "message", "params": map[string]any{
		"room_id": r.id,
		"from":    map[string]any{"user_id": privateNoticeID, "name": "System message to you"},
		"body":    map[string]any{"text": text, "format": "markdown"},
	}}
}

// postRoomNoticeLocked logs and delivers a message from @room to the room's
// members (Appendix A.1). It mentions no one.
func (s *Server) postRoomNoticeLocked(r *roomState, text string) {
	logID := s.nextIDLocked()
	messageID := formatID(logID)
	name := r.title()
	if r.titleFrom != "" {
		// A title taken from a message's text is not repeated in records
		// that deleting the message would not redact.
		name = defaultThreadTitle
	}
	from := map[string]any{"user_id": roomNoticeID, "name": name}
	m := &messageState{id: messageID, from: from, owner: roomNoticeID, reactions: make(map[string]reactionSet)}
	s.messages[messageID] = m
	s.commitSnapshotLocked(m, map[string]any{
		"message_id": messageID,
		"log_id":     messageID,
		"room_id":    r.id,
		"from":       from,
		"body":       map[string]any{"text": text},
	}, logID)
}

// helpCommand replies with a @private notice listing the commands available
// to the sender in the room.
func (s *Server) helpCommand(c *client, r *roomState, _ map[string]any, _ string) (map[string]any, *rpcError) {
	var lines []string
	for _, command := range serverCommands {
		if command.available == nil || command.available(c.user, r) {
			lines = append(lines, fmt.Sprintf("- `%s`: %s", command.usage, command.help))
		}
	}
	c.enqueue(privateNotice(r, strings.Join(lines, "\n")))
	return map[string]any{}, nil
}

// avatarCommand takes exactly one upload embed, whose file becomes the
// sender's avatar when its write finishes (§4.6.6). The result carries the
// write URL.
func (s *Server) avatarCommand(c *client, _ *roomState, body map[string]any, _ string) (map[string]any, *rpcError) {
	embeds := asList(body["embeds"])
	if len(embeds) != 1 || embeds[0].(map[string]any)["kind"] != "upload" {
		return nil, invalidParams("/avatar takes exactly one upload embed: attach an image")
	}
	if err := s.admitPostLocked(c.user); err != nil {
		return nil, err
	}
	s.embedNumber++
	e := s.newWriteLocked(c, fmt.Sprintf("embed_%d", s.embedNumber), "upload", "")
	e.avatarFor = c.user
	return map[string]any{
		"embeds": []any{map[string]any{"embed_id": e.id, "kind": "upload", "write_url": e.baseURL + writePath + e.token}},
	}, nil
}

const maxKickReasonRunes = 200

// kickCommand removes the one mentioned user from the room: the room's
// members, the target included, receive the logged leave membership
// (§4.3.2), the target room_update left, and the remaining members a @room
// notice with the reason. Only the room's creator may kick.
func (s *Server) kickCommand(c *client, r *roomState, body map[string]any, args string) (map[string]any, *rpcError) {
	u := c.user
	targets := mentions(body)
	if len(targets) != 1 {
		return nil, invalidParams("Usage: /kick @user [reason], mentioning exactly one user")
	}
	if r.creator != u.id {
		return nil, &rpcError{Code: codeDenied, Message: fmt.Sprintf("Only the creator of %s can remove people from it", r.title())}
	}
	target := r.members[targets[0]]
	if target == nil {
		return nil, invalidParams("@%s is not in %s", targets[0], r.title())
	}
	if target == u {
		return nil, invalidParams("You cannot remove yourself; leave the room instead")
	}
	// The first argument names the target as the user typed it.
	reason := args
	if first, rest, _ := strings.Cut(args, " "); strings.HasPrefix(first, "@") {
		reason = strings.TrimSpace(rest)
	}
	// The reason is one plain line inside a system notice.
	reason, _, _ = strings.Cut(reason, "\n")
	reason = strings.TrimSpace(reason)
	if runes := []rune(reason); len(runes) > maxKickReasonRunes {
		reason = strings.TrimSpace(string(runes[:maxKickReasonRunes])) + "…"
	}
	s.leaveLocked(target, r)
	text := fmt.Sprintf("@%s was removed by @%s", target.id, u.id)
	if reason != "" {
		text += ": " + reason
	}
	s.postRoomNoticeLocked(r, text)
	return map[string]any{}, nil
}
