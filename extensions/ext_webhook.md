# `ext:webhook`

Adds webhooks: the server sends an account the records that concern it, in
HTTPS calls to a URL that the account sets. So an account, such as a bot or a
federation link, needs no connection open while it waits. Calls follow
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
This extension is a draft, from the
[bots recipe](https://github.com/shazow/apron/blob/main/recipes/bot.md). It
can still change.

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
{
  "id": "c1", "result": {
    "url": "https://bot.example/apron", "wake": ["mentions", "replies", "private"], "format": "full",
    "endpoint_id": "wh_4f2kQ9xT", "state": "verifying"
  }
}
```

A call, after Alice replies to the bot:

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
    "token": "apron_webhook_…", "token_expires": "1724804101000",
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

The bot's answer, in the response:

```http
HTTP/1.1 200 OK
Content-Type: application/jsonl

{"method": "reactions", "id": "r-1724803200042", "params": {"message_id": "1724803200042", "emojis": ["👀"]}}
{"method": "message", "id": "a-1724803200042", "params": {"room_id": "general", "reply_to": {"message_id": "1724803200042"}, "body": {"text": "Rain tomorrow, 14°C."}}}
```

```ts
class WebhookServer {           // server.ext.webhook
  keys: string[];               // the server's Ed25519 public keys, "whpk_" and base64
  wake: string[];               // the scopes that the server implements
  format?: string[] = ["full"]; // the formats that the server sends: "full", "knock"
}

class Webhook {                 // ext:webhook params and result
  url?: string;                 // the https URL to call; "" removes the webhook
  wake?: string[];              // default ["mentions", "replies", "private"]
  format?: string = "full";     // "full" or "knock"
  paused?: boolean = false;
  endpoint_id?: string;         // result only: the endpoint ID for signatures
  state?: string;               // result only: "verifying", "on", "paused", or "failing"
  error?: string;               // result only: why the last call or frame failed
}

class Call {                    // ext:webhook notification params: the body of a call
  // the call
  server: string;               // the server's address (§1)
  you: User;                    // the account, as `you` after auth (§3.2)
  attempt: number;              // 1, then 2 and up on each retry
  since?: string;               // last_log_id or latest_log_id of the previous call
  first_log_id?: string;        // the bounds of the records that matched, as in history (§4.3)
  last_log_id?: string;
  latest_log_id?: string;       // "knock" only: the newest record that matched
  token?: string;               // a bearer token that signs in as the account (§3.2.1)
  token_expires?: string;       // when token stops working, in the format of a log_id (§2.1)
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

## Setting the webhook

- `ext:webhook` sets the webhook of the authenticated account, and returns
  the whole setting as it is now.
- An account has at most one webhook. Params merge into it as into a user
  object ([§3.3.1](../PROTOCOL.md#331-user-objects)), so `{}` returns the
  setting unchanged.
- `"url": ""` removes the webhook.
- Servers MAY refuse to set a webhook with `denied`, such as for an account
  that is not a bot or a link.
- `url` MUST be an `https` URL. Servers SHOULD accept only URLs that resolve
  to addresses that are not internal, as for push endpoints
  ([§4.9.1](../PROTOCOL.md#491-registration)). Another URL is
  `invalid_params`.
- A webhook stays until the account removes it, or the server turns it off.
  It does not lapse while the account stays away. A new bearer token for the
  account does not remove it.
- `paused: true` stops calls. The setting stays.
- The server sets a new `endpoint_id` whenever `url` changes. It is unique
  among the server's webhooks, and has no `.`.

## Verifying

- When `url` changes, the server MUST verify the URL with Standard
  Webhooks' endpoint verification before it sends a call. The request
  carries a `webhook-challenge` header, and the URL answers with
  `webhook-challenge-response`.
- `state` is `"verifying"` until the URL answers correctly. It is then
  `"on"`.
- When verification fails, `state` is `"failing"`, `error` says why, and the
  server sends no calls.
- A server MAY instead verify a link's URL by its host: the host of the
  server that the link is bound to, as in
  [trusted federation](https://github.com/shazow/apron/blob/main/recipes/trusted_federation.md).

## What calls the webhook

- `wake` lists the scopes that call the webhook, from those that
  `server.ext.webhook.wake` lists. The server ignores the others. `[]` calls
  for nothing.
- `mentions`, `replies`, and `private` match new messages as for push
  ([§4.9.4](../PROTOCOL.md#494-wake)), with the account as the user.
- A message from a user with the role `bot`
  ([§3.3.4](../PROTOCOL.md#334-roles)) matches none of `mentions`,
  `replies`, and `private`.
- `joined` matches every record of the rooms that the account joined:
  messages and their changes, reactions, memberships, and room records.
- Of the account's own records, only those that `joined` matches call the
  webhook.
- Changes to the account's own rooms (`joined` and `left` in the call) call
  the webhook under every scope.
- The server does not wait, coalesce, or check status or mutes before a
  call, unlike push.
- Servers SHOULD NOT send a call while the account has a connection open,
  since the connection receives the records.

## Calls

- A call is a POST of one `ext:webhook` notification
  ([§1](../PROTOCOL.md#1-transport--framing)), as `application/json`.
- `params` are flat. Each field holds one kind of payload, under the name
  that `history` ([§4.3](../PROTOCOL.md#43-history)) or `room_update`
  ([§4.2.3](../PROTOCOL.md#423-updates)) gives it.
- `server` and `you` refer to the server that sends the call and the account
  that it is for. So one URL can serve several servers and accounts.
- `you` carries the account's current profile and `roles`, as a `user` `you`
  notification would ([§3.3.3](../PROTOCOL.md#333-changes)).
- With `format` `"full"`, a call carries the records that matched, in
  `log_id` order. One call MAY carry several.
- `wake` lists each new message that matched, with its scopes. Bots answer
  only the messages in `wake`.
- `left` also covers a room that the account lost without a membership
  record.
- A call also carries the `rooms` and `users` that its records refer to.
- A message's `reply_to` is the full snapshot of the message that it
  replies to ([§3.5.4](../PROTOCOL.md#354-references)).
- A call carries only records that the account may see.
- The account applies every record in a call as any record
  ([§2.3](../PROTOCOL.md#23-records-and-replay)).
- With `format` `"knock"`, a call carries no records, and `latest_log_id` is
  the newest record that matched. One knock covers every record that
  committed before the server sent it. A record after it gets another knock.
- `since` is the `last_log_id`, or the `latest_log_id`, of the previous call
  to this webhook. The server leaves it out when it does not know it.
- When `since` is absent, or is not where the account last read to, the
  account reads `history` from where it last read
  ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)).
- To fit its limits, the server first sends `reply_to` bare. It then leaves
  out the other `rooms` and `users` that only help read the call. It then
  splits the records over several calls.
- `token` (optional) is a bearer token that signs in as the account
  ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)). The server chooses its
  lifetime and what it allows, such as 15 minutes of posting, reacting,
  typing, and `history` in the account's rooms.
- `token_expires` is present with `token`. It is the time when the token
  stops working, in the format of a `log_id`
  ([§2.1](../PROTOCOL.md#21-log_id)). The token MAY stop working earlier,
  such as when the account gets a new bearer token.
- `skipped` counts the calls that the server left out for a limit since the
  previous call.

## Signatures

- The server signs each call and each verification request with Standard
  Webhooks' asymmetric scheme `v2a` (Ed25519), with its headers
  `webhook-id`, `webhook-timestamp`, and `webhook-signature`.
- `webhook-id` identifies the call. It is the same on each retry, and has no
  `.`.
- The endpoint ID of the signature is the webhook's `endpoint_id`.
- `keys` lists the public keys that the server signs with. While a key
  changes, a call carries a signature from each key.
- Accounts SHOULD trust only the `keys` of the server that `server` refers
  to.
- Accounts SHOULD refuse a call whose `webhook-timestamp` is more than 5
  minutes from their clock.
- Accounts SHOULD drop a call whose `webhook-id` they have seen.

## Responses

- The URL answers 2xx within 30 seconds. Anything else is a failure, and so
  is no answer within 30 seconds.
- An empty 2xx acknowledges the call.
- The body of a 2xx MAY be request frames, one a line, as on a byte-stream
  transport ([§1](../PROTOCOL.md#1-transport--framing)).
- The server runs those frames in order as the account, with what `token`
  allows, and sends no results.
- The server deduplicates the frames as any request
  ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)).
- The server MAY limit how many frames it runs. A frame that fails sets
  `error`.

## Failures

- The server retries a call that timed out, could not connect, or got 429 or
  5xx, a few times, with the same `webhook-id` and the next `attempt`.
- The server honors `Retry-After`.
- The server does not retry a call that got 3xx or another 4xx. It does not
  follow redirects.
- A 410 removes the webhook.
- After calls fail for a time that the server chooses, `state` is
  `"failing"`. The server MAY stop calling until the account sets the
  webhook again.

Without the extension, an account holds a connection to receive records, or
connects on its own schedule. A server without it replies `unsupported` to
`ext:webhook` ([§1](../PROTOCOL.md#1-transport--framing)).

## References

- [Standard Webhooks 1.0](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
  and its [endpoint verification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/extensions/endpoint-verification.md)
  extension
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032): Ed25519
