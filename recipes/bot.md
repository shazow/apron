# Bots

**Status**: Draft. Requirements and open questions, while we research the
server API and reference bot clients. Webhook bots use the push kind
[`webhook`](../PROTOCOL.md#494-webhook), new in protocol v11.

**How can a bot run on Apron?** In one of two ways. A **daemon** holds a
connection, reads every message in its rooms, and picks out what it needs.
A **webhook bot** sleeps until the server calls it, and then connects only for as
long as it has work. Daemons work with any server. Webhook bots need a server
whose `server.push` offers `webhook`.

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
- A bot ignores its own messages and, by default, messages from users with
  the role `bot`, so that two bots cannot answer each other forever. The
  server does not filter them for the bot.
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

- The bot registers with `wake: ["mentions", "replies", "private"]`, the
  messages that are meant for it ([Both modalities](#both-modalities)).
  Without `wake`, a server wakes for `mentions` and `replies` only
  ([§4.9.2](../PROTOCOL.md#492-wake)).
- The owner can opt in to every new message in the bot's rooms with
  `joined`, or to every record of them with `records`: edits, deletes,
  reactions, memberships, and room records
  ([§4.9.2](../PROTOCOL.md#492-wake)). Every platform that we looked at
  makes the full stream an opt-in.
- The server does not coalesce calls, wait first, or check whether the bot
  is attended, as it does for push to a person.
- The server skips a bot that has a live connection, since the bot already
  gets the broadcast.
- The server does not filter other bots' messages: they match each scope
  like any message. A call carries each sender's user object with its
  `roles` ([§4.9.4](../PROTOCOL.md#494-webhook)), so the bot ignores other
  bots itself. Telegram and Teams filter them on the server by default. A
  server can still limit calls between bots, as policy.

### Webhook: what a call carries

- The body holds the whole records, with `log_id`, split by kind as in a
  `history` result ([§4.3](../PROTOCOL.md#43-history)), not cut down to fit a push
  ([§4.9.3](../PROTOCOL.md#493-web-push)). One parser then serves both
  modalities.
- Each call has a `webhook-id` that stays the same on a retry, so that the
  bot can drop a duplicate.
- Each call says where the previous call ended (`since`), so that the bot
  can tell when it missed one. A gap in `log_id`s cannot show this, because
  `log_id`s are one sequence for the whole server
  ([§2.1](../PROTOCOL.md#21-log_id)). A server can keep it in memory, and
  leave it out after a restart, which tells the bot to catch up.
- `wake` says why the server called: a mention, a reply, a private room, or
  every message. The server knows who wrote the message that was replied
  to, so a webhook does not have to remember the IDs of its own messages,
  as a daemon does.
- The call carries the records that help read it: the users, with their
  `roles` ([§3.3.4](../PROTOCOL.md#334-roles)), the rooms, and the message
  that was replied to. The bot then needs no `room_list` or `history` for
  the common case.
- `attempt` says how many times the server tried the call, and the
  `message_id` says when the message came. A bot then knows when the moment
  has passed, such as for an instant reaction.
- After the server skips calls for a limit, the next call says how many it
  skipped (`skipped`), as Slack's `app_rate_limited` does.
- To fit its limits, a server first sends `reply_to` bare. It then leaves
  out the `rooms` and `users` that only help read the call. It then splits
  the records over several calls.

### Webhook: signing and verifying

- The server signs each call with Standard Webhooks' Ed25519 scheme `v2a`
  ([§4.9.4](../PROTOCOL.md#494-webhook)). The signature covers the
  `endpoint_id`, a timestamp, and the raw body, so that a call cannot be
  replayed later or to another bot.
- Before the server calls a URL, the URL answers a challenge with what it
  uses to check calls (endpoint verification). This also stops an owner from
  aiming the server at a URL that is not a bot.
- The answer needs the `endpoint_id`. So a server verifies after it sends
  the `push_register` result, and tries again a few times, such as on the
  schedule of a call's retries.

### Webhook: acknowledgement and failure

- The bot answers 2xx within 30 seconds, the top of the range that Standard
  Webhooks suggests. Discord and Slack allow 3 seconds. A slow answer counts
  as a failure, so that a slow bot cannot keep the server busy for long.
- The server retries a call that timed out, could not connect, or got 429
  or 5xx, a few times, such as at once, after 5 seconds, and after 5
  minutes. Then it gives up. It honors `Retry-After`.
- The server does not retry a call that got 3xx or another 4xx, and does
  not follow redirects. A 410 removes the registration
  ([§4.9.1](../PROTOCOL.md#491-registration)).
- A bot recovers anything that was given up with `history`
  ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)). Apron bots can read
  history, unlike Telegram bots. So the server needs no long queue for each
  bot, as Telegram keeps for 24 hours.
- The server sets `state` to `"failing"` when most calls fail for an hour,
  stops calling until the bot registers again, and tells the owner. Slack's
  rule is more than 95% of calls in 60 minutes, and only for apps with at
  least 1,000 calls an hour.
- The bot or its owner can see the webhook's state: `push_register` with the
  same `url` returns `state`, and `error` says when it last failed and why.
  Telegram's `getWebhookInfo` does this.
- The owner can pause the webhook and turn it on again without losing its
  settings, with a server command such as `/webhook pause`. This is the
  kill switch that [issue #139] asks for.
- The owner can send a test call ([Q12](#open-questions)).

### Webhook: bounds, configuration, and lifecycle

- The server limits calls for each bot and for the whole server, each day,
  such as 10,000 for each bot.
- Choosing whom to call costs no storage reads in the common case.
- The webhook URL is a public `https` URL, as for every push endpoint
  ([§4.9.1](../PROTOCOL.md#491-registration)).
- The bot registers its own webhook with `push_register` and the kind
  `webhook`, and chooses what calls it with `wake`. Which accounts may
  register a `webhook` is server policy
  ([§4.9.1](../PROTOCOL.md#491-registration)). A server can allow it for
  bots and federation links, and refuse it for other accounts.
- The owner can also see, pause, and remove it, with commands that are up
  to the server, such as `/webhook`.
- A new token does not drop the webhook. A change to the webhook does not
  rotate the token.
- A `webhook` registration does not lapse while the bot stays away
  ([§4.9.1](../PROTOCOL.md#491-registration)). Rules that sign out idle bots
  also need to leave a bot that is called rarely alone. Otherwise the bot
  has to sign in on a schedule.

### Webhook: doing more after a call

- A webhook that needs more connects for a short time: for example `auth`,
  then `history` for the thread or the message that was replied to, then
  `message`, then close
  ([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)).
- A bot that answers at once puts request frames in the response instead,
  one a line. The server can limit how many it runs, such as 10, and report
  a frame that fails in `error`.
- A call can carry a short-lived `token` for the connection, so that the
  bot needs no long-lived token of its own. It does not replace a token that
  the bot saved ([§4.9.4](../PROTOCOL.md#494-webhook)). A server can let
  it sign in for 15 minutes, and post, react, show typing, and read
  `history` only in the bot's rooms. It can stop working earlier, such as
  when the bot gets a new bearer token.
- What happens when many calls come at once is open
  ([Q11](#open-questions)).

Bot client:

- Check the signature with the `signature_keys` of the server that `server` refers to,
  and only those, and refuse a `webhook-timestamp` more than 5 minutes from
  the bot's clock. Then answer `202` at once. Do the work after the answer,
  such as with `waitUntil` or a queue.
- Answer the endpoint verification even before the bot can check a call.
- Drop a call whose `webhook-id` it has seen.
- Answer only the messages in `wake`. By default, skip those whose `from`
  has the role `bot`.
- React at once to a call on its first `attempt`, such as with 👀, as
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
- The webhook is the push kind `webhook` of PROTOCOL.md v11
  ([§4.9.4](../PROTOCOL.md#494-webhook)), not an extension. It started as
  the draft `ext:webhook`.
- A bot registers it with `push_register`, as a device does (Q8, Q16). A
  `webhook` registration does not lapse while the bot stays away (Q26).
  Registering again with the same `url` returns its state.
- Each push kind has its own wake scopes, in `server.push`. `records` adds
  every record of the bot's rooms (Q2).
- The protocol does not filter bots' messages (Q7). A call carries each
  sender's user object with its `roles`, so a bot ignores other bots'
  messages if it wants. A server can still limit calls between bots, as
  policy.
- Calls follow Standard Webhooks, signed with Ed25519 (`v2a`), to a URL that
  passed endpoint verification (Q5).
- A call is one `webhook` notification, sent as JSON. Its `params` are flat:
  `server` and `you` say who it is for, then each kind of payload in its own
  field, named as `history` and `room_update` name them, with `since` (Q13)
  and the records that help read it. One call can carry several records
  (Q3).
- One webhook serves bots and federation links, with two formats: `full`
  and `knock` (Q29). HTTPS is the only transport (Q30).
- The push kind `relay` and the wake scope `badge` retire in v11, and
  `ext:remote` moves to the webhook. `webpush` stays for devices.
- The webhook's response can carry request frames, one JSON object a line,
  that the server runs as the bot (Q9, Q25).
- A call can carry a short-lived token that signs in as the bot (Q24). Tokens
  are opaque ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)), so its form is
  up to the server, such as a signed token with an expiry and a prefix.
- The server does not call a bot that has a connection open (Q4).
- Retries, limits, and the token's lifetime are server policy, with the
  numbers that this recipe suggests (Q6).

## Open questions

Webhook delivery:

1. **Mentions outside the bot's rooms.** How does a bot learn of a
   mention in a room that it has not joined? A daemon gets no broadcast
   from that room, and a catch-up with `history` and no `room_id` covers
   only the rooms that it joined ([§4.3](../PROTOCOL.md#43-history)). For a
   webhook, the server could call it anyway. Telegram's Guest Mode delivers
   such a mention, and lets the bot answer once, with no history.
2. **Other events.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). Do edits, deletions, reactions, and membership changes
   call the webhook? A call when an owner adds the bot to a room would let
   it greet once, as [issue #139] asks.
3. **Bursts.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). Does the server send a burst as one call with several
   notifications, as Matrix and Meta do? It would cut requests from a busy
   room without dropping any.
4. **Both at once.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). Can one bot be a daemon while it is connected, and a
   webhook bot while it is not? The server would skip the webhook while the bot has
   a live connection, and call it otherwise.

Webhook trust:

5. **Signatures.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). HMAC-SHA256 with a secret for each bot, as Slack and
   GitHub use, or Ed25519 with one public key for the server, as Discord
   uses? With Ed25519, the server keeps no secret for each bot, and can
   publish its key. The bot then holds no second secret next to its token,
   which [issue #139] asks for.
6. **Retries.** Settled: server policy, with the advice under [acknowledgement and failure](#webhook-acknowledgement-and-failure). How long does the server keep trying? Each retry later than
   a moment costs the server a scheduled wake.
7. **Bot to bot.** Settled in v11: the server does not filter bots' messages, and a call carries each sender's `roles`, so the bot decides ([§4.9.4](../PROTOCOL.md#494-webhook)). Can an owner opt in to calls for other bots' messages?
   Telegram allows it since 2026, and asks bots to guard against loops.
8. **Who sets the webhook.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). Can the bot set its own webhook over the
   protocol? If so, this becomes an extension, not server policy.

Webhook answers:

9. **Answers in the response.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). Can the bot answer in the webhook's HTTP
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
13. **Catch-up.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). Does the sequence number earn its place? A bot could
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

16. **A push kind, or its own thing.** Settled in v11: a push kind, `webhook`, with a payload of its own ([§4.9.4](../PROTOCOL.md#494-webhook)). Is the webhook push kind `relay`
    ([v9 §4.9.2](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#492-kinds)) with a wake policy for bots, or a
    webhook of its own? `relay` is already in the protocol, so any server
    with push could call bots. But its payload is at most 2048 bytes, cut
    to fit ([v9 §4.9.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#493-payload)), and it has no delivery
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

24. **A token to connect back.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). Does each call carry a short-lived token
    that signs in as the bot, so that a webhook needs no long-lived token of
    its own? Discord's interaction token (15 minutes, follow-ups only) and
    Slack's `response_url` (30 minutes, 5 uses) do this. It would be
    limited to the bot's rooms and to posting, reacting, typing, and
    reading, and could be signed rather than stored.
25. **Frames in the response.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). If Q9 is yes, is the response body a list
    of request frames, one JSON object a line, that the server runs as the
    bot? It reuses the frames that a connection sends, with no results
    back.
26. **One webhook for each bot.** Settled in v11: a registration among many, which does not lapse ([§4.9.1](../PROTOCOL.md#491-registration)). Is a webhook a registration among many, as a
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

29. **One webhook for bots and links.** Settled in v11: the format `knock` ([§4.9.4](../PROTOCOL.md#494-webhook)). The trusted federation recipe
    already wakes a mirror that sleeps: its link registers a `relay` push
    with the wake scope `ext:remote`, and the owner POSTs `{"push_id": …}`
    or `{}` to a URL on the mirror's own host, one push for several records
    ([trusted federation](trusted_federation.md#draft-extension-extremote)).
    Does the webhook replace this, with a mode that only knocks and may
    cover a burst, beside the mode that carries each message?
30. **Other transports.** Settled in v11 ([§4.9.4](../PROTOCOL.md#494-webhook)). Is HTTPS POST enough to wake an account, or does
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

## Limits

To be written.

[issue #139]: https://github.com/shazow/apron/issues/139
[Issue #139]: https://github.com/shazow/apron/issues/139
