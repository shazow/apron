# Bots

**Status**: Draft. Requirements only, while we research the server API and
reference bot clients.

**How can a bot run on Apron?** In one of two ways. A **daemon** holds a
connection, reads every message in its rooms, and picks out what it needs.
A **hook** sleeps until the server calls it, and then connects only for as
long as it has work. Daemons work today. Hooks need a server that calls
them, which this recipe drafts.

## Requirements

These are the requirements that we are working from. They will become the
steps of `## How it works`. [Prior art](#prior-art) says where each idea
comes from.

### Two modalities

1. **Daemon.** A long-running process holds one connection, gets every
   broadcast in the rooms that it joined, and filters each message as it
   comes. It suits a host that runs all the time, such as a server, a
   container, or a computer at home.
2. **Hook.** The server calls the bot's hook when a message needs it. The
   bot then does what the message asks. It can connect to read more
   context, post an answer, or react, and then close. It suits a
   serverless host, such as a Cloudflare Worker, an AWS Lambda function, or
   a Cloud Run service, and it costs nothing while it waits.

A bot that posts on its own schedule, such as a deploy hook or a cron job
([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)),
is a hook that something other than the server calls.

A daemon suits a bot that reads most messages, or that answers at once and
often. A hook suits a bot that answers now and then. A daemon on a
serverless host costs as much as one on any other host, or more. For
example, a Cloudflare Durable Object stays awake for as long as its own
WebSocket client is open, because only WebSockets that the object accepts
can hibernate.

### Both modalities

- An owner gets a bearer token for a bot
  ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)), and the bot has the role
  `bot` ([§3.3.4](../PROTOCOL.md#334-roles)). The token signs in from any
  origin.
- A message is meant for the bot when one of these holds:
  - it mentions the bot in `body.mentions`
    ([§3.5.5](../PROTOCOL.md#355-mentions));
  - it replies to a message of the bot's
    ([§3.5.4](../PROTOCOL.md#354-references));
  - it is in a private room that the bot joined.
- A daemon checks this itself. For a hook, the server checks it.
- Servers never parse `text` for mentions
  ([§3.5.5](../PROTOCOL.md#355-mentions)). A bot that also wants
  `@user_id` in text, as [issue #139] suggests, reads every message: as a
  daemon, or as a hook that gets every message.
- A bot ignores its own messages and, by default, other bots' messages, so
  that two bots cannot answer each other forever.
- A bot answers with an `id` that comes from the message that it answers.
  The server deduplicates requests by `user_id` and `id`
  ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)), for 24 hours on
  the Cloudflare server. So a retry posts once, even from a bot with no
  state.
- A bot answers in the room where it was asked, with `reply_to` where it
  fits ([§3.5.4](../PROTOCOL.md#354-references)).
- A bot checks who may ask for what by their `roles`
  ([§3.3.4](../PROTOCOL.md#334-roles)), before it acts and again where it
  acts, as [issue #139] asks.
- A bot waits for `retry_after` when the server asks for it.
- A bot keeps its token in one place, and removes token-like strings from
  what it sends, as [issue #139] suggests.

### Daemon

The server already does what a daemon needs. [Issue #139] has a longer
checklist for daemons; these are its main points.

Server:

- A daemon gets broadcasts only for the rooms that it joined
  ([§3.4](../PROTOCOL.md#34-rooms)), so it joins each room that it watches
  ([Q15](#open-questions)).
- `history` with no `room_id` reads every room that the connection joined
  as one log ([§4.3](../PROTOCOL.md#43-history)). One call then catches up
  after a reconnect. The Cloudflare server supports it.
- A server that hibernates idle connections, as the Cloudflare server does,
  pays little for a daemon that waits.
- The Cloudflare server allows 8 signed-in connections for each account,
  and the newest signs out the oldest.

Bot client:

- Hold one connection, ever. Keep the part that owns the token and the
  connection small, apart from the part that decides what to say.
- Reconnect with backoff. Stop when `auth` is denied. A timeout for
  connecting does not apply to idle reads.
- On each message, check whether it is meant for the bot. Remember the IDs
  of the bot's own messages, so that replies to them count.
- Save the last `log_id` after each message. On a reconnect, read
  `history` with no `room_id`, after that `log_id`. `after` is inclusive,
  so skip the record at the `log_id` itself
  ([§4.3.2](../PROTOCOL.md#432-bounds-and-order)).
- React at once to a live message that is meant for the bot, such as with
  👀. Skip the reaction for messages from a catch-up.
- Show typing before a long answer
  ([§4.6](../PROTOCOL.md#46-activity)).
- Run under a supervisor that checks liveness, with a kill switch that
  keeps the bot off until its owner turns it on.

### Hook: what calls the hook

- By default, the server calls the hook for each new message that is meant
  for the bot ([Both modalities](#both-modalities)).
- The owner can opt in to every new message in the rooms that the bot
  joined. Every platform that we looked at makes the full stream an opt-in.
- To start, only new messages call the hook ([Q2](#open-questions)).
- The server does not coalesce calls, wait first, or check whether the bot
  is attended, as it does for push to a person
  ([§4.9.4](../PROTOCOL.md#494-wake)).
- The server skips a bot that has a live connection, since the bot already
  gets the broadcast ([Q4](#open-questions)).
- Other bots' messages do not call the hook. Telegram and Teams do the
  same by default ([Q7](#open-questions)).

### Hook: what a call carries

- The body is a versioned envelope. It holds the same `message` notification
  that a daemon gets: the whole message, with `log_id`, not cut down to fit
  a push ([§4.9.3](../PROTOCOL.md#493-payload)). One handler then serves
  both modalities ([Q16](#open-questions)).
- Each call has a delivery ID that stays the same on a retry, so that the
  bot can drop a duplicate.
- Each call has a sequence number for the bot, which goes up by one with
  each call. A gap shows the bot that it missed a call. A `log_id` cannot
  show this, because `log_id`s are one sequence for the whole server
  ([§2.1](../PROTOCOL.md#21-log_id)). The server can keep the number in
  memory, with an epoch that changes when it restarts. A new epoch tells the
  bot to catch up.
- The envelope says why the server called: a mention, a reply, a private
  room, or every message. The server knows who wrote the message that was
  replied to, so a hook does not have to remember the IDs of its own
  messages, as a daemon does.
- The envelope carries the sender's `roles`
  ([§3.3.4](../PROTOCOL.md#334-roles)), so that the bot can check who may
  ask for what without a `room_list`.
- The envelope says how many times the server tried the call, and when the
  message came. A bot then knows when the moment has passed, such as for an
  instant reaction.
- After the server skips calls for a limit, the next call says how many it
  skipped, as Slack's `app_rate_limited` does.

### Hook: signing and verifying

- The server signs each call. The signature covers a timestamp, the bot's
  `user_id`, and the raw body, so that a call cannot be replayed later or to
  another bot.
- The signature scheme is open ([Q5](#open-questions)).
- Before the server turns a hook on, the URL proves that it answers for
  the bot, such as by echoing a challenge. This also stops an owner from
  aiming the server at a URL that is not a bot.

### Hook: acknowledgement and failure

- The bot answers 2xx within a few seconds. Discord and Slack allow 3
  seconds. A slow answer counts as a failure, so that a slow bot cannot keep
  the server busy.
- The server retries a failed call a few times, with the same delivery ID,
  such as at once, after 1 minute, and after 5 minutes, as Slack does. Then
  it gives up ([Q6](#open-questions)).
- A bot recovers anything that was given up with `history`
  ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)). Apron bots can read
  history, unlike Telegram bots. So the server needs no long queue for each
  bot, as Telegram keeps for 24 hours.
- The server turns off a hook that answers 404 or 410, or that fails most
  calls for an hour, and tells the owner. Slack's rule is more than 95% of
  calls in 60 minutes, and only for apps with at least 1,000 calls an hour.
- The owner can see the hook's state: when it last failed and why, and how
  many calls it skipped. Telegram's `getWebhookInfo` does this.
- The owner can pause the hook and turn it on again without losing its
  settings. This is the kill switch that [issue #139] asks for.
- The owner can send a test call ([Q12](#open-questions)).

### Hook: bounds, configuration, and lifecycle

- The server limits calls for each bot and for the whole server, each day.
- Choosing whom to call costs no storage reads in the common case.
- The hook URL is a public `https` URL, as for push endpoints
  ([§4.9.1](../PROTOCOL.md#491-registration)).
- The owner sets the hook when the bot is made, and changes or removes it
  later. On the Cloudflare server this could be `/invite-bot [url]`, and a
  separate `/bot-webhook <url>` and `/bot-webhook off`.
- The owner chooses what calls the hook: messages meant for the bot, or
  every message.
- A new token does not drop the hook. A change to the hook does not rotate
  the token.
- Whether the bot can also set its own hook is open
  ([Q8](#open-questions)).
- Rules that sign out idle bots, or drop push registrations that are not
  renewed, must not drop a bot that is called rarely. Otherwise the recipe
  tells hooks to sign in on a schedule.

### Hook: doing more after a call

- A hook that needs more connects for a short time: for example `auth`,
  then `history` for the thread or the message that was replied to, then
  `message`, then close
  ([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)).
- Other ways to answer are open ([Q9](#open-questions),
  [Q10](#open-questions)), and so is what happens when many calls come at
  once ([Q11](#open-questions)).

Bot client:

- Check the signature and the timestamp, then answer `202` at once. Do the
  work after the answer, such as with `waitUntil` or a queue.
- Drop a call whose delivery ID it has seen.
- React at once to a call on its first try, such as with 👀, as
  [issue #139] suggests. Skip it on a retry.
- Remember the last sequence number. On a gap or a new epoch, catch up with
  `history` in the rooms where it matters.
- Sign in on a schedule, if the server signs out idle bots.

### Reference implementation

- A template daemon, and a template hook for one serverless platform, to
  start with Cloudflare Workers.
- Support for hooks in the Cloudflare server (apron-server-cloudflare).
- Where a serverless hook keeps its state ([Q14](#open-questions)).

## Open questions

Hook delivery:

1. **Mentions outside the bot's rooms.** How does a bot learn of a
   mention in a room that it has not joined? A daemon gets no broadcast
   from that room, and a catch-up with `history` and no `room_id` covers
   only the rooms that it joined ([§4.3](../PROTOCOL.md#43-history)). For a
   hook, the server could call it anyway. Telegram's Guest Mode delivers
   such a mention, and lets the bot answer once, with no history.
2. **Other events.** Do edits, deletions, reactions, and membership changes
   call the hook? A call when an owner adds the bot to a room would let
   it greet once, as [issue #139] asks.
3. **Bursts.** Does the server send a burst as one call with several
   notifications, as Matrix and Meta do? It would cut requests from a busy
   room without dropping any.
4. **Both at once.** Can one bot be a daemon while it is connected, and a
   hook while it is not? The server would skip the hook while the bot has
   a live connection, and call it otherwise.

Hook trust:

5. **Signatures.** HMAC-SHA256 with a secret for each bot, as Slack and
   GitHub use, or Ed25519 with one public key for the server, as Discord
   uses? With Ed25519, the server keeps no secret for each bot, and can
   publish its key. The bot then holds no second secret next to its token,
   which [issue #139] asks for.
6. **Retries.** How long does the server keep trying? Each retry later than
   a moment costs the server a scheduled wake.
7. **Bot to bot.** Can an owner opt in to calls for other bots' messages?
   Telegram allows it since 2026, and asks bots to guard against loops.
8. **Who sets the hook.** Can the bot set its own hook over the
   protocol? If so, this becomes an extension, not server policy.

Hook answers:

9. **Answers in the response.** Can the bot answer in the hook's HTTP
   response, as Telegram, Zulip, and Mattermost allow? It saves a
   connection for a bot that answers at once, and the deadline bounds what
   it costs the server. It would also let the bot react or show typing at
   once, which [issue #139] asks for, without a connection. The bot cannot
   learn whether the post worked, as Telegram warns.
10. **Posting over HTTP.** Is there a plain HTTP endpoint for posting, for
    bots that cannot open a WebSocket? Discord gives each call a token that
    posts follow-ups for 15 minutes.
11. **Many calls at once.** A bot that answers each call on its own
    connection opens many at once in a busy room. [Issue #139] tells bots to
    hold one connection, ever. The Cloudflare server allows 8 signed-in
    connections for each account, and the newest signs out the oldest. It
    also admits 30 connections a minute for each address. A Worker's
    address is its zone, so all the Workers in one account share it, as in
    `<account>.workers.dev`. Does the bot send its answers through one
    connection, such as in a Durable Object, or do Q9 or Q10 answer this?

Operations:

12. **Test calls.** Can the owner send a test call, or call again for a
    message, as GitHub's redelivery does? [Issue #139] asks bots to prove
    each change against a live server.
13. **Catch-up.** Does the sequence number earn its place? A bot could
    instead run one `history` call with no `room_id` on every wake. That
    costs a read for each call, and misses rooms that the bot has not
    joined (Q1).
14. **Bot state.** Where does a serverless bot keep its sequence number,
    checkpoint, and the fact that it greeted a room? Cloudflare's KV is
    eventually consistent; a Durable Object is not.

Daemons:

15. **Watching without joining.** Can a daemon read every public room
    without joining each one? Joining lists the bot as a member of every
    room, and it misses rooms made after it last joined.

Shape of the hook:

16. **A push kind, or its own thing.** Is the hook push kind `relay`
    ([§4.9.2](../PROTOCOL.md#492-kinds)) with a wake policy for bots, or a
    webhook of its own? `relay` is already in the protocol, so any server
    with push could call bots. But its payload is at most 2048 bytes, cut
    to fit ([§4.9.3](../PROTOCOL.md#493-payload)), and it has no delivery
    ID or sequence number. A webhook of its own can carry the whole
    message. A middle way is a field on `relay` that asks for the whole
    message, as Matrix pushers choose `data.format`. A kind from outside
    the core is named with `ext:` ([§4](../PROTOCOL.md#4-capabilities)),
    such as `ext:hook`. Prior art for registering pushes: Matrix pushers
    (`kind: "http"` to a push gateway, which answers with the push keys to
    remove), Mastodon's Web Push subscriptions (with `alerts` and `policy`
    filters), UnifiedPush (Web Push through a distributor), and Telegram's
    `setWebhook`, where a bot sets its own hook. No client uses `relay`
    today. StupidSocial, a native iOS client, registers `webpush` with its
    own stateless Web Push endpoint, which checks the server's VAPID
    signature and forwards the ciphertext to APNs. Sidetable, for macOS,
    shows local notifications only while it runs.

Beyond messages, popular on other platforms:

17. **Bot commands.** Can a bot offer its own commands, such as `/weather`,
    that [`ext:command_list`](../extensions/ext_command_list.md) lists, and
    that reach the bot as a call? Telegram (`setMyCommands`),
    Discord (application commands), and Slack (slash commands) all do this.
    Discord and Slack also offer commands on one message, such as
    "Summarize this". An Apron command can already carry `reply_to`
    ([§4.1](../PROTOCOL.md#41-command)). Today only the server defines
    commands.
18. **Buttons.** Can a bot offer choices, whose choice calls the bot?
    Telegram has inline keyboards, Discord has components, and Slack has
    Block Kit. Apron's `actions` embed
    ([Appendix C.3](../PROTOCOL.md#c3-actions-embed)) is under
    consideration, and only servers set it.
19. **Private replies.** Can a bot answer only the user who asked, as
    Slack's and Discord's ephemeral messages do, and Telegram's since 2026?
    Apron's `~private` notices
    ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices))
    go to one connection, and only the server sends them.
20. **Incoming webhooks.** Can a script post to a room with one HTTP POST to
    a secret URL, with no bot code and no WebSocket? Discord, Slack, Zulip,
    and Mattermost all offer this, mostly for alerts from CI and
    monitoring. It differs from Q10, which is for bots that already
    hold a token.
21. **Following a conversation.** After a mention, does the bot get the
    follow-ups in that thread without another mention? Slack's assistant
    threads and Discord's threads work this way, and LLM bots depend on it.
    Apron's threads are rooms ([§4.2.4](../PROTOCOL.md#424-creating-and-editing)),
    so the bot could join the thread, and the scope could be set for each
    room.
22. **Thinking, streaming, and stop.** Can a user stop a bot's long answer?
    Telegram streams drafts (`sendMessageDraft`), and tells the bot when the
    user presses Stop (`stopped_message_generation`). Slack lets an
    assistant show a status such as "is thinking…". Apron streams with
    `embed:append` ([§4.8.5](../PROTOCOL.md#485-embedappend)), and shows
    typing, but has no stop signal.
23. **Finding and adding bots.** How do people find a bot, and add it to
    their rooms or talk to it alone? Discord has an app directory and
    invite links with permissions, Slack asks for scopes at install, and
    Telegram opens a chat from a link (`?start=`). On the Cloudflare server
    an owner adds their own bot, and members of a private room can add
    anyone to it.

Shape of the hook, continued:

24. **A token to connect back.** Does each call carry a short-lived token
    that signs in as the bot, so that a hook needs no long-lived token of
    its own? Discord's interaction token (15 minutes, follow-ups only) and
    Slack's `response_url` (30 minutes, 5 uses) do this. It would be
    limited to the bot's rooms and to posting, reacting, typing, and
    reading, and could be signed rather than stored.
25. **Frames in the response.** If Q9 is yes, is the response body a list
    of request frames, one JSON object a line, that the server runs as the
    bot? It reuses the frames that a connection sends, with no results
    back.
26. **One hook for each bot.** Is a hook a registration among many, as a
    device's push is, or one setting for each bot, as Telegram's
    `setWebhook` and Mastodon's one subscription for each token are? Push
    registrations lapse unless a connection renews them, which suits
    devices and not a hook that rarely connects.
27. **Unregistering everything.** Can a client remove all the
    registrations that it made without remembering each `url`, such as by
    `push_id`, or all those that its credential made? Mastodon ties a
    subscription to its access token.
28. **The name.** `ext:hook` or `ext:webhook`? The thing is an outgoing
    webhook, as Telegram's `setWebhook` and Zulip's outgoing webhooks are.
    Incoming webhooks (Q20) go the other way. "Hook" here already means a
    deploy hook that posts on a schedule.

## Prior art

Research notes from the official documentation, November 2026. This section
goes away when the recipe is done.

| Platform | How events reach a bot | What a bot gets by default | Verifying the caller | Deadline and retries | Answering |
|---|---|---|---|---|---|
| Telegram | Webhook or long polling (`getUpdates`), not both; up to 100 connections at once | In groups, commands for it and replies to it (privacy mode); admins get everything; other bots' messages only by opt-in | Fixed `X-Telegram-Bot-Api-Secret-Token` header | Kept 24 hours; retried "a reasonable number of attempts"; `update_id` to find duplicates and order | Send API, or one method in the webhook response, with no result |
| Discord | Gateway WebSocket for messages; HTTP only for commands and other interactions | Message text only in DMs and mentions, unless `MESSAGE_CONTENT` is approved | Ed25519 of timestamp and body; probes with bad signatures, and removes URLs that accept them | 3 seconds; webhook events retried for 10 minutes, then disabled | In the response, or deferred, with a token for follow-ups for 15 minutes |
| Slack | Events API over HTTP, or Socket Mode | `app_mention`, or every message where the app is a member with `*:history` scopes | HMAC-SHA256 of `v0:timestamp:body`; 5-minute window | 3 seconds; retried at once, after 1 minute, after 5 minutes; off after more than 95% failures in an hour | Web API; slash commands in the response, or `response_url` 5 times in 30 minutes |
| Matrix application service | Ordered transactions of events, each with a `txnId` | Every event in rooms that its namespaces match | `Authorization: Bearer <hs_token>` | Queued, with exponential backoff; a retry repeats its transaction exactly | Client-server API |
| Zulip | Outgoing webhook, or an event queue with long polling | Mentions and DMs | Fixed token in the body | 10 seconds; retries not documented | `{"content": …}` in the response, or the REST API |
| Teams (Bot Framework) | HTTP POST of Activities | Mentions, unless the install grants permission for all messages; never other bots | JWT from the Bot Connector, checked against its published keys | 15 seconds | Connector REST API |
| GitHub (not chat) | Webhook | What the hook subscribes to | HMAC-SHA256 (`X-Hub-Signature-256`); a delivery ID | 10 seconds; no automatic retries; manual redelivery for 3 days | Not applicable |

## Limits

To be written.

[issue #139]: https://github.com/shazow/apron/issues/139
[Issue #139]: https://github.com/shazow/apron/issues/139
