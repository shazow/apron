# Bots

**Status**: Draft. Requirements only, while we research the server API and a
reference bot client.

**Can a bot stay offline until a message needs it?** Not yet. A bot today
either holds a connection open, or posts and leaves
([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)).
This recipe will describe a third way: the server calls the bot's webhook
when a message comes, and the bot connects only to answer.

## Requirements

These are the requirements that we are working from. They will become the
steps of `## How it works`. [Prior art](#prior-art) says where each idea
comes from.

### Kinds of bot

The recipe serves three kinds of bot:

1. **Always connected.** A long-running process holds a connection and gets
   every broadcast. This works today.
2. **Woken by a message.** A serverless bot, such as a Cloudflare Worker, an
   AWS Lambda function, or a Cloud Run service, runs only when the server
   calls its webhook. This is the kind that the recipe adds.
3. **Fire and forget.** A deploy hook or a cron job posts and disconnects
   ([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)).
   This works today.

A bot of kind 2 should cost nothing while it waits. A connection that stays
open has a cost. A bot that runs in a Cloudflare Durable Object, for example,
stays awake for as long as its own WebSocket client is open, because only
WebSockets that the object accepts can hibernate.

### Server: identity and credentials

- An owner gets a bearer token for a bot
  ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)), and the bot has the role
  `bot` ([§3.3.4](../PROTOCOL.md#334-roles)).
- The token signs in from any origin.
- A new token does not drop the bot's webhook. A webhook change does not
  rotate the token.

### Server: what calls the webhook

- By default, the server calls the webhook for messages meant for the bot:
  - messages that mention the bot ([§3.5.5](../PROTOCOL.md#355-mentions));
  - replies to the bot's messages ([§3.5.4](../PROTOCOL.md#354-references));
  - every message in a private room that the bot joined.
- The owner can opt in to every new message in the rooms that the bot
  joined. Every platform that we looked at makes the full stream an opt-in.
- A mention is a user in `body.mentions`. Servers never parse `text` for
  mentions ([§3.5.5](../PROTOCOL.md#355-mentions)). So a bot that also wants
  `@user_id` in text, as [issue #139] suggests, opts in to every message.
- To start, only new messages call the webhook
  ([Q2](#open-questions)).
- The server does not coalesce calls, wait first, or check whether the bot
  is attended, as it does for push to a person
  ([§4.9.4](../PROTOCOL.md#494-wake)).
- The server skips a bot that has a live connection, since the bot already
  gets the broadcast ([Q4](#open-questions)).

### Server: what a call carries

- The body is a versioned envelope. It holds the same `message` notification
  that the bot would get on a connection: the whole message, with `log_id`,
  not cut down to fit a push ([§4.9.3](../PROTOCOL.md#493-payload)). One
  handler then serves kinds 1 and 2.
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
  replied to, so the bot does not have to remember the IDs of its own
  messages, as [issue #139] asks bots on a connection to do.
- The envelope carries the sender's `roles`
  ([§3.3.4](../PROTOCOL.md#334-roles)), so that the bot can check who may
  ask for what without a `room_list`.
- The envelope says how many times the server tried the call, and when the
  message came. A bot then knows when the moment has passed, such as for an
  instant reaction.
- After the server skips calls for a limit, the next call says how many it
  skipped, as Slack's `app_rate_limited` does.

### Server: signing and verifying

- The server signs each call. The signature covers a timestamp, the bot's
  `user_id`, and the raw body, so that a call cannot be replayed later or to
  another bot.
- The signature scheme is open ([Q5](#open-questions)).
- Before the server turns a webhook on, the URL proves that it answers for
  the bot, such as by echoing a challenge. This also stops an owner from
  aiming the server at a URL that is not a bot.

### Server: acknowledgement and failure

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
- The server turns off a webhook that answers 404 or 410, or that fails most
  calls for an hour, and tells the owner. Slack's rule is more than 95% of
  calls in 60 minutes, and only for apps with at least 1,000 calls an hour.
- The owner can see the webhook's state: when it last failed and why, and
  how many calls it skipped. Telegram's `getWebhookInfo` does this.
- The owner can pause the webhook and turn it on again without losing its
  settings. This is the kill switch that [issue #139] asks for.
- The owner can send a test call ([Q12](#open-questions)).

### Server: bounds

- A bot's own messages, and other bots' messages, do not call webhooks, so
  that two bots cannot call each other forever. Telegram and Teams do the
  same by default ([Q7](#open-questions)).
- The server limits calls for each bot and for the whole server, each day.
- Choosing whom to call costs no storage reads in the common case.
- The webhook URL is a public `https` URL, as for push endpoints
  ([§4.9.1](../PROTOCOL.md#491-registration)).

### Server: configuration and lifecycle

- The owner sets the webhook when the bot is made, and changes or removes it
  later. On the Cloudflare server this could be `/invite-bot [url]`, and a
  separate `/bot-webhook <url>` and `/bot-webhook off`.
- The owner chooses what calls the webhook: messages meant for the bot, or
  every message.
- Whether the bot can also set its own webhook is open
  ([Q8](#open-questions)).
- Rules that sign out idle bots, or drop push registrations that are not
  renewed, must not drop a bot that is woken rarely. Otherwise the recipe
  tells bots to sign in on a schedule.

### Server: answering

- A bot that was woken answers on a short connection: `auth` and `message`
  together, then close
  ([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)).
- The bot can read the context that it needs, such as a thread or the
  message that was replied to, with `history`, in the same connection.
- The server deduplicates requests by `user_id` and `id`
  ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)), for 24 hours on
  the Cloudflare server. A bot that takes its `id` from the message that it
  answers posts once, even with no state of its own.
- Other ways to answer are open ([Q9](#open-questions),
  [Q10](#open-questions), [Q11](#open-questions)).

### Bot client

- Check the signature and the timestamp, then answer `202` at once. Do the
  work after the answer, such as with `waitUntil` or a queue.
- Drop a call whose delivery ID it has seen.
- React at once to a call on its first try, such as with 👀, as [issue #139]
  suggests. Skip it on a retry or a catch-up.
- Remember the last sequence number. On a gap or a new epoch, catch up with
  `history` in the rooms where it matters.
- Use one handler for a `message` from the webhook and one from a
  connection.
- Ignore its own messages and, by default, other bots' messages.
- Answer with an `id` that comes from the message that it answers, so that a
  retry posts once ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)).
- Reply in the same thread, with `reply_to` where it fits
  ([§3.5.4](../PROTOCOL.md#354-references)).
- Wait for `retry_after` when the server asks for it.
- Sign in on a schedule, if the server signs out idle bots.
- Keep the token in one place, and remove token-like strings from what it
  sends, as [issue #139] suggests.
- [Issue #139] has a longer checklist for bots on a connection. Most of it
  holds for bots woken by a webhook too.

### Reference implementation

- A template bot for one serverless platform, to start with Cloudflare
  Workers.
- Support for webhooks in the Cloudflare server (apron-server-cloudflare).
- Where a serverless bot keeps its state ([Q14](#open-questions)).

## Open questions

Delivery:

1. **Mentions outside the bot's rooms.** Does a mention in a room that the
   bot has not joined call the webhook? Telegram's Guest Mode delivers it,
   and lets the bot answer once, with no history. A bot's catch-up with
   `history` and no `room_id` covers only the rooms that it joined
   ([§4.3](../PROTOCOL.md#43-history)), so it would miss these.
2. **Other events.** Do edits, deletions, reactions, and membership changes
   call the webhook? A call when an owner adds the bot to a room would let
   it greet once, as [issue #139] asks.
3. **Bursts.** Does the server send a burst as one call with several
   notifications, as Matrix and Meta do? It would cut requests from a busy
   room without dropping any.
4. **Connected bots.** Does the server call the webhook while the bot has a
   live connection?

Trust:

5. **Signatures.** HMAC-SHA256 with a secret for each bot, as Slack and
   GitHub use, or Ed25519 with one public key for the server, as Discord
   uses? With Ed25519, the server keeps no secret for each bot, and can
   publish its key. The bot then holds no second secret next to its token,
   which [issue #139] asks for.
6. **Retries.** How long does the server keep trying? Each retry later than
   a moment costs the server a scheduled wake.
7. **Bot to bot.** Can an owner opt in to calls for other bots' messages?
   Telegram allows it since 2026, and asks bots to guard against loops.
8. **Who sets the webhook.** Can the bot set its own webhook over the
   protocol? If so, this becomes an extension, not server policy.

Answering:

9. **Answers in the response.** Can the bot answer in the webhook's HTTP
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
