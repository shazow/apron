# Bots

**Status**: Draft. Requirements, open questions, and a draft extension,
[`ext:webhook`](#draft-extension-extwebhook), while we research the server
API and reference bot clients.

**How can a bot run on Apron?** In one of two ways. A **daemon** holds a
connection, reads every message in its rooms, and picks out what it needs.
A **webhook bot** sleeps until the server calls it, and then connects only for as
long as it has work. Daemons work today. Webhook bots need a server that
calls them, which this recipe drafts.

## Requirements

These are the requirements that we are working from. They will become the
steps of `## How it works`. [Prior art](#prior-art) says where each idea
comes from.

### Two modalities

1. **Daemon.** A long-running process holds one connection, gets every
   broadcast in the rooms that it joined, and filters each message as it
   comes. It suits a host that runs all the time, such as a server, a
   container, or a computer at home.
2. **Webhook bot.** The server calls the bot's webhook when a message needs it. The
   bot then does what the message asks. It can connect to read more
   context, post an answer, or react, and then close. It suits a
   serverless host, such as a Cloudflare Worker, an AWS Lambda function, or
   a Cloud Run service, and it costs nothing while it waits.

A bot that posts on its own schedule, such as a deploy hook or a cron job
([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)),
works like a webhook bot that something other than the server starts.

A daemon suits a bot that reads most messages, or that answers at once and
often. A webhook suits a bot that answers now and then. A daemon on a
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
- A daemon checks this itself. For a webhook, the server checks it.
- Servers never parse `text` for mentions
  ([§3.5.5](../PROTOCOL.md#355-mentions)). A bot that also wants
  `@user_id` in text, as [issue #139] suggests, reads every message: as a
  daemon, or as a webhook that gets every message.
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

### Webhook: what calls the webhook

- By default, the server calls the webhook for each new message that is meant
  for the bot ([Both modalities](#both-modalities)).
- The owner can opt in to every new message in the rooms that the bot
  joined. Every platform that we looked at makes the full stream an opt-in.
- To start, only new messages call the webhook ([Q2](#open-questions)).
- The server does not coalesce calls, wait first, or check whether the bot
  is attended, as it does for push to a person
  ([§4.9.4](../PROTOCOL.md#494-wake)).
- The server skips a bot that has a live connection, since the bot already
  gets the broadcast ([Q4](#open-questions)).
- Other bots' messages do not call the webhook. Telegram and Teams do the
  same by default ([Q7](#open-questions)).

### Webhook: what a call carries

- The body has the shape of a `history` result
  ([§4.3](../PROTOCOL.md#43-history)): the whole records, with `log_id`,
  not cut down to fit a push ([§4.9.3](../PROTOCOL.md#493-payload)). One
  parser then serves both modalities.
- Each call has a delivery ID that stays the same on a retry, so that the
  bot can drop a duplicate.
- Each call says where the previous call ended (`since`), so that the bot
  can tell when it missed one. A gap in `log_id`s cannot show this, because
  `log_id`s are one sequence for the whole server
  ([§2.1](../PROTOCOL.md#21-log_id)). The server keeps it in memory, and
  leaves it out after a restart, which tells the bot to catch up.
- The envelope says why the server called: a mention, a reply, a private
  room, or every message. The server knows who wrote the message that was
  replied to, so a webhook does not have to remember the IDs of its own
  messages, as a daemon does.
- The envelope carries the records that help read the call: the users,
  with their `roles` ([§3.3.4](../PROTOCOL.md#334-roles)), the rooms, and
  the message that was replied to. The bot then needs no `room_list` or
  `history` for the common case.
- The envelope says how many times the server tried the call, and when the
  message came. A bot then knows when the moment has passed, such as for an
  instant reaction.
- After the server skips calls for a limit, the next call says how many it
  skipped, as Slack's `app_rate_limited` does.

### Webhook: signing and verifying

- The server signs each call. The signature covers a timestamp, the bot's
  `user_id`, and the raw body, so that a call cannot be replayed later or to
  another bot.
- The signature follows Standard Webhooks, with Ed25519
  ([Draft extension](#draft-extension-extwebhook)).
- Before the server turns a webhook on, the URL proves that it answers for
  the bot, by signing a challenge with what it uses to check calls. This
  also stops an owner from aiming the server at a URL that is not a bot.

### Webhook: acknowledgement and failure

- The bot answers 2xx within a few seconds. Discord and Slack allow 3
  seconds. A slow answer counts as a failure, so that a slow bot cannot keep
  the server busy.
- The server retries a failed call a few times, with the same delivery ID,
  such as at once, after 5 seconds, and after 5 minutes. Then it gives up
  ([Q6](#open-questions)).
- A bot recovers anything that was given up with `history`
  ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)). Apron bots can read
  history, unlike Telegram bots. So the server needs no long queue for each
  bot, as Telegram keeps for 24 hours.
- The server turns off a webhook that answers 404 or 410, or that fails most
  calls for an hour, and tells the owner. Slack's rule is more than 95% of
  calls in 60 minutes, and only for apps with at least 1,000 calls an hour.
- The owner can see the webhook's state: when it last failed and why, and how
  many calls it skipped. Telegram's `getWebhookInfo` does this.
- The owner can pause the webhook and turn it on again without losing its
  settings. This is the kill switch that [issue #139] asks for.
- The owner can send a test call ([Q12](#open-questions)).

### Webhook: bounds, configuration, and lifecycle

- The server limits calls for each bot and for the whole server, each day.
- Choosing whom to call costs no storage reads in the common case.
- The webhook URL is a public `https` URL, as for push endpoints
  ([§4.9.1](../PROTOCOL.md#491-registration)).
- The bot sets its own webhook with the `ext:webhook` request, and chooses
  what calls it: messages meant for it, or every record of its rooms.
- The owner can also see, pause, and remove it, with commands that are up
  to the server, such as `/webhook`.
- A new token does not drop the webhook. A change to the webhook does not
  rotate the token.
- Rules that sign out idle bots, or drop push registrations that are not
  renewed, must not drop a bot that is called rarely. Otherwise the recipe
  tells webhooks to sign in on a schedule.

### Webhook: doing more after a call

- A webhook that needs more connects for a short time: for example `auth`,
  then `history` for the thread or the message that was replied to, then
  `message`, then close
  ([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)).
- A bot that answers at once puts request frames in the response instead.
- A call can carry a short-lived token for the connection, so that the bot
  needs no long-lived token of its own.
- What happens when many calls come at once is open
  ([Q11](#open-questions)).

Bot client:

- Check the signature and the timestamp, then answer `202` at once. Do the
  work after the answer, such as with `waitUntil` or a queue.
- Drop a call whose delivery ID it has seen.
- React at once to a call on its first try, such as with 👀, as
  [issue #139] suggests. Skip it on a retry.
- Remember where the last call ended. When `since` is absent or differs,
  catch up with `history`.
- Sign in on a schedule, if the server signs out idle bots.

### Reference implementation

- A template daemon, and a template webhook for one serverless platform, to
  start with Cloudflare Workers.
- Support for webhooks in the Cloudflare server (apron-server-cloudflare).
- Where a serverless webhook keeps its state ([Q14](#open-questions)).

## Decisions so far

- The name is **webhook** (Q28). A bot that the server calls is a webhook
  bot.
- The webhook is a draft extension, `ext:webhook`, for now
  ([Draft extension](#draft-extension-extwebhook)). It may become part of
  PROTOCOL.md once it has proved itself.
- It is its own request, not a kind of `push_register`, and each account has
  one webhook (Q16, Q26). The bot sets it (Q8).
- Calls follow Standard Webhooks, signed with Ed25519 (Q5).
- A call is one `ext:webhook` notification, sent as JSON. Its `params` are
  flat: `server` and `you` say who it is for, then each kind of payload in
  its own field, named as `history` and `room_update` name them, with
  `since` (Q13) and the records that help read it.
- One webhook serves bots and federation links, with two formats: `full`
  and `knock` (Q29). HTTPS is the only transport (Q30).
- `relay` retires, and `ext:remote` moves to the webhook. `push_register`
  stays for devices. These are later changes to PROTOCOL.md and the trusted
  federation recipe.
- The webhook's response can carry request frames, one JSON object a line,
  that the server runs as the bot (Q9, Q25).
- A call can carry a short-lived token that signs in as the bot (Q24). Tokens
  are opaque ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)), so its form is
  up to the server, such as a signed token with an expiry and a prefix.

## Open questions

Webhook delivery:

1. **Mentions outside the bot's rooms.** How does a bot learn of a
   mention in a room that it has not joined? A daemon gets no broadcast
   from that room, and a catch-up with `history` and no `room_id` covers
   only the rooms that it joined ([§4.3](../PROTOCOL.md#43-history)). For a
   webhook, the server could call it anyway. Telegram's Guest Mode delivers
   such a mention, and lets the bot answer once, with no history.
2. **Other events.** Do edits, deletions, reactions, and membership changes
   call the webhook? A call when an owner adds the bot to a room would let
   it greet once, as [issue #139] asks.
3. **Bursts.** Does the server send a burst as one call with several
   notifications, as Matrix and Meta do? It would cut requests from a busy
   room without dropping any.
4. **Both at once.** Can one bot be a daemon while it is connected, and a
   webhook bot while it is not? The server would skip the webhook while the bot has
   a live connection, and call it otherwise.

Webhook trust:

5. **Signatures.** Settled by the draft extension. HMAC-SHA256 with a secret for each bot, as Slack and
   GitHub use, or Ed25519 with one public key for the server, as Discord
   uses? With Ed25519, the server keeps no secret for each bot, and can
   publish its key. The bot then holds no second secret next to its token,
   which [issue #139] asks for.
6. **Retries.** Settled by the draft extension. How long does the server keep trying? Each retry later than
   a moment costs the server a scheduled wake.
7. **Bot to bot.** Can an owner opt in to calls for other bots' messages?
   Telegram allows it since 2026, and asks bots to guard against loops.
8. **Who sets the webhook.** Settled by the draft extension. Can the bot set its own webhook over the
   protocol? If so, this becomes an extension, not server policy.

Webhook answers:

9. **Answers in the response.** Settled by the draft extension. Can the bot answer in the webhook's HTTP
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
13. **Catch-up.** Settled by the draft extension. Does the sequence number earn its place? A bot could
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

Shape of the webhook:

16. **A push kind, or its own thing.** Settled by the draft extension. Is the webhook push kind `relay`
    ([§4.9.2](../PROTOCOL.md#492-kinds)) with a wake policy for bots, or a
    webhook of its own? `relay` is already in the protocol, so any server
    with push could call bots. But its payload is at most 2048 bytes, cut
    to fit ([§4.9.3](../PROTOCOL.md#493-payload)), and it has no delivery
    ID or sequence number. A webhook of its own can carry the whole
    message. A middle way is a field on `relay` that asks for the whole
    message, as Matrix pushers choose `data.format`. A kind from outside
    the core is named with `ext:` ([§4](../PROTOCOL.md#4-capabilities)),
    such as `ext:webhook`. Prior art for registering pushes: Matrix pushers
    (`kind: "http"` to a push gateway, which answers with the push keys to
    remove), Mastodon's Web Push subscriptions (with `alerts` and `policy`
    filters), UnifiedPush (Web Push through a distributor), and Telegram's
    `setWebhook`, where a bot sets its own webhook. No client uses `relay`
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

Shape of the webhook, continued:

24. **A token to connect back.** Settled by the draft extension. Does each call carry a short-lived token
    that signs in as the bot, so that a webhook needs no long-lived token of
    its own? Discord's interaction token (15 minutes, follow-ups only) and
    Slack's `response_url` (30 minutes, 5 uses) do this. It would be
    limited to the bot's rooms and to posting, reacting, typing, and
    reading, and could be signed rather than stored.
25. **Frames in the response.** Settled by the draft extension. If Q9 is yes, is the response body a list
    of request frames, one JSON object a line, that the server runs as the
    bot? It reuses the frames that a connection sends, with no results
    back.
26. **One webhook for each bot.** Settled by the draft extension. Is a webhook a registration among many, as a
    device's push is, or one setting for each bot, as Telegram's
    `setWebhook` and Mastodon's one subscription for each token are? Push
    registrations lapse unless a connection renews them, which suits
    devices and not a webhook that rarely connects.
27. **Unregistering everything.** Can a client remove all the
    registrations that it made without remembering each `url`, such as by
    `push_id`, or all those that its credential made? Mastodon ties a
    subscription to its access token.
28. **The name.** Decided: webhook. The thing is an outgoing webhook, as
    Telegram's `setWebhook` and Zulip's outgoing webhooks are. Incoming
    webhooks (Q20) go the other way.

Federation and transports:

29. **One webhook for bots and links.** Settled by the draft extension. The trusted federation recipe
    already wakes a mirror that sleeps: its link registers a `relay` push
    with the wake scope `ext:remote`, and the owner POSTs `{"push_id": …}`
    or `{}` to a URL on the mirror's own host, one push for several records
    ([trusted federation](trusted_federation.md#draft-extension-extremote)).
    Does the webhook replace this, with a mode that only knocks and may
    cover a burst, beside the mode that carries each message?
30. **Other transports.** Settled by the draft extension. Is HTTPS POST enough to wake an account, or does
    the webhook also need to open a WebSocket, or another transport, to the
    account that it wakes?

Learned from Zulip:

31. **Failures that people see.** Zulip posts "Failure! Bot is unavailable"
    in the conversation when its outgoing webhook fails, and sends the
    bot's owner a direct message with the status and the response. Does
    the server tell the asker, the owner, or both?
32. **Storage for bots.** Zulip keeps up to 10,000,000 characters of key and
    value storage for each bot on the server, so that a webhook bot needs
    no database. Does an Apron server offer this, which would answer Q14?
33. **Buttons as messages.** Zulip's button widget makes a click send an
    ordinary message, with the bot mentioned, so a click calls the bot by
    the usual path. Is that enough for Q18, without a callback of its own?

## Prior art

Research notes from the official documentation, November 2026. This section
goes away when the recipe is done.

| Platform | How events reach a bot | What a bot gets by default | Verifying the caller | Deadline and retries | Answering |
|---|---|---|---|---|---|
| Telegram | Webhook or long polling (`getUpdates`), not both; up to 100 connections at once | In groups, commands for it and replies to it (privacy mode); admins get everything; other bots' messages only by opt-in | Fixed `X-Telegram-Bot-Api-Secret-Token` header | Kept 24 hours; retried "a reasonable number of attempts"; `update_id` to find duplicates and order | Send API, or one method in the webhook response, with no result |
| Discord | Gateway WebSocket for messages; HTTP only for commands and other interactions | Message text only in DMs and mentions, unless `MESSAGE_CONTENT` is approved | Ed25519 of timestamp and body; probes with bad signatures, and removes URLs that accept them | 3 seconds; webhook events retried for 10 minutes, then disabled | In the response, or deferred, with a token for follow-ups for 15 minutes |
| Slack | Events API over HTTP, or Socket Mode | `app_mention`, or every message where the app is a member with `*:history` scopes | HMAC-SHA256 of `v0:timestamp:body`; 5-minute window | 3 seconds; retried at once, after 1 minute, after 5 minutes; off after more than 95% failures in an hour | Web API; slash commands in the response, or `response_url` 5 times in 30 minutes |
| Matrix application service | Ordered transactions of events, each with a `txnId` | Every event in rooms that its namespaces match | `Authorization: Bearer <hs_token>` | Queued, with exponential backoff; a retry repeats its transaction exactly | Client-server API |
| Zulip | Outgoing webhook, or an event queue with long polling | Mentions and DMs; never other bots' messages | Fixed token in the body, never rotated | 10 seconds; 4 tries on a timeout or a failed connection, none on an error status; then "Failure!" in the conversation and a direct message to the owner | `{"content": …}` in the response, which the server posts in the same topic, or the REST API |
| Teams (Bot Framework) | HTTP POST of Activities | Mentions, unless the install grants permission for all messages; never other bots | JWT from the Bot Connector, checked against its published keys | 15 seconds | Connector REST API |
| GitHub (not chat) | Webhook | What the webhook subscribes to | HMAC-SHA256 (`X-Hub-Signature-256`); a delivery ID | 10 seconds; no automatic retries; manual redelivery for 3 days | Not applicable |

## Draft extension: `ext:webhook`

This recipe needs one change to the wire, which servers advertise as the
capability `ext:webhook`. It is a draft: it can still change, and it moves to
the [extensions](../EXTENSIONS.md) once it has proved itself.

Adds webhooks: the server sends an account the records that concern it in
HTTPS calls to a URL that the account sets. So an account, such as a bot or
a link ([trusted federation](trusted_federation.md)), needs no connection
open while it waits.

```jsonc
// <- the server frame
{
  "method": "server", "params": {
    "apron": 10, "auth": ["token"], "capabilities": ["history", "ext:webhook"],
    "ext": {"webhook": {"keys": ["whpk_MCowBQYDK2VwAyEA…"], "wake": ["mentions", "replies", "private", "joined"]}}
  }
}
// -> the bot sets its webhook
{
  "method": "ext:webhook", "id": "c1", "params": {
    "url": "https://bot.example/apron", "wake": ["mentions", "replies", "private"]
  }
}
// <- the setting as it is now; the server verifies the URL first
{"id": "c1", "result": {"url": "https://bot.example/apron", "wake": ["mentions", "replies", "private"], "format": "full", "endpoint_id": "wh_4f2kQ9xT", "state": "verifying"}}
```

```http
POST /apron HTTP/1.1
Host: bot.example
Content-Type: application/json
webhook-id: msg_1724803200042_4f2kQ9xT
webhook-timestamp: 1724803201
webhook-signature: v2a,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4…

{
  "method": "ext:webhook", "params": {
    "server": "wss://chat.example/ws",
    "you": {"user_id": "bot_ada", "name": "Ada's bot", "roles": ["bot"]},
    "attempt": 1, "since": "1724803100377",
    "first_log_id": "1724803200042", "last_log_id": "1724803200042",
    "token": "apron_webhook_…",
    "wake": {"1724803200042": ["mentions", "replies"]},
    "messages": [
      {
        "message_id": "1724803200042", "log_id": "1724803200042", "room_id": "general",
        "from": {"user_id": "alice", "name": "Alice", "roles": ["admin"]},
        "reply_to": {
          "message_id": "1724803100377", "log_id": "1724803100377", "room_id": "general",
          "from": {"user_id": "bot_ada", "name": "Ada's bot", "roles": ["bot"]},
          "body": {"text": "Sunny today, 21°C."}
        },
        "body": {"text": "@bot_ada and tomorrow?", "mentions": ["bot_ada"]}
      }
    ],
    "rooms": [{"room_id": "general", "log_id": "1724790000000", "title": "General"}],
    "users": [{"user_id": "alice", "name": "Alice", "roles": ["admin"]}]
  }
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/jsonl

{"method": "reactions", "id": "r-1724803200042", "params": {"message_id": "1724803200042", "emojis": ["👀"]}}
{"method": "message", "id": "a-1724803200042", "params": {"room_id": "general", "reply_to": {"message_id": "1724803200042"}, "body": {"text": "Rain tomorrow, 14°C."}}}
```

```ts
class WebhookServer {           // server.ext.webhook
  keys: string[];               // the server's Ed25519 public keys, "whpk_" and base64
  wake: string[];               // the scopes that this server implements
  format?: string[] = ["full"]; // the formats that this server sends: "full", "knock"
}

class Webhook {                 // ext:webhook params and result
  url?: string;                 // https; "" removes the webhook
  wake?: string[];              // default ["mentions", "replies", "private"]
  format?: string = "full";     // "full" or "knock"
  paused?: boolean = false;
  endpoint_id?: string;         // result only: the Standard Webhooks endpoint ID, without "."
  state?: string;               // result only: "verifying", "on", "paused", or "failing"
  error?: string;               // result only: why the last call failed
}

class Call {                    // ext:webhook notification params: the body of a call
  // the call
  server: string;               // the server's address (§1)
  you: User;                    // the account, as `you` after auth (§3.2)
  attempt: number;              // 1, then 2 and up on each retry
  since?: string;               // last_log_id or latest_log_id of the previous call to this webhook
  first_log_id?: string;        // the bounds of the records that matched, as in history (§4.3)
  last_log_id?: string;
  latest_log_id?: string;       // "knock" only: the newest record that matched
  token?: string;               // a bearer token that signs in as the account (§3.2.1)
  wake?: Record<string, string[]>;  // message_id: the scopes that the message matched
  skipped?: number;             // calls left out for a limit since the previous call
  // records, as history names them (§4.3)
  messages?: Message[];
  reactions?: Reactions[];
  memberships?: Membership[];
  rooms?: Room[];               // room records that changed, or that the call refers to
  // changes to the account's rooms, as room_update names them (§4.2.3)
  joined?: Room[];              // rooms that the account joined, with members
  left?: { room_id: string }[]; // rooms that the account is no longer in, for any reason
  // records that help read the call
  users?: User[];               // user objects (§3.3.1) that the call refers to
}
```

Setting the webhook:

- `ext:webhook` sets the webhook of the authenticated account. An account
  has at most one. Params merge into it as user objects do
  ([§3.3.1](../PROTOCOL.md#331-user-objects)). `{}` changes nothing.
- The result is the whole setting as it is now, with its `state`.
- Server policy decides which accounts may set a webhook, such as bots and
  links. Others get `denied`.
- `url` is an `https` URL that the server will send to, as for push
  endpoints ([§4.9.1](../PROTOCOL.md#491-registration)). Another is
  `invalid_params`. `"url": ""` removes the webhook.
- A webhook stays until the account removes it, or the server turns it off.
  It does not lapse when the account stays away. A new token for the account
  does not remove it.
- `paused: true` stops calls and keeps the setting.

Verifying:

- When `url` changes, the server verifies the URL with the endpoint
  verification extension of Standard Webhooks: a signed POST with a
  `webhook-challenge` header, which the URL answers with
  `webhook-challenge-response`. An echo of the challenge would prove
  neither that the URL holds the key nor that it agreed to calls from this
  server.
- `state` is `"verifying"` until the URL answers. Then it is `"on"`.
  Otherwise it is `"failing"`, with `error`, and the server sends nothing
  else to the URL.
- Server policy can bind a link's URL to the address of its server instead,
  as the trusted federation recipe does.

What calls the webhook:

- `wake` lists the scopes of the calls, from those that `server.ext.webhook`
  lists. Others are ignored. `[]` calls for nothing.
- `mentions`, `replies`, and `private` match new messages as for push
  ([§4.9.4](../PROTOCOL.md#494-wake)), with the account as the user. A
  message from a user with the role `bot` matches none of them.
- `joined` matches every record of the rooms that the account joined:
  messages and their changes, reactions, memberships, and room records.
- No record of the account's own matches, except for `joined`.
- The server does not wait, coalesce, or check status or mutes before a
  call, as it does for push.
- The server sends no calls while the account has an open connection.

Calls:

- A call is a POST of one `ext:webhook` notification
  ([§1](../PROTOCOL.md#1-transport--framing)) as `application/json`. Its
  `params` are flat: each field holds one kind of payload, under the name
  that `history` or `room_update` gives it.
- `server` and `you` say which server called and for which account, so that
  one URL can serve several servers and accounts. The account trusts only
  the `keys` of the server that `server` refers to.
- `you` changes when the account's profile or `roles` change, as a `user`
  `you` notification would ([§3.3.3](../PROTOCOL.md#333-changes)).
- With `format` `"full"`, a call carries the records that matched, in
  `log_id` order. One call can carry several. `wake` lists the scopes of each
  new message that matched. A bot answers only the messages in `wake`.
- `joined` and `left` tell the account of changes to its own rooms, under
  every scope. `left` also covers a room that the account lost without a
  membership record.
- A call also carries records that help read it: the `rooms` and `users`
  that its records refer to. A message's `reply_to` is the full snapshot of
  the message that it replies to, as servers may send it
  ([§3.5.4](../PROTOCOL.md#354-references)). These are records that the
  account may see. The account applies them as any record
  ([§2.3](../PROTOCOL.md#23-records-and-replay)).
- With `format` `"knock"`, a call carries no records, and `latest_log_id` is
  the newest record that matched. One knock covers every record committed
  before it was sent. A record after it gets another.
- `since` is the `last_log_id`, or the `latest_log_id`, of the previous call
  to this webhook. The server leaves it out when it does not know. When
  `since` is absent, or is not where the account last read to, the account
  reads `history` from where it last read
  ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)).
- To fit its limits, the server first sends `reply_to` bare, then leaves out
  the other records that help read the call. Then it splits the records over several
  calls.
- `token` (optional) is a bearer token that signs in as the account
  ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)). The server chooses its
  lifetime and what it allows, such as 15 minutes, and posting, reacting,
  typing, and `history` in the account's rooms.

Signatures:

- Calls follow Standard Webhooks, with its headers `webhook-id`,
  `webhook-timestamp`, and `webhook-signature`.
- `webhook-id` identifies the call. It is the same on each retry.
- The server signs with the asymmetric scheme `v2a` (Ed25519). `keys` lists
  the public keys. A call can carry several signatures while a key changes.
- The endpoint ID is `endpoint_id` from the result. The server chooses it
  for each webhook, keeps it for as long as the webhook has its `url`, and
  never puts `.` in it, as Standard Webhooks requires. A `user_id` can
  contain `.`, so it is not the endpoint ID.
- `webhook-id` never contains `.` either.
- The account checks a signature with one of `keys`, checks that
  `webhook-timestamp` is within 5 minutes, and drops a `webhook-id` that it
  has seen.

Responses:

- The URL answers 2xx within the server's time limit, such as 5 seconds.
  Anything else is a failure.
- The body of a 2xx can be request frames, one a line, as on a byte-stream
  transport ([§1](../PROTOCOL.md#1-transport--framing)). The server runs them
  in order as the account, with what `token` allows, and sends no results.
  It deduplicates them as any request
  ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)).
- The server limits how many frames it runs, such as 4. A frame that fails
  sets `error`.

Failures:

- The server retries a call that timed out, could not connect, or got a 5xx
  or a 429, a few times, such as at once, after 5 seconds, and after 5
  minutes. It honors `Retry-After`.
- The server does not retry a call that got another 4xx.
- A 410 removes the webhook.
- After calls fail for a time that the server chooses, `state` is
  `"failing"`, and the server can stop calling until the account sets the
  webhook again.

Without the extension, a bot holds a connection
([Daemon](#daemon)), or connects on its own schedule. A server without it
answers `ext:webhook` as an unknown method
([§1](../PROTOCOL.md#1-transport--framing)).

### References

- [Standard Webhooks 1.0](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
  and its [endpoint verification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/extensions/endpoint-verification.md)
  extension
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032): Ed25519

## Limits

To be written.

[issue #139]: https://github.com/shazow/apron/issues/139
[Issue #139]: https://github.com/shazow/apron/issues/139
