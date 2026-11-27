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
steps of `## How it works`.

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

### Server: delivery

- The server sends an HTTPS POST to a webhook URL that the owner sets.
- It calls the webhook for every new message in the rooms that the bot
  joined. Open question: also for mentions of the bot in other rooms.
- Each call carries the same `message` notification that the bot would get
  on a connection: the whole message, with `log_id`, not cut down to fit a
  push ([§4.9.3](../PROTOCOL.md#493-payload)). One handler then serves
  kinds 1 and 2.
- The server does not coalesce calls, wait first, or check whether the bot
  is attended, as it does for push to a person
  ([§4.9.4](../PROTOCOL.md#494-wake)).
- The server skips a bot that has a live connection, since the bot already
  gets the broadcast. Open question: call the webhook anyway.
- The server signs each call, such as with an HMAC of a timestamp and the
  body, so that the bot can check where the call came from and refuse a
  replay.
- A call is sent once and not retried. The bot finds a lost call by a gap in
  `log_id`, and catches up with `history`
  ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)).
- The server waits a short time for an answer. A slow bot must not keep the
  server busy.
- The server turns off a webhook that answers 404 or 410, or that fails many
  times in a row, and tells the owner.

### Server: bounds

- A bot's own messages, and other bots' messages, do not call webhooks, so
  that two bots cannot call each other forever. Open question: allow it
  with a loop guard.
- The server limits calls for each bot and for the whole server, each day.
- Choosing whom to call costs no storage reads in the common case.
- The webhook URL is a public `https` URL, as for push endpoints
  ([§4.9.1](../PROTOCOL.md#491-registration)).

### Server: configuration and lifecycle

- The owner sets the webhook when the bot is made, and changes or removes it
  later. On the Cloudflare server this could be `/invite-bot [url]`, and a
  separate `/bot-webhook <url>` and `/bot-webhook off`.
- Open question: whether the bot can also set its own webhook over the
  protocol, and so whether this becomes an extension or stays server policy.
- Rules that sign out idle bots, or drop push registrations that are not
  renewed, must not drop a bot that is woken rarely. Otherwise the recipe
  tells bots to sign in on a schedule.

### Server: answering

- A bot that was woken answers on a short connection: `auth` and `message`
  together, then close
  ([Appendix B.2](../PROTOCOL.md#b2-a-bot-connects-posts-once-and-disconnects)).
- The bot can read the context that it needs, such as a thread or the
  message that was replied to, with `history`, in the same connection.
- The answer does not go in the webhook's HTTP response. Waiting for the bot
  would keep the server busy for as long as the bot takes, which for an LLM
  can be many seconds.
- Open question: a plain HTTP endpoint for posting, for bots that cannot
  open a WebSocket.

### Bot client

- Check the signature and the timestamp, then answer `202` at once. Do the
  work after the answer, such as with `waitUntil` or a queue.
- Use one handler for a `message` from the webhook and one from a
  connection.
- Ignore its own messages and, by default, other bots' messages.
- Remember the last `log_id` for each room. On a gap, catch up with
  `history`.
- Answer with an `id` that comes from the message that it answers, so that a
  retry posts once ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)).
- Reply in the same thread, with `reply_to` where it fits
  ([§3.5.4](../PROTOCOL.md#354-references)).
- Wait for `retry_after` when the server asks for it.
- Sign in on a schedule, if the server signs out idle bots.

### Reference implementation

- A template bot for one serverless platform, to start with Cloudflare
  Workers.
- Support for webhooks in the Cloudflare server (apron-server-cloudflare).

## Limits

To be written.
