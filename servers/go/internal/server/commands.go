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
	// run executes the command. On success it replies with its result
	// before sending the frames the command causes.
	run func(s *Server, c *client, reply func(result map[string]any), r *roomState, body map[string]any, args string) *rpcError
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
// (Appendix A.1) and effects as the frames they cause.
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
	defer s.mu.Unlock()
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
			var result map[string]any
			reply := func(value map[string]any) {
				result = value
				if req.hasID {
					c.sendResult(req, value)
				}
			}
			if err := command.run(s, c, reply, r, body, strings.TrimSpace(args)); err != nil {
				return nil, false, err
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
		"from":    map[string]any{"user_id": privateNoticeID, "name": "Only you"},
		"body":    map[string]any{"text": text, "format": "markdown"},
	}}
}

// postRoomNoticeLocked logs and delivers a message from @room to the room's
// members (Appendix A.1). It mentions no one.
func (s *Server) postRoomNoticeLocked(r *roomState, text string) {
	logID := s.nextIDLocked()
	messageID := formatID(logID)
	from := map[string]any{"user_id": roomNoticeID, "name": r.title()}
	m := &messageState{id: messageID, from: from, owner: roomNoticeID, reactions: make(map[string]reactionSet), reactionLogIDs: make(map[string]int64)}
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
func (s *Server) helpCommand(c *client, reply func(map[string]any), r *roomState, _ map[string]any, _ string) *rpcError {
	var lines []string
	for _, command := range serverCommands {
		if command.available == nil || command.available(c.user, r) {
			lines = append(lines, fmt.Sprintf("- `%s`: %s", command.usage, command.help))
		}
	}
	reply(map[string]any{})
	c.enqueue(privateNotice(r, strings.Join(lines, "\n")))
	return nil
}

// avatarCommand takes exactly one upload embed, whose file becomes the
// sender's avatar when its write finishes (§4.6.6). The result carries the
// write URL.
func (s *Server) avatarCommand(c *client, reply func(map[string]any), _ *roomState, body map[string]any, _ string) *rpcError {
	embeds := asList(body["embeds"])
	if len(embeds) != 1 || embeds[0].(map[string]any)["kind"] != "upload" {
		return invalidParams("/avatar takes exactly one upload embed: attach an image")
	}
	s.embedNumber++
	e := s.newWriteLocked(c, fmt.Sprintf("embed_%d", s.embedNumber), "upload", "")
	e.avatarFor = c.user
	reply(map[string]any{
		"embeds": []any{map[string]any{"embed_id": e.id, "kind": "upload", "write_url": e.baseURL + writePath + e.token}},
	})
	return nil
}

// kickCommand removes the one mentioned user from the room: they receive
// room_update left, the other members a `user` notification, and the room a
// @room notice. Only the room's creator may kick.
func (s *Server) kickCommand(c *client, reply func(map[string]any), r *roomState, body map[string]any, args string) *rpcError {
	u := c.user
	targets := mentions(body)
	if len(targets) != 1 {
		return invalidParams("Usage: /kick @user [reason], mentioning exactly one user")
	}
	if r.creator != u.id {
		return &rpcError{Code: codeDenied, Message: fmt.Sprintf("Only the creator of %s can remove people from it", r.title())}
	}
	target := r.members[targets[0]]
	if target == nil {
		return invalidParams("@%s is not in %s", targets[0], r.title())
	}
	if target == u {
		return invalidParams("You cannot remove yourself; leave the room instead")
	}
	// The first argument names the target as the user typed it.
	reason := args
	if first, rest, _ := strings.Cut(args, " "); strings.HasPrefix(first, "@") {
		reason = strings.TrimSpace(rest)
	}
	reply(map[string]any{})
	s.leaveLocked(target, r)
	text := fmt.Sprintf("@%s was removed by @%s", target.id, u.id)
	if reason != "" {
		text += ": " + reason
	}
	s.postRoomNoticeLocked(r, text)
	return nil
}
