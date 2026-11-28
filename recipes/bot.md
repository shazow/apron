# Bots

**Status**: Draft, for protocol v11. Next come a template daemon, a template
webhook bot for Cloudflare Workers, and webhooks in the Cloudflare server
(apron-server-cloudflare).

**How can a bot run on Apron?** In one of two ways. A **daemon** holds a
connection, reads every message in its rooms, and picks out what it needs.
A **webhook bot** keeps no connection: the server calls its webhook when a
message needs it, and the bot connects only for as long as it has work.
Daemons work with any server. Webhook bots need a server whose `server.push`
offers [`webhook`](../PROTOCOL.md#494-webhook).

A daemon suits a host that runs all the time, such as a server, a
container, or a computer at home. It also suits a bot that reads most
messages, or that answers at once and often. A webhook bot suits a
serverless host, such as a Cloudflare Worker, an AWS Lambda function, or a
Cloud Run service. It suits a bot that answers now and then, and it costs
nothing while it waits. A bot that posts on its own schedule, such as a
deploy hook or a cron job
([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)),
works like a webhook bot that something other than the server starts.

## How it works

The **owner** is the person who runs the bot. Bullets under a step give
advice to the bot, or to the server where they say so.
[Issue #139] has a longer checklist for bots.

Every bot:

1. The owner gets a bearer token for the bot
   ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)). The bot has the role `bot`
   ([§3.3.4](../PROTOCOL.md#334-roles)).
   - The token signs in from any origin.
   - Keep the token in one place. Keep the part of the bot that holds it
     small, apart from the part that decides what to say.
   - Remove token-like strings from what the bot sends, as [issue #139]
     suggests.
2. The bot picks out the messages that are meant for it:
   - a message that mentions the bot in `body.mentions`
     ([§3.5.5](../PROTOCOL.md#355-mentions));
   - a reply to a message of the bot's
     ([§3.5.4](../PROTOCOL.md#354-references));
   - a message in a private room that the bot joined, or in one of its
     threads.

   Advice:
   - Servers never parse `text` for mentions. A bot that also wants
     `@user_id` in text, as [issue #139] suggests, reads every message.
   - Skip the bot's own messages. By default, also skip messages from users
     with the role `bot`, so that two bots cannot answer each other forever.
   - Decide who may ask for what by their `roles`, before the bot acts and
     again where it acts, as [issue #139] asks.
3. The bot answers in the room where it was asked, with `reply_to` where it
   fits.
   - Make the request `id` from the message that the bot answers, such as
     `a-<message_id>`. The server deduplicates requests by `user_id` and
     `id` ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)). So a retry
     posts once, even from a bot with no state.
   - React at once to a new message that is meant for the bot, such as with
     👀, as [issue #139] suggests. Skip the reaction during a catch-up, and
     on a webhook call whose `attempt` is above 1. The `message_id` says when
     the message came, so the bot can tell when the moment has passed.
   - Show typing before a long answer ([§4.6](../PROTOCOL.md#46-activity)).
   - Wait for `retry_after` when the server asks for it
     ([§1.1](../PROTOCOL.md#11-envelope-and-replies)).
   - Cloudflare server: it remembers request `id`s for 24 hours.

A daemon:

4. The daemon connects, and joins each room that it watches. It gets
   broadcasts only for the rooms that it joined
   ([§3.4](../PROTOCOL.md#34-rooms)).
   - Hold one connection, ever.
   - A server that hibernates idle connections, as the Cloudflare server
     does, pays little for a daemon that waits.
   - Cloudflare server: it allows 8 signed-in connections for each account,
     and the newest signs out the oldest.
   - Cloudflare Workers: a daemon in a Durable Object stays awake for as
     long as its own WebSocket client is open. Only WebSockets that the
     object accepts can hibernate. So a daemon costs as much there as on
     any other host, or more.
5. The daemon checks each message as it comes (step 2).
   - Remember the IDs of the bot's own messages, so that replies to them
     count.
   - Save the `log_id` of each record after the daemon handles it.
6. After a disconnect, the daemon connects again and catches up.
   - Reconnect with backoff. Stop when `auth` is denied.
   - A timeout for connecting does not apply to idle reads.
   - Read `history` with no `room_id`, with `after` one past the saved
     `log_id` ([§4.3.2](../PROTOCOL.md#432-bounds-and-order)). One log then
     covers every room that the daemon joined
     ([§4.3](../PROTOCOL.md#43-history)), and the Cloudflare server
     supports it. Buffer the live records meanwhile
     ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)).
7. The daemon runs under a supervisor that checks its liveness.
   - Give it a kill switch that keeps the bot off until its owner turns it
     on.

A webhook bot:

8. The bot registers its webhook: `push_register` with the kind `webhook`,
   its URL, and the messages that are meant for it in `wake`
   ([§4.9.2](../PROTOCOL.md#492-wake)).

   ```jsonc
   // ->
   {
     "method": "push_register", "id": "c33", "params": {
       "kind": "webhook", "url": "https://bot.example/apron", "wake": ["mentions", "replies", "private"]
     }
   }
   // <-
   {"id": "c33", "result": {"endpoint_id": "wh_4f2kQ9xT", "state": "verifying"}}
   ```

   - The URL is a public `https` URL
     ([§4.9.1](../PROTOCOL.md#491-registration)).
   - Read `server.push.webhook.wake` first. A server ignores the scopes that
     it does not support, and refuses a `wake` with none that it supports
     as `invalid_params`.
   - Without `wake`, a server uses its defaults, which for a webhook are
     usually `mentions`, `replies`, and `private`.
   - The owner can opt in to every new message in the bot's rooms with
     `joined`. `records` adds every record of them: message snapshots, such
     as edits and deletes, reactions, memberships, and room records. It also
     includes the bot's own records. Every platform that we looked at makes
     the full stream an opt-in.
   - The bot needs no scope to hear that it joined or left a room. Those
     changes always call the webhook, so the bot can greet a room once, as
     [issue #139] asks.
   - The default `format` is `full`. A `knock` call carries no records,
     `wake`, or room changes, for an account that reads them itself, as a
     [federation link](trusted_federation.md#draft-extension-extremote)
     does.
   - Registering again with the same `url` keeps the `endpoint_id`, and
     returns the current `state`. So the bot can register each time that it
     starts. `push_unregister` removes the webhook.
   - Server: which accounts may register a `webhook` is server policy
     ([§4.9.1](../PROTOCOL.md#491-registration)). Allow it for bots and
     federation links, and refuse it for other accounts.
   - Server: a `webhook` registration needs no renewal, unlike Web Push
     ([§4.9.3](../PROTOCOL.md#493-web-push)). Rules that sign out idle
     accounts also need to leave a bot that is called rarely alone.
     Otherwise the bot has to sign in on a schedule.
   - Server: a new token does not drop the webhook, and a change to the
     webhook does not rotate the token.
   - Server: let the owner see, pause, and remove the webhook, with commands
     such as `/webhook` and `/webhook pause`. A pause keeps the settings,
     and `state` is `"paused"`. It is the kill switch that [issue #139] asks
     for.
9. The bot answers the server's endpoint verification
   ([§4.9.4](../PROTOCOL.md#494-webhook)). The server sends it right after
   the `push_register` result. `state` stays `"verifying"` until the URL
   passes.
   - Serve the URL before the bot registers.
   - The answer needs the `endpoint_id`. Save it where the webhook can read
     it, such as in a Durable Object, as soon as the result comes. The
     challenge can come before the bot has saved it.
   - The verification's body carries `server` and `you`. So a URL that
     serves several registrations finds the `endpoint_id` to answer with.
   - Registering again while `state` is `"verifying"` or `"failing"` sends
     a new verification. So a bot that missed the first one registers
     again.
   - Server: try the verification again a few times, such as on the
     schedule of a call's retries. After the last try fails, `state` is
     `"failing"`, and `error` says why.
   - The verification also stops an owner from aiming the server's calls at
     a URL that is not a bot
     ([§5.5](../PROTOCOL.md#55-network-privacy-and-server-requests)).
10. The server calls the webhook with a `webhook` notification
    ([§4.9.4](../PROTOCOL.md#494-webhook)). It carries:
    - the whole records, with `log_id`, split by kind as in a `history`
      result ([§4.3](../PROTOCOL.md#43-history)). So the bot parses a call
      as it parses a `history` result.
    - `server` and `you`, which say whom the call is for. So one URL can
      serve several servers and bots.
    - `wake`, the scopes that each new message matched. The server knows who
      wrote the message that was replied to, so the bot does not have to
      remember the IDs of its own messages.
    - the `users`, the `rooms`, and each `reply_to` as a full snapshot.
      Every user object carries its `roles`, each record's `from` included. The bot then needs no `room_list` or `history` in the
      common case.
    - `attempt`, `since`, and `token`, which other steps use.

    Advice for the server:
    - Call at once. Don't wait first, or check whether the bot is attended,
      as for push to a person. One call can still carry several records that
      came together.
    - Don't call while the bot has a connection open, which gets the
      broadcast. So a bot can be a daemon while it is connected, and a
      webhook bot while it is not.
    - Choosing whom to call needs no storage reads in the common case.
    - Limit calls for each bot and for the whole server, each day, such as
      10,000 for each bot. After the server skips calls for a limit, the
      next call says how many in `skipped`, as Slack's `app_rate_limited`
      does.
    - Keep each call within a size limit, such as 256 KiB, as for a frame
      ([§1](../PROTOCOL.md#1-transport--framing)).
      To fit it, first send `reply_to` bare. Then leave out the `rooms` and
      `users` that only help read the call. Then split the records over
      several calls.
    - The signature covers the `endpoint_id`, the timestamp, and the raw
      body. So nobody can replay a call later, or to another bot. With
      Ed25519, the server keeps no secret for each bot, and the bot holds no
      second secret next to its token, which [issue #139] asks for.
11. The bot checks the call, and acknowledges it.
    - Check the signature with the `signature_keys` of the server that
      `server` refers to, and only those.
    - Refuse a `webhook-timestamp` more than 5 minutes from the bot's clock.
    - Drop a call whose `webhook-id` the bot has seen. A retry keeps its
      `webhook-id`.
    - Answer only the messages in `wake`. Apply the other records as any
      record ([§2.3](../PROTOCOL.md#23-records-and-replay)).
    - Answer `202` at once, and do the work after the answer, such as with
      `waitUntil` or a queue.
    - The server needs a 2xx within 30 seconds, the top of the range that
      Standard Webhooks suggests. Discord and Slack allow 3 seconds. Any
      other answer is a failure, so a slow bot cannot keep the server busy
      for long.
    - Server: retry a call that timed out, could not connect, or got 429 or
      5xx, a few times, such as at once, after 5 seconds, and after 5
      minutes. Then give up. Honor `Retry-After`.
    - Server: don't retry a call that got 3xx or another 4xx, and don't
      follow redirects. A 410 removes the registration
      ([§4.9.1](../PROTOCOL.md#491-registration)).
    - Server: when most calls fail for an hour, set `state` to `"failing"`,
      stop calling until the bot registers again, and tell the owner.
      Slack's rule is more than 95% of calls in 60 minutes, and only for apps
      with at least 1,000 calls an hour.
    - The bot or its owner sees the webhook's `state` by registering again
      with the same `url`. `error` says what failed last, with any `state`,
      as Telegram's `getWebhookInfo` does.
12. A bot that answers at once can answer in the response: frames, one a
    line, that the server runs in order as the bot
    ([§4.9.4](../PROTOCOL.md#494-webhook)). They can be requests, or
    notifications such as `activity` with `typing`
    ([§4.6](../PROTOCOL.md#46-activity)).

    ```http
    HTTP/1.1 200 OK
    Content-Type: application/jsonl

    {"method": "reactions", "id": "r-1724803200042", "params": {"message_id": "1724803200042", "emojis": ["👀"]}}
    {"method": "message", "id": "a-1724803200042", "params": {"room_id": "general", "reply_to": {"message_id": "1724803200042"}, "body": {"text": "Rain tomorrow, 14°C."}}}
    ```

    - It saves a connection, and the 30 seconds bound what it costs the
      server.
    - The bot does its work before it answers, within the 30 seconds.
    - The server sends no results. So the bot cannot learn whether a post
      worked, as Telegram warns. A frame that fails, or that the call's
      `token` does not allow, sets the webhook's `error`.
    - The server deduplicates the frames as any request. So a retried call
      that gets the same answer posts once.
    - Server: limit how many frames one response runs, such as 10.
13. A bot that needs more connects back for a short time: for example
    `auth`, then `history` for the thread or the message that was replied
    to, then `message`, then close
    ([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)).
    - The call's `token` signs in as the bot until `token_expires`. So the
      bot needs no long-lived token of its own. The call's token replaces
      none of the bot's long-lived tokens.
    - The `auth` result has no new `token`, and the server can close the
      connection after `token_expires`. So connect back soon after the
      call.
    - Server: tokens are opaque ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)),
      so the call's token can be a signed token with an expiry and a prefix,
      and need no storage.
    - Server: let the call's token sign in for 15 minutes, and only post,
      react, show typing, and read `history` in the bot's rooms. Discord's
      interaction token (15 minutes, follow-ups only) and Slack's
      `response_url` (30 minutes, 5 uses) are similar. A server can revoke
      it earlier, such as when the bot gets a new bearer token.
    - Cloudflare server: a bot that connects for each call opens many
      connections in a busy room. The server allows 8 signed-in connections
      for each account, and the newest signs out the oldest. It also admits
      30 connections a minute for each address. A Worker's address is its
      zone, so all the Workers in one account share it, as in
      `<account>.workers.dev`. Answer in the response where the bot can, or
      send through one connection, such as in a Durable Object
      ([question 3](#open-questions)).
14. The bot catches up when it missed a call.
    - Remember where the last call ended: its `last_log_id`, or its
      `latest_log_id` for a knock. A call that carries only `joined` or
      `left` does not move it.
    - `since` is where the previous call ended. When it is absent, or is not
      where the bot last read, read `history` from there
      ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)). A gap in
      `log_id`s cannot show a missed call, because `log_id`s are one
      sequence for the whole server ([§2.1](../PROTOCOL.md#21-log_id)).
    - In a catch-up, pick out the messages that are meant for the bot, as a
      daemon does (step 2).
    - Apron bots can read history, unlike Telegram bots. So a server can
      give up on a call, and needs no long queue for each bot, as Telegram
      keeps for 24 hours.
    - Server: keep `since` in memory if that is simpler, and leave it out
      after a restart. The bot then catches up.

## Open questions

Delivery:

1. **Mentions outside the bot's rooms.** A webhook bot gets a mention in a
   public room that it has not joined, through `mentions`. A daemon gets no
   broadcast from that room. `history` with no `room_id` covers only joined
   rooms, so no catch-up finds the mention. How does a bot learn of one that
   it missed? Telegram's Guest Mode delivers such a mention, and lets the bot
   answer once, with no history.
2. **Watching without joining.** Can a daemon read every public room
   without joining each one? Joining lists the bot as a member of every
   room, and it misses rooms made after it last joined.
3. **Many calls at once.** A webhook bot that connects for each call opens
   many connections in a busy room (step 13). [Issue #139] tells bots to
   hold one connection, ever. Do bots send through one connection, or does
   question 4 answer this?
4. **Posting over HTTP.** Is there a plain HTTP endpoint for posting later,
   for bots that cannot open a WebSocket? Discord's interaction token posts
   follow-ups for 15 minutes.

Operations:

5. **Test calls.** Can the owner send a test call, or call again for a
   message, as GitHub's redelivery does? [Issue #139] asks bots to prove
   each change against a live server.
6. **Failures that people see.** Who hears that a call, or a frame in a
   response, failed: the asker, the owner, or both? Zulip posts "Failure!
   Bot is unavailable" in the conversation, and sends the owner a direct
   message with the status and the response.
7. **Bot state.** Where does a serverless bot keep its place, its
   `endpoint_id`, and the rooms that it greeted? Cloudflare's KV is
   eventually consistent; a Durable Object is not. Zulip keeps up to
   10,000,000 characters of key and value storage for each bot on the
   server. Does an Apron server offer this?
8. **Unregistering everything.** Can a client remove all the registrations
   that it made without remembering each `url`, or all those that its
   credential made? Mastodon ties a subscription to its access token.

Beyond messages, popular on other platforms:

9. **Following a conversation.** After a mention, does the bot get the
   follow-ups in that thread without another mention? Slack's assistant
   threads and Discord's threads work this way, and LLM bots depend on it.
   Apron's threads are rooms
   ([§4.2.4](../PROTOCOL.md#424-creating-and-editing)), so the bot could
   join the thread.
10. **Bot commands.** Can a bot offer its own commands, such as `/weather`,
    that [`ext:command_list`](../extensions/ext_command_list.md) lists, and
    that reach the bot as a call? Telegram, Discord, and Slack all do this,
    and Discord and Slack also offer commands on one message. An Apron
    command can already carry `reply_to`
    ([§4.1](../PROTOCOL.md#41-command)). Today only the server defines
    commands.
11. **Buttons.** Can a bot offer choices, whose choice calls the bot, as
    Telegram's inline keyboards, Discord's components, and Slack's Block Kit
    do? Apron's `actions` embed
    ([Appendix C.3](../PROTOCOL.md#c3-actions-embed)) is under
    consideration, and only servers set it. Zulip's button makes a click
    send an ordinary message that mentions the bot. Is that enough?
12. **Private replies.** Can a bot answer only the user who asked, as Slack,
    Discord, and Telegram allow? Apron's `~private` notices
    ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices))
    go to one connection, and only the server sends them.
13. **Stopping a long answer.** Can a user stop a bot's long answer?
    Telegram streams drafts, and tells the bot when the user presses Stop.
    Slack shows a status such as "is thinking…". Apron streams with `embed:append`
    ([§4.8.5](../PROTOCOL.md#485-embedappend)), and shows typing, but has no
    stop signal.
14. **Incoming webhooks.** Can a script post to a room with one HTTP POST to
    a secret URL, with no bot code and no WebSocket? Discord, Slack, Zulip,
    and Mattermost all offer this, mostly for alerts from CI and monitoring.
15. **Finding and adding bots.** How do people find a bot, and add it to
    their rooms or talk to it alone? Discord has an app directory and invite
    links with permissions, Slack asks for scopes at install, and Telegram
    opens a chat from a link. On the Cloudflare server, an owner adds their
    own bot, and members of a private room can add anyone to it.

## Research notes: prior art

From the official documentation, November 2026. This section goes away when
the recipe is done.

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

- **No server-side filter for bots.** The server does not filter other
  bots' messages. Each bot guards against loops itself. A server can still
  limit calls between bots, as policy.
- **Roles give no permissions.** `roles` are labels
  ([§3.3.4](../PROTOCOL.md#334-roles)). A bot that obeys only some users
  enforces that rule itself. The server still decides what the bot may do.
- **Rooms that the bot has not joined.** A daemon misses mentions there,
  and no catch-up finds a missed one ([question 1](#open-questions)).
- **No streaming without a connection.** An `append` embed's `write_url`
  comes in the `message` result
  ([§4.8.3](../PROTOCOL.md#483-writes)), and frames in a response get no
  results. A bot that streams connects, posts, and then writes to the
  `write_url`.
- **No delivery queue.** A server gives up on a call after a few retries.
  The bot recovers with `history`, which covers only the rooms that it
  joined.
- **Connections on Cloudflare.** The Cloudflare server limits connections
  for each account and for each address (steps 4 and 13). So a bot that
  connects for each call can run out of them in a busy room.
- **Owner controls.** Pausing, seeing, and removing a webhook for its owner
  are server commands, which differ from server to server.

[issue #139]: https://github.com/shazow/apron/issues/139
[Issue #139]: https://github.com/shazow/apron/issues/139
