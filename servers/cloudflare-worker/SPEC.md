# Apron public demo server on Cloudflare Workers

Date: 2026-09-20
Status: Implementation specification
Target: https://github.com/shazow/apron
Protocol: https://github.com/shazow/apron/blob/main/PROTOCOL.md
Protocol reference reviewed: protocol version 6, the repository's `PROTOCOL.md`.

## 1. Objective and instructions to the coding harness

Build a usable, publicly accessible Apron demo backend using native Cloudflare Workers, one SQLite-backed Durable Object (DO), and hibernating WebSockets. Support guest use and passkey authentication, bounded posting and history, and graceful resource exhaustion. The demo must run on the actual Workers Free plan without enabling paid services.

Read the repository's `AGENTS.md`, existing code, package-manager configuration, and `PROTOCOL.md` before implementing. Reuse existing client/protocol utilities where appropriate. Compare the current protocol with the reference above; preserve its mandatory behavior and document material differences. This specification defines deployment policies within the base chat protocol.

Implement the backend, the minimal Apron client changes required for passkeys and rolling-history recovery, tests, configuration, and operating documentation. Keep unrelated frontend work out of scope. If the frontend is in another repository, provide a concrete patch/adapter and integration instructions rather than silently omitting the client requirements. Prepare a deployable result; do not deploy, switch billing plans, or create paid resources merely to complete this implementation task.

Use MUST for required behavior and SHOULD for preferences. Centralize all limits in validated configuration with the defaults below. Do not silently increase limits to make tests pass.

### Required capabilities

- Protocol v6 core: server announcement with liveness `ping`, authentication that finishes before any later frame on its connection, the default room, creation and delivery of flat message snapshots to the rooms' members (the sender's broadcast before its result), framing, errors, one server-wide log ID sequence.
- `history`: complete record snapshots of every kind (room records, message snapshots, reaction sets, registered users' memberships), correct pagination and live/recovery ordering per room.
- `edit`: owner-authorized replacement, deletion, restoration, and moves between rooms of retained messages.
- `rooms`: rooms by request (`room_list`, `room_update`); thread rooms (rooms with `parent_room_id`) created and edited by participants with `room_set`; `room_join`/`room_leave` for `general` and threads, with deliveries only to joined rooms (a thread's messages to its members only). Registered users' joins and leaves are logged `membership` records; guests' are not (section 4). The permanent `general` room is the only top-level room.
- `reactions`: per-user emoji sets on messages.
- `activity`: implemented but off by default (`ACTIVITY=true` advertises it): typing only, relayed to the room's members and never stored, at most 10 relays per user per minute (section 4.2). Read cursors are neither kept nor relayed; `away` is accepted and ignored (there is no push).
- `room_list`: joined rooms and rooms to join, by the protocol's `filter`, with `members` and `users` on request.
- `command`: `/help`, answered with a `@private` notice, and `/invite-bot` for registered users (section 5, Bots).
- Guest authentication (`guest`), read-only unless `GUEST_POSTING=true`; verified WebAuthn registration/login; bot tokens (`token`).
- Persistent request deduplication for mutating operations.
- Rolling 24-hour history with hourly cleanup, using the same room ID indefinitely.
- Base-protocol history availability boundaries and client recovery support.
- Enforced application budgets, including cleanup, auth, and quota bookkeeping.

### Non-goals

No public workspace creation, top-level room creation, federation, multiplexing proxy, presence service, read cursors, avatars, uploads (`embed:upload`, `/avatar`), streams (`embed:stream`), R2, push, email, external URL previews, outbound bots, RTC, arbitrary search, FTS, or third-party analytics. Do not advertise unsupported capabilities. Passkeys do not establish one-human-one-account or solve Sybil resistance.

## 2. User scenarios

1. A visitor opens the public demo, connects, authenticates as a guest, and reads recent history without signup; posting, reacting, and starting threads take a passkey sign-in.
2. Several anonymous tabs behind one IP share the five-posts-per-minute allowance; opening another socket does not reset it.
3. A visitor creates a passkey or signs in with one. Successful authentication grants the registered allowance of twenty posts per minute, subject to IP and global limits.
4. A user reconnects after losing a mutation reply. A retry with the same request ID and authenticated identity returns the original result without another mutation or broadcast.
5. A connected client watches a room while another client loads history. Neither misses entries at the history/live boundary.
6. A user returns after more than a day. The client notices the retention boundary, clears stale recovery state, and rebuilds the available room view.
7. An old message edited within the retained window remains recoverable from its complete recent snapshot even after its creation record is purged.
8. A bot floods requests or creates identities. Per-principal controls and global budgets reject work without unbounded database, memory, or object creation.
9. A resource budget runs out. Posting, history, registration, or admission becomes unavailable as appropriate; accepted messages remain recoverable while resources permit.
10. The object hibernates, wakes, restarts, or is redeployed. Identity, room sequencing, retention boundaries, quotas, and deduplication remain correct; clients can reconnect when necessary.

## 3. Deployment and architecture

Use TypeScript, Wrangler, the native `DurableObject` base class from `cloudflare:workers`, and embedded SQLite. Follow the repository's tooling; pin resolved dependencies and a tested compatibility date. Prefer a small dependency surface and a maintained Workers-compatible WebAuthn verifier instead of handwritten cryptographic verification.

| Component | Responsibility |
| --- | --- |
| Entry Worker | Validate `/` and `/ws` upgrade requests, configured guest origin policy, route/method/body bounds, derive trusted IP metadata, apply cheap preliminary admission controls, forward to the fixed DO |
| `ApronDemoServer` DO | Own sockets, authenticate, authorize, sequence protocol operations, enforce budgets, persist state, serve history, broadcast, run cleanup |
| Embedded SQLite | Authoritative room records, the server-wide record log, current message and reaction state, credentials, deduplication, budgets, rate-limit state, maintenance progress |
| Existing Apron frontend | Guest access, passkey UI, retry/backoff, retention-aware recovery and concise demo status |

Exactly one production object is reachable, e.g. `env.DEMO.getByName("public-demo-v1")`. Never derive its name from an untrusted URL, room, user, or query parameter. There is one permanent room, `general`, displayed as General. Room IDs and the last log ID do not reset on cleanup or at midnight.

Use `new_sqlite_classes` for the initial Wrangler migration. Do not add D1, Workers KV, Queues, or a separate quota DO. Test/staging namespaces count toward account usage if deployed; do not assume an independent free allowance.

Return cheap 404/405 responses for unrelated routes without invoking the DO. Serve the UI as static assets where the repository supports it. No polling endpoint may issue unbounded DO calls. Administrative metrics, if exposed, require authenticated operator access and contain aggregates only.

Cloudflare recommends the hibernation API for WebSocket servers: [WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

### Socket lifecycle

- Accept with `ctx.acceptWebSocket(server)`, not `server.accept()`.
- Implement `webSocketMessage`, `webSocketClose`, and `webSocketError`.
- Immediately send the protocol `server` announcement, before authentication.
- Store a versioned, bounded attachment containing connection ID, trusted IP key, auth identity/tier, pending challenge metadata, and any connection-local limiter leases. Re-serialize after changes.
- Keep attachments comfortably below the platform's 16 KiB maximum; do not put message history or credentials into them.
- Reconstruct connection indexes through `ctx.getWebSockets()` and attachments after hibernation. Check socket state before sending. Reconstructed indexes are caches, never durable authority.
- Do not re-send initial announcements or repeat auth just because the constructor runs after hibernation. Actual reconnects authenticate again.
- The runtime cannot send WebSocket pings, so a peer that vanishes without a close frame (sleep, a network change) would stay connected until the edge gives up on it. The server frame advertises protocol liveness instead (`server.ping`, 45 seconds, [PROTOCOL.md §1](../../PROTOCOL.md#1-transport--framing)): clients send the frame `{"method":"ping"}`, byte for byte, at that interval, and `setWebSocketAutoResponse` answers `{"method":"pong"}` without waking the object, before authentication too, so it spends no frame budget. A `ping` notification with other spacing reaches the handler and is answered there, as an ordinary frame. A connection that has pinged and then sent neither a ping nor any frame for `ping_timeout_seconds` (150) is stale: it is closed with 1001 before `members` are listed and before admission, and does not count against its IP's connection limits. A connection that never pinged is never judged stale. No permanent `setInterval` or `setTimeout`, and no alarm for this.
- Share one DO alarm scheduler between auth deadlines, cleanup, and maintenance retries. Always schedule the earliest outstanding task; cleanup scheduling must not overwrite an earlier auth deadline.
- A closing socket may remain visible to the runtime; do not let it receive broadcasts or grant extra admission while its close is pending.

API reference: [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/).

## 4. Feature and protocol contract

An illustrative initial announcement is:

```json
{"method":"server","params":{"protocol":6,"name":"apron-cloudflare-demo/6","caps":["history","edit","rooms","reactions","command"],"auth":["webauthn","token","guest"],"ping":45,"ext":{"demo":{"retention_seconds":86400,"cleanup_seconds":3600,"max_frame_bytes":16384,"max_message_text_bytes":4096,"max_snapshot_bytes":8192,"guest_posts_per_minute":5,"registered_posts_per_minute":20,"guest_posting":false,"server_frames_per_minute":300,"room_list_per_minute":6,"room_list_members":100,"read_cursors":false}}}}
```

`ext.demo` is additive server-announcement policy metadata in the standard `ext` object. Authentication uses the canonical `webauthn` scheme in protocol [§4.9](../../PROTOCOL.md#49-webauthn-authentication), without an extension flag. Every later `server` announcement is a full replacement, including auth/caps/policy metadata. Temporary throttling does not mean a capability is unimplemented.

History availability is part of the base protocol's `history` capability, with no extension negotiation. Use `latest_log_id` and nullable `history_log_id` in room records (`room_list`, `room_update`) and history results, following protocol [section 3.4](../../PROTOCOL.md#34-rooms) and [§4.1](../../PROTOCOL.md#41-history). Both are per room.

After final authentication, reply with `result.you` (`user_id` and `name` only; the internal quota tier is private). The client lists its joined rooms with `room_list` (`filter: "joined"`), and live delivery for them starts with the auth result. `auth` is a barrier ([PROTOCOL.md §3.2](../../PROTOCOL.md#32-authentication)): each connection's frames are processed one at a time in arrival order, through an in-memory per-connection queue, because the Durable Object runtime delivers further `webSocketMessage` events while a handler awaits (WebAuthn verification, key-value session reads). Requests pipelined behind `auth`, such as `room_list` and `history`, therefore run as the new identity, and are `denied` when the `auth` failed or was a WebAuthn `begin` step. A `user_id` or `name` requested in `auth` is not honored: guests get `guest_<n>` from a server-wide counter, never reissued, and the name `Guest <n>`, and registered identities come from the verified credential or session. Do not send room records to unauthenticated sockets.

### Framing, ordering, and errors

- Accept the minimal and JSON-RPC 2.0 envelopes. One text message contains exactly one object, not a batch array. Reject binary application messages.
- IDs on the wire are strings. Errors not tied to a request (parse errors, invalid envelopes whose `id` cannot be determined) omit `id`.
- Unknown request methods receive `unsupported`; unknown notifications are ignored. Valid notifications never receive result or error replies, but successful mutation notifications still cause broadcasts.
- Ignore unknown envelope fields. Unknown top-level message and room fields are dropped (protocol [section 1](../../PROTOCOL.md#1-transport--framing)); extension data travels in `ext`, which is stored and returned unchanged. Never trust client-supplied `from`; reject client `log_id` on a save.
- Process frames in arrival order per socket, including auth and later pipelined writes. External awaits and WebAuthn verification must not allow overtaking. Bound pending work instead of accumulating unlimited promises.
- Coordinate mutation commit and broadcast scheduling globally within this DO. No live room log ID may be sent after a newer ID on the same connection.
- Notifications a request causes on the requesting connection come before its result ([PROTOCOL.md §1](../../PROTOCOL.md#1-transport--framing)): the sender's `message` and `reactions` broadcasts, the `room_update` and `membership` of `room_join`, `room_leave` and `room_set`, a registration's logged joins before its `auth` result, and a command's `@private` reply.
- Commit durable state before a success becomes externally observable. Use documented storage/output-gate behavior; do not disable it. A failed send to one socket must not roll back an accepted mutation or skip all remaining recipients.
- On an ambiguous post-commit failure, preserve the recorded result and force affected recovery/reconnection rather than continuing a socket with an unexplained gap. Persistent exactly-once mutation effects within the deduplication window do not imply exactly-once network delivery.

| Error | Code | Use |
| --- | ---: | --- |
| parse_error | -32700 | Invalid JSON |
| invalid_request | -32600 | Invalid envelope |
| unsupported | -32601 | Unimplemented request |
| invalid_params | -32602 | Invalid fields, conflicting duplicate, nonexistent/expired message, unknown room or parent room, reaction caps |
| internal_error | -32603 | Unexpected failure, with sanitized text |
| denied | -32001 | Authentication or ownership failure |
| retry_after | -32002 | Temporary resource/rate limit; integer `data.retry_after` in seconds (rounded up, at least 1) |
| too_large | -32003 | Valid identifiable request exceeds a payload policy |

For oversized frames, reject before parsing. If an ID cannot be safely obtained, close with 1009 rather than parsing an arbitrarily large payload just to return an error. Close binary input with 1003 and persistent policy violations with 1008. Use HTTP 429/503 before upgrade where applicable, with an appropriate Retry-After. Do not turn capacity limits into fabricated malformed-request errors.

### Messages, edits, rooms, and reactions

- Every record (room record, message snapshot, reaction set, membership) receives the next `log_id = max(now_ms, last_log_id + 1)` from one server-wide sequence, checked below `2^53`; use integer columns and decimal strings on the wire. A new message's `message_id` equals its creation `log_id`, so it is unique across rooms. Room IDs of threads are their creation `log_id`.
- Maintain `last_log_id` even after the entire log has expired. Clock rollback must not reuse IDs.
- Store each accepted record as a complete authoritative snapshot. Message notifications and history `messages` are the same flat object: `message_id`, `log_id`, `room_id`, `from`, `body`, optional `reply_to` (bare `{message_id}`), `deleted`, and `ext`. `body.format` defaults to `plain`. Deliver to every authenticated connection whose user has joined a room the record belongs to, including the sender's; a record is sent once per connection even when it belongs to two rooms. A thread's records go to the thread's members only; its parent's members receive only its room record, as `room_update` `updated`, when it is created or saved. Every room is visible to every client, so anyone may page any room's history, and posting does not require joining: a poster who has not joined gets only the result.
- Only the original author may replace/delete/restore/move their retained message. Preserve immutable author/ID fields. A save replaces every client field (`room_id`, `body`, `reply_to`, `deleted`, `ext`); it is not a patch/merge. Tombstones omit `body`. A request without `room_id` (a new message or a save) is in the default room, `general`.
- `reply_to` names an existing, retained message other than the message itself, in any room; otherwise `invalid_params`. A save that resubmits its current `reply_to` unchanged is accepted even after the target expires, so old replies stay editable.
- A save with a different `room_id` moves the message: the destination must exist, and the move snapshot belongs to both rooms' logs and history and carries `prev_room_id`, the source room, whose log holds its earlier snapshots. When the message has retained reactions, the same atomic commit then logs one reaction record in the destination carrying every non-empty set.
- Guest authors own messages under their assigned guest identity; passkey authentication does not automatically transfer ownership of earlier guest messages.
- Rooms (cap `rooms`): the public demo permits creating threads only. `room_set` without `room_id` must name an existing top-level `parent_room_id` (`general`); a top-level room request or a nested thread is `denied`, an unknown parent is `invalid_params`. Creating a thread joins its creator: the creator's connections get `room_update` `joined` (the creator as its only member, with `users`), then, for a registered creator, the creator's logged membership, whose `log_id` is already the room's `latest_log_id`; the parent's other members get `updated`; all before the `{room_id}` result. Any participant may save a thread room's client fields (`title`, `intro_message`, `ext`); `general` cannot be edited. A save replaces all client fields except `parent_room_id`, which is fixed; the server supplies the title `Thread` when none is given so clients ignoring `parent_room_id` still render it. A save goes as `room_update` `updated` to the members of the thread and of its parent, and to the saver. `intro_message` is a bare reference to a retained message (unchanged references stay valid) and is sent with its current snapshot embedded. Every room creation and save is a logged record in the room's own log.
- Membership ([PROTOCOL.md §4.3.2](../../PROTOCOL.md#432-membership)): a new guest or registered identity has joined `general`. `room_join` and `room_leave` take a known `room_id` (else `invalid_params`), work for `general` and threads alike, and return `{}` after the notifications they cause. Joining a joined room logs nothing and re-sends `room_update` `joined` to that connection; leaving a room not joined changes nothing. See "Memberships" below for what is logged.
- Allow at most 100 thread rooms, each with at most 2 KiB of serialized client fields. All room creation and saves consume posting and resource budgets. No implicit room creation. A thread room whose entire log (creation record included) has expired is removed at cleanup; its members leave it and are told with `room_update` `left`, releasing its slot; deny further creation while the ceiling is full.
- Reactions (cap `reactions`): a request sets the caller's complete emoji set on one retained message; `[]` clears it and duplicates collapse. Emoji are non-empty strings of at most 64 UTF-8 bytes without control characters, at most 8 distinct per user per message, and at most 32 reacting users per message (calibrated ceilings 16 and 64). A set that equals the current one is accepted without a new record. Non-empty sets on a tombstone are `invalid_params`; clearing is allowed. Each change is a logged record in the message's current room. Reactions are mutations: they share the posting quotas and request deduplication below.
- A new message with empty text and no embeds is neither logged, charged, nor delivered; its result is `{}` (an unknown room is still `invalid_params`). A save that would leave a message empty is `invalid_params` by local policy; delete it instead. Accept plain and Markdown formats. `body.mentions`, when present, is an array of non-empty `user_id` strings (duplicates collapse) stored as sent; the server never reads mentions out of `text`. Limit embeds to four within all byte budgets; store accepted URLs/content without backend fetching or rendering. Unknown embed kinds remain opaque. Client sanitization/sandboxing remains mandatory under the base protocol.
- `me` merges into the profile ([PROTOCOL.md §3.3](../../PROTOCOL.md#33-identity)): a given field replaces its value, an omitted one is unchanged, and an empty one removes it. It changes the display name as a bounded, rate-limited identity operation for registered users; `name: ""` removes it (clients fall back to `user_id`) and is announced as `name: ""`, and guests keep their assigned name (`denied`). The demo keeps no avatars or profile `ext`: `me` type-checks `avatar` and `ext` and then ignores them. No avatar downloads or automatic link previews.
- `user` notifications carry identity changes only ([PROTOCOL.md §3.3](../../PROTOCOL.md#33-identity)). A rename sends `you` to the user's other connections and `new` to the connections of users who share a room with the user. Signing in with a passkey or token on a guest's connection sends `new` with `old` (the retired guest) to those who shared a room with either. Joins and leaves are never `user` notifications. History pages carry no `users`: records keep the user objects they were logged with.
- `command` (cap `command`, [PROTOCOL.md §4.8](../../PROTOCOL.md#48-command)): `/help` answers `{}` and a `@private` notice listing the commands the sender may run, delivered to that connection only, never logged, with no `message_id` or `log_id`. `/invite-bot` (registered users other than bots; others get `denied`) is section 5, Bots. Other commands are `invalid_params` without counting as policy violations. `/help` costs a frame and no SQL beyond a cached room check.
- Message snapshots carry `prev_log_id` when an earlier record for the same key is still stored, and a move's snapshot also `prev_room_id`. Reaction sets and memberships carry neither ([PROTOCOL.md §2](../../PROTOCOL.md#2-identifiers)); room records carry no `prev_log_id` (it is optional). The links are added after the snapshot size check. Deleted messages are not redacted.
- `room_list` (cap `rooms`, [PROTOCOL.md §4.3.1](../../PROTOCOL.md#431-listing)) returns room records with delivery fields in `joined` (the user's rooms, never truncated) and `not_joined` (visible rooms not joined: `general` when left, or with `parent_room_id` that room's threads), each most recently active first. `filter` (`joined`, `not_joined`, or `all`, the default; anything else is `invalid_params`) leaves out the other array, and an array it asks for is present even when empty. It takes `parent_room_id` and `room_id` (one room, in the array its membership selects; unknown is `invalid_params`). With `members: true`, each listed room carries `members`, bare `{user_id}` objects in `user_id` order, and the result `users`, each member's current `{user_id, name}` once, in `user_id` order, present even when empty; without it, neither. `latest_log_id` is validated and ignored (see "Memberships"). It reads the capped room table under the room-listing reservation, and with `members` each room's stored members, and writes nothing. A listing that would pass the 256 KiB response cap sends intro messages as bare references, then leaves out `members` and `users`. Listing unjoined top-level rooms while joined to `general` needs no storage and is not throttled.
- `room_update` `joined` carries the room's record with its `members` and the frame's `users`, as a `members: true` listing does.

### Memberships

The protocol logs every membership change, and lets a server keep some out of the log, such as ephemeral guests' ([PROTOCOL.md §4.3.2](../../PROTOCOL.md#432-membership)). The demo logs what is durable already and keeps the rest out:

- A registered user's membership is stored (the `memberships` table) and each change is a logged `membership` record in the room's log: `{log_id, room_id, members: [{user: {user_id, name}, joined}]}`, one entry, with the user as a recorded object. Logged changes are `room_join`, `room_leave`, the creator's join when a registered user creates a thread, and each starting room of a new registration (the guest's rooms it replaces, or `general`). A record advances the room's `latest_log_id`, is delivered to the room's members before and after the change (so to the joining or leaving user's connections too), before the `room_update`, and is returned in `history`'s `membership` array. The joins and leaves count as posts; an unchanged join or leave writes nothing.
- A guest's memberships live in its connection attachment, like the guest identity, and are not logged: no `membership` record is sent for them and they cost no writes. Logging them would cost a durable write per guest join (every guest joins `general` at `auth`) and per leave of each room when the connection closes, for identities that end with their connection. Clients learn guest members from `room_list` and `room_update`.
- Because guest joins and leaves are not in the log, `room_list` ignores `latest_log_id` and never sends `left`: its result is a full listing, which the protocol lets such a server send. A delta could miss a guest's join or leave.
- `members` lists every connected member, guests included, and the registered members stored with the room in `user_id` order, at most `room_list_members` (100) per room. A room with more registered members lists the first 100 by `user_id` besides those connected: a documented deviation from complete `members`, since the protocol has no paging yet and each listed member costs two indexed reads. Listing all 101 rooms at that cap reads about 20,200 rows (see [cost report](docs/cost-report.md)).
- Retention discards the log prefix older than a day ([PROTOCOL.md §4.1](../../PROTOCOL.md#41-history)), membership records included. The demo does not append the full-member record the protocol asks for before discarding a prefix that holds memberships: member lists cannot be rebuilt from this server's history anyway, since guest memberships are out of the log, so clients start member lists from `room_list` and `room_update`, whose `members` are current. A full-member record would also re-log every registered member of every room each day, a maintenance cost that grows with the identity count. This is a deviation.
- A thread room removed at cleanup leaves the `rooms` table at once, and its members get `room_update` `left`. Its stored memberships are purged in later bounded cleanup batches from a list of removed rooms in `_meta` (at most 100; no further room is removed while it is full); until then membership reads join `rooms`, so they never see them.

### 4.2 Server-wide minute, activity, and per-type throttles

The whole server processes at most `globalFramesPerMinute` (300) frames in a rolling minute, counted in memory after the per-connection gates and parsing but before any SQL. Over it, a request gets `retry_after` with the seconds until the oldest counted frame leaves the window, and a notification or malformed frame is dropped; the socket stays open and nothing is charged. The default is sized for a spike from 50 connected users, 10 of them active: about 20 frames a minute per active user (posts, reactions, edits, history pages, room lookups), about one per quiet user, and a reconnect wave of one auth and one history page each. It is at least one IP's frame minute, so a single client cannot be starved by its own limits. The window is lost on hibernation, when the object has received nothing to count. It shapes spikes; the daily frame and SQL budgets still bound the day.

`activity` is off by default and not advertised; typing then gets the unsupported-method path (notifications are ignored, requests get `unsupported`). With `ACTIVITY=true`: `activity` is a notification. Typing (`typing`, seconds, capped at 30) in a known room (`general` without `room_id`) is relayed to the room's other members' connections as `{room_id, from, typing}` and never stored. `read_message_id` is dropped: the demo keeps no read cursors. `away` is accepted and ignored: the demo sends no push, and `away` is never delivered. An unknown room drops the update; room existence comes from an in-memory cache refilled by listings, room changes, and one bounded lookup per unknown ID.

Some message types have their own per-user rate, counted across the user's connections in a rolling 60-second window whose events live in connection attachments (so they survive hibernation and need no SQL):

| Type | Default per user per minute | Over the limit |
| --- | ---: | --- |
| `activity` (relayed typing) | 10 | Dropped. The sender's connection gets one `@private` notice per window ([PROTOCOL.md Appendix A.1](../../PROTOCOL.md#a1-system-identities-and-scoped-notices)) saying typing is limited |
| `room_list` | 6 | `retry_after` with the seconds until the oldest counted listing leaves the window. The first `filter: "joined"` listing after each authentication is not counted: it is how a client learns its rooms |

The `@private` notice goes to the throttled connection only, is never logged, and carries no `message_id` or `log_id`, so it needs no SQL. Posting quotas continue to cover every logged mutation (`message`, `room_set`, `reactions`, `me`) and a registered user's room joins and leaves.

Every frame is charged to the IP and daily frame budgets before any other work (section 6). Each connection reserves frames in blocks of `frameLease` (10) and spends them from its attachment, so a frame carries a tenth of a reservation's SQL bookkeeping (section 7 allows durable block reservation). A block counts against the IP's frame minute and the daily frame budget when it is reserved, lives only in that connection's attachment so it is never granted twice, and is burned when the connection closes or the UTC day ends. A connection that sends a single frame costs what it did before blocks. Operations that do SQL work still reserve their own cost. Handlers read the attachment after the charge, so none writes back a copy with the block unspent. The frame is parsed before it is charged; parsing is bounded CPU work with no storage.

### 4.1 Internal names

Internal names such as the `anonymous` quota tier and its `anonymousPosts*` configuration keys refer to guests; wire-visible names use `guest` (`guest_posts_per_minute` in `server.params.ext.demo`).

## 5. Authentication and IP attribution

### Guest

`auth` with `scheme: "guest"` assigns a server-authoritative guest ID `guest_<n>` from a server-wide counter (`guest_1`, `guest_2`, …; [PROTOCOL.md §3.2](../../PROTOCOL.md#32-authentication) suggests this convention) and the generated display name `Guest <n>`, bounded by the name limits. Repeated guest auth on that same connection must not mint fresh identities to escape limits: it returns the connection's identity and takes no number. No durable account row is necessary for each guest socket.

Guest numbers are reserved in blocks of `guestNumberBlock` (10): the object keeps the next number and the end of its block in memory, and when the block is used up it advances a durable high-water mark (a `_meta` row) by one block in one write, then serves that block from memory. A start, eviction, or hibernation wake loses the in-memory block, so the first guest afterwards reserves a fresh block past the mark and the rest of the old one is skipped. Numbers are therefore unique across restarts, evictions, hibernation, and schema resets (the mark is carried across the wipe), but not contiguous: expect gaps of up to one block per wake, so the latest number overstates the count of guests by at most that much. Reserving and taking a number are synchronous, with no await between them, so concurrent auths never share a number or reserve twice. A reservation is charged like any other (see the cost report); an exhausted budget fails the guest `auth` that needs a new block.

Guest identity lasts for that socket, including hibernation. This initial version does not promise guest identity recovery after reconnect; explain that guest retry deduplication/ownership cannot span a reconnect that assigns a new identity. IP posting limits still span reconnects. Registered users have stable identity across devices/reconnects.

Guests only read unless the deployment sets `GUEST_POSTING=true`, and `server.params.ext.demo.guest_posting` says which. A read-only guest may authenticate, list rooms, read history, join and leave rooms (their memberships live in the connection and change only its deliveries), and run `/help`; `message`, `reactions`, `room_set`, and `/invite-bot` are `denied` with "Guests can only read here; sign in with a passkey to post" ([PROTOCOL.md §3.5](../../PROTOCOL.md#35-messages) lets a server deny posts by policy), `me` stays denied as before, and its typing is dropped. Guest `auth` then sends a `@private` notice in `general` ("You're reading as a guest. Sign in with a passkey to post, react, and start threads."), to that connection only and before the auth result, since the auth caused it ([PROTOCOL.md §1](../../PROTOCOL.md#1-transport--framing)).

### Bots

A registered user (not a guest, not a bot) runs `/invite-bot` to get a bearer token for a bot account. The bot's `user_id` is fixed as `bot_` plus the owner's `user_id`, and its name is "Bot of <owner's name>" (the owner's `user_id` when the name was removed), cut to the name limits. The first invite creates the bot as an identity row with tier `bot` and no credential, which counts against the registration caps (per IP, per day, and the identity cap) and starts the bot in `general` with a logged `membership` record; a later invite renames the bot after the owner's current name, announcing the change with `user` `new` to those who share a room with the bot, and adds nothing else. Each invite mints a new token, `apron_bot_` plus 32 random bytes as base64url, and revokes the last one: bot connections open with the old token close with 1008. The token goes to the inviting connection only, in a `@private` notice in the room of the command (markdown, the token in a code block and a sample `auth` frame), before the `{}` result.

Tokens are kept in the object's key-value storage like passkey sessions: `bot-token:<sha256 of the token>` → `{botId, ownerId}`, and `bot:<botId>` → the current token's key, so the next invite can delete it. They do not expire; a new invite is how an owner rotates or revokes one, and a schema reset wipes them with everything else. A bot authenticates with `auth` `scheme: "token"`, which every connection is offered: `server.params.auth` is `["token","guest"]` where passkeys are not, since bots are not browsers and send no `Origin`. The `apron_bot_` prefix routes a token to the bot path without a storage read; passkey session tokens still resume only on the origin that minted them. A bot then acts as a registered user with its own posting quota and stored memberships, except that `me` cannot rename it ("A bot is named after its owner") and it cannot run `/invite-bot`.

### Canonical WebAuthn authentication

Implement protocol [§4.9](../../PROTOCOL.md#49-webauthn-authentication): `action` is `register` or `login`, `step` is `begin` or `finish`, and both steps require request IDs. Support discoverable passkeys; do not download a directory of all credentials to the client.

```json
{"method":"auth","id":"a1","params":{"scheme":"webauthn","action":"register","step":"begin"}}
```

The intermediate response is `{"id":"a1","result":{"challenge_id":"...","public_key":{...}}}`. `public_key` is JSON-encoded WebAuthn creation options, with binary fields represented as base64url; the client adapter converts them to browser API types. For `action: "login"`, return request options. An intermediate result does not authenticate the socket or start live delivery.

```json
{"method":"auth","id":"a2","params":{"scheme":"webauthn","action":"register","step":"finish","challenge_id":"...","credential":{}}}
```

`credential` contains the serialized browser credential response, not the empty illustrative object above. On successful verification return normal `result.you` plus a bearer `token` for session resume (see [policy](docs/policy.md#authentication-policy)), store the authenticated tier in the attachment, and establish live room delivery. Login uses the same exchange with `action: "login"`.

- Challenge TTL: 120 seconds, one outstanding challenge per connection. A challenge is bound to connection, action, RP ID, and allowed origin, and is consumed by a matching finish attempt. Begin replaces an earlier challenge. A challenge does not extend the initial authentication deadline; challenge expiry and unauthenticated timeout are independent.
- Guest users may initiate an upgrade on their authenticated guest socket; they retain guest rights until success. After final registered authentication, identity switching requires reconnect. Failed upgrade grants no higher allowance.
- Configure an explicit RP ID and exact allowed origins. Validate type, challenge, origin, RP ID hash, signature, user presence, and user verification using a maintained verifier. Registration requires discoverable credentials, user verification, and `attestation: "none"`. Bound all credential sizes before expensive verification.
- Do not accept a claimed user ID or credential ID as authentication. Resolve identity from the verified stored credential. Handle zero/non-monotonic counters for synchronized passkeys according to the verifier's supported semantics; do not invent a counter-only proof of authenticity.
- One credential per registered identity is sufficient for the demo; account linking/recovery are out of scope. Unique credential IDs cannot register another identity. Store only bounded necessary public-key and verifier metadata.
- Recheck registration caps and atomically write credential/identity/budgets after verification, before returning success. Concurrent successful verifications cannot exceed caps.
- Authentication executes on every new connection; it is not bypassed by the mutation deduplication cache. All begin/finish/retry attempts count toward auth/frame/resource limits.
- Registration does not clear the IP's anonymous usage or aggregate quota. Multiple passkeys remain subject to the common IP/global budgets.

Implementation reference: [WebAuthn verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion).

### IP key

Extract Cloudflare's client address in the public entry Worker. Strip any incoming copy of the private forwarding field before setting trusted metadata for the DO. Do not trust `X-Forwarded-For`, client JSON, or a public query parameter. Account for documented Worker-subrequest and Pseudo IPv4 behavior; a missing/unusable trusted IP fails admission rather than creating a fresh unlimited bucket.

Canonicalize IPv4 and IPv4-mapped IPv6 to the same IPv4 key; group native IPv6 by /64. Store the first 128 bits of SHA-256 of the canonical key, encoded as unpadded base64url. This requires no server secret and is a compact internal identifier, not anonymization. Keep the hash format stable across daily rollover and deployments to preserve active rolling windows. Public users behind NAT share IP limits; explain this tradeoff in the demo help text.

Reference: [Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

## 6. Default limits

All applicable limits compose: passing one does not bypass another. Time means server time. Posting windows are rolling 60 seconds, not fixed calendar-minute buckets. Daily limits use UTC dates and change lazily on access without requiring a midnight timer. A backward clock jump must not reset a budget or move retention backward.

### Posting and registration

| Key | Default | Scope |
| --- | ---: | --- |
| anonymous_posts_per_minute | 5 | Normalized IP, all guest sockets |
| anonymous_posts_per_day | 100 | Normalized IP |
| registered_posts_per_minute | 20 | Verified user ID, all sockets |
| registered_posts_per_day | 500 | Verified user ID |
| ip_posts_per_minute | 30 | IP across guest/registered identities |
| ip_posts_per_day | 1,000 | IP across identities |
| global_posts_per_minute | 60 | Entire demo |
| global_posts_per_day | 5,000 | Entire demo |
| registrations_per_ip_day | 3 | Successful registrations |
| registrations_per_day | 100 | Entire demo |
| registered_identity_count | 10,000 | Persistent total |
| auth_attempts_per_ip_minute | 10 | Begin/finish/guest/failed attempts |

Posting includes message creates, edits, deletes, restores, moves, reaction changes, thread room creation and saves, name changes, and registered users' room joins and leaves (a guest's live in its connection and cost no posts). The `anonymous_*` rows apply to guest identities. Count only newly accepted operations against posting quotas; matching deduplicated retries do not post again. Invalid requests and rejected attempts still spend frame/read/verification budgets. Notifications receive no exemption.

### Payload and query bounds

| Key | Default |
| --- | ---: |
| max_frame_bytes | 16,384 UTF-8 bytes |
| max_text_bytes | 4,096 UTF-8 bytes |
| max_snapshot_bytes | 8,192 serialized UTF-8 bytes |
| max_json_depth | 8 container levels, root counts as 1 |
| max_json_nodes | 2,048 values, counting root and array/object values |
| max_request_id_bytes | 128 |
| max_name | 80 Unicode code points and 320 UTF-8 bytes |
| max_embeds | 4 |
| history_default_limit | 20 |
| history_max_limit | 50 |
| history_max_response_bytes | 262,144 including envelope |
| history_requests_per_user_minute | 10 |
| history_requests_per_ip_minute | 30 |
| concurrent_history_per_connection | 1 |

The smaller frame limit is a documented demo exception to the protocol's advisory 256 KiB recommendation. UTF-8 byte size is not JavaScript string length. The final authoritative snapshot must fit after server-owned fields are added. No truncation of accepted text/extensions. Decode and validate depth/nodes after the raw byte check; reject object/array top-level batches and pathological structures. Bound the byte sizes of auth options, credential IDs, public keys, and all persisted metadata as well.

### Connections and all-method traffic

| Key | Default |
| --- | ---: |
| open_connections | 100 total, including pending auth and closing sockets |
| anonymous_connections_per_ip | 2, including unauthenticated sockets |
| registered_connections_per_user | 3 |
| connections_per_ip | 10 total |
| connection_admissions_per_ip_minute | 5 |
| connection_admissions_per_day | 2,000 globally |
| unauthenticated_timeout_seconds | 30 |
| pending_frames_per_connection | 8, additionally bounded to 128 KiB |
| frames_per_connection_minute | 60 |
| frames_per_ip_minute | 120 |
| global_frames_per_minute | 300 server-wide, in memory, before SQL |
| frame_lease | 10 frames reserved per block, per connection |
| activity_broadcasts_per_user_minute | 10 relayed typing updates |
| room_list_requests_per_user_minute | 6 |
| room_list_members | 100 registered members listed per room (calibrated ceiling 200); connected members are always listed |
| ping_seconds | 45, advertised as `server.ping`; answered by the runtime, not counted as frames |
| ping_timeout_seconds | 150 without a ping or frame, once one was sent |
| processed_frames_per_day | 100,000 globally |
| repeated_policy_violations | Close after 3 within 60 seconds; severe oversized/binary input closes immediately |

Minute limits other than posting may use a documented token bucket with a burst no greater than the listed minute allowance. First-check cheap frame/connection gates precede JSON parsing, SQL queries, and cryptographic work. WebSocket control frames are not application frames.

Use a staged handshake for registered reconnects: pending sockets initially obey the anonymous/pending limits and upgrade to registered limits only after verification. This can limit simultaneous registrations from a NAT; it must not be circumvented by accepting a client-claimed registered tier before auth.

Stop admission and close remaining sockets when the global frame budget is exhausted. Buffered/in-flight hostile frames can still reach handlers and platform meters; this budget limits admitted processing, not the network's ability to send traffic. Client reconnects use exponential backoff with jitter and honor server retry instructions. No application-level infinite resend queue.

## 7. Budget accounting and free-plan guarantee

Current planning baseline, checked 2026-09-20:

| Cloudflare resource | Workers Free allowance |
| --- | ---: |
| DO request units | 100,000/day |
| DO duration | 13,000 GB-seconds/day |
| SQLite rows read | 5,000,000/day |
| SQLite rows written | 100,000/day |
| SQLite storage | 5 GB/account |
| Entry Worker requests | 100,000/day |

DO incoming WebSocket messages have a 20:1 request-metering ratio; handshakes/RPC/alarms also count. Outgoing messages have no request charge. These are shared allowances, not per-object allocations. Free-plan exhaustion fails operations; a paid plan's included allowance is not a spending cap. See [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/). Recheck these sources before deployment and record the verified date.

### Application allocations

| Budget | Ceiling | Allocation |
| --- | ---: | --- |
| SQL writes/day | 80,000 | Up to 60,000 foreground; 20,000 reserved maintenance/control |
| SQL reads/day | 3,000,000 | Up to 2,500,000 foreground; 500,000 reserved maintenance/control |
| Database operational high-water | 96 MiB | Suspend growth and prioritize expired-data cleanup |
| Database hard target | 128 MiB | Includes indexes, control/auth state, and cleanup headroom |
| Resume growth low-water | 80 MiB effective occupied storage | Avoid oscillating admission |
| Cleanup batch | At most 100 source records | Further limited by measured reads/writes and available reserve |

The 5,000-post ceiling is a maximum, not a promise. If the measured schema/traffic exhausts resources earlier, refuse work earlier. Do not claim capacity from a guess of one write per message. Include snapshot/log/index/dedup writes, limiter state, credential counters, alarms, failed work, expired-data deletion, migrations, and bookkeeping. Cleanup's workload includes yesterday's records while accepting today's. Avoid indexing every metadata column or enabling FTS.

Implementation must have one metered storage boundary for all SQL/KV/alarm work. For each operation class, establish a conservative cost bound, reserve it before work, and observe actual SQL cursor row counts to verify the model. Include the cost of the reservation itself. No public request may trigger a full-table scan, unbounded join, migration, or unmetered maintenance query. `LIMIT` alone does not prove bounded scan cost. A cap breach in cost calibration is a release blocker, not a reason to silently raise budgets.

Durable block reservation is allowed to avoid a SQL write on every incoming/rejected frame: commit an allowance before spending it; tie it to an owner and UTC day; never grant the same allowance twice. Persist consumption where necessary, or burn unused allowance on restart. Connection attachments can preserve connection-local lease state across normal hibernation. Budget reservations must remain charged even if subsequent work rolls back or crashes; a rolled-back row is not evidence of refunded platform usage. Once a metered operation finishes, the part of its reservation that its SQL cursors show it did not use (rolled-back rows count as used) is credited back in one budget-row update, which the operation pays for; a crash before then leaves the whole reservation charged, and KV work, which has no cursor, stays fully charged. Exhausted/uncertain accounting fails closed.

Posting window timestamps and counters must survive reconnection/hibernation and concurrent sockets. Keep bounded persistent limiter keys for admitted principals, expire them after their applicable windows, and bound any additional in-memory negative cache. Never create one durable record per attacker-supplied request ID, failed credential, or rejected IP. Proposed limiter-record cap: 10,000, with old expired entries reclaimable in metered batches; new principals are denied when the cap is reached.

The DO is the authoritative limiter. Cloudflare's edge Rate Limiting binding is optional preliminary filtering and cannot serve as an exact global budget: [documented locality/accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

### Storage pressure

Measure physical database bytes and bounded logical payload totals. Reject growth with enough margin for the largest admitted operation, indexes, and control updates; check again after commits. Deletions may free SQLite pages for reuse without shrinking `databaseSize`. A file staying large must not be mistaken for still-occupied data, and delete/reinsert churn must not make it grow without bound. Determine actual supported freelist/page instrumentation and page reuse in tests. Do not assume VACUUM is available or free, and do not put it on a request path.

At pressure thresholds, purge only already-expired data and stop growth if that is insufficient. Do not silently shorten the advertised retention window to accept another message. A 128 MiB target does not guarantee 5,000 maximum-size messages plus all ancillary data; size admission takes precedence. Never delete the whole database to reclaim chat space because it contains credential and quota authority.

### What can and cannot be guaranteed

Deploy only on Workers Free, with no paid ancillary services, and reserve account headroom for this workload. Incoming rejected HTTP/WebSocket traffic still consumes platform resources; no application limiter can guarantee availability under unlimited hostile traffic. Cloudflare's hard free-plan limits are the final zero-overage backstop. App quotas provide controlled degradation under admitted traffic, not a network-level request shield.

One active object at the documented memory allocation uses roughly 11,000 GB-seconds over a full day, below the duration allowance; still use hibernation and avoid extra production objects. Fan-out remains processing/memory work even when it has no outgoing request charge. Native resource errors must be caught where possible and fail closed without reconnect or alarm retry storms.

## 8. Persistence and transaction boundaries

Use versioned schema migrations, parameterized SQL, minimal indexes, and synchronous transactions for related writes. Do not run migration DDL on every hibernation wake. Keep constructors light and initialize once per schema version under the appropriate initialization gate. Reference: [SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Suggested logical schema; physical layout may change to reduce measured costs:

| Table/state | Required contents |
| --- | --- |
| log_state | Server-wide last log ID, monotonic history floor F, last commit time |
| rooms | Room ID, fixed parent, creation/current record log IDs, per-room head, intro message reference, bounded client fields; one top-level room plus at most 100 threads |
| memberships | Each registered identity's joined rooms, one row per room and user: by room (the primary key) for `members`, and by user for the user's rooms; guests' live in connection attachments |
| records | Room/log primary key, internal commit time, record kind, complete record JSON; a move is stored in both rooms |
| message_state | Message ID primary key, current room, latest log ID, latest snapshot and author |
| reaction_state | Message/user primary key, latest log ID, reacting identity, emoji set |
| identities/credentials | Stable user ID, unique credential ID, public key, required verifier state, bounded name |
| accepted_requests | User/request primary key, canonical method+params digest, original result, expiry |
| resource_budgets | UTC day, charged/reserved reads/writes/frames/admissions/posts/registrations |
| principal_limits | Bounded IP/user counters and rolling posting timestamps |
| maintenance | Next due tasks, pending cleanup cutoff/cursor, schema version |
| _meta | Schema version, effective clock, bounded counters and latches, and the guest-number high-water mark |

Indexes cover per-room log ranges (the primary key), the server-wide log prefix and commit time for expiration, latest-record expiry of message and reaction state, registered memberships by room (the primary key) and by user, dedup expiry, and limiter expiry. A record belongs to every room its message is in just before or after it; storing a move once per room keeps each room's history a single indexed range. Benchmark the actual query plan.

Each mutation, after resource reservation and validation, performs one atomic decision: check dedup, recheck all applicable quotas/ownership, allocate log IDs, update current state, append every record to each room log it belongs to, advance room heads, record result, update applicable posting counters. Send the recorded result and ordered broadcast only after success. Do not call remote services inside the mutation transaction.

Store internal commit time for retention, distinct from the wire log ID. Make commit times nondecreasing so expiration is a prefix of the log even if the system clock rolls back. Keep a nondecreasing effective time for budget/retention decisions; clock anomalies may delay expiry, never resurrect expired data or replenish a used budget.

### Schema versions

The schema version lives in `_meta` and the `maintenance` row. A new object creates the current schema (4, which added membership records and the `memberships` table for protocol v6) and seeds the `general` room's creation record. An additive change that older code ignores and whose absence reads as its initial value needs no new version and no wipe: the guest-number mark is such a `_meta` row, absent (zero) in schema 4 objects created before it. Stored data is never migrated: when the constructor finds a different schema version, older or newer, it wipes the whole object with `deleteAll()` (every SQLite table and key-value entry, so chat, identities, credentials, passkey sessions, limiter windows, and deduplication rows) under `blockConcurrencyWhile`, then creates a fresh schema. The demo is public and retains about a day of content, so a reset on schema changes is simpler and safer than upgrade code; passkeys must be registered again, and a token that outlives its session or identity is `denied`, which sends the client back to sign-in. To avoid replenishing platform usage already metered today, the current UTC day's resource-reservation row is read before the wipe and added back afterwards, together with the one-time 512/512 bootstrap reservation. Neither addition checks capacity, so a reset cannot fail on, or be blocked by, an exhausted budget; an exhausted day stays exhausted until UTC midnight. The guest-number high-water mark is carried the same way, so a reset never reissues a guest ID. The accounting-unsafe latch is not carried: an operator deploy that resets storage is its recovery path. The log head is not preserved across a reset; new log IDs are commit-time milliseconds and so normally still exceed old ones, but every old record is gone, so clients reconnecting after a deploy must rebuild from the listed history bounds.

### Deduplication

Deduplicate accepted mutating requests by `(user_id, request_id)` for 24 hours after acceptance. Canonicalize method and params recursively with stable object-key ordering, preserving arrays/types; ignore envelope `jsonrpc`. Store a cryptographic digest rather than a full duplicate message payload where practical. Same key/same operation returns the original result; same key/different operation returns invalid_params. Concurrent copies cause one effect and one broadcast. Dedup responses still spend their bounded lookup/frame costs.

Check an unexpired duplicate before applying new-post quotas or deciding an old message has expired; a previously accepted result remains valid through the dedup window. Expired records are logically absent even if physical cleanup is pending. Failed/limited operations are not recorded as accepted. Notifications have no dedup guarantee. After the documented TTL, replaying an old request ID may execute again; the client must not retry stale queued operations indefinitely.

## 9. Rolling history and base-protocol availability

Retention replaces all earlier daily-reset/room-rotation ideas. Keep `general` unchanged. Every hour, expire the prefix of the server-wide log committed more than 24 hours earlier. Healthy operation normally exposes 24–25 hours of records; scheduling delay or quota exhaustion can delay physical cleanup. This is a demo history policy, not a secure-erasure SLA or a guarantee about backups, provider recovery, or copies on clients.

### Retention semantics

- Expire records by their internal nondecreasing commit time, not message creation ID. Commit times are nondecreasing in log order, so expiry is always a prefix of the one server-wide log.
- Retain a current message while its latest record remains retained. Remove current state when its latest record expires. Tombstones and reaction sets follow the same rule; a move re-logs the moved message's reaction sets, refreshing them.
- A recent edit can keep a message visible past 24 hours from creation. Its older creation/edit records may be removed; its latest complete snapshot is sufficient to reconstruct it.
- A registered user's membership is current state, kept in `memberships` after its record leaves the log (see "Memberships" in section 4).
- Room records are current state, like messages: a room keeps being listed with its latest record (and that record's original `log_id`) after the record itself leaves the log. A thread room whose entire log has expired is removed, and its members get `room_update` `left`.
- Physical row deletion is separate from logical visibility. History, edits, and lookups always enforce the published floor, including during partial cleanup.
- Passkeys and global/principal budgets are independent of chat retention. Dedup uses its own 24-hour expiry.

### Floor definition and wire shape

Internally maintain one server-wide positive log boundary F, initially 1. All
records with `log_id < F` have been logically discarded; records at/above F, if
committed, are available. F never decreases and is not a client checkpoint.
Advance F to one greater than the greatest record logically expired. If
nothing further expires, retain F. Future IDs must be at least F.

On the wire, each room reports its own values. `latest_log_id` is the room's
historical committed head H (the greatest `log_id` in its log), including when
history expires. `history_log_id` is the inclusive decimal-string coverage
boundary max(F, the room's creation `log_id`) while that is <= H, and `null`
when no history remains. A new room's history therefore starts at its creation
record. Clients derive the effective floor from a null value as H + 1; no
inverted range is sent on the wire. The boundary never decreases: F is
monotonic, and a room reports `null` only while F > H, so any later record in
the room is at least F.

Include both fields in every room record the server sends (`room_list`,
`room_update`) and every successful history result, without an extension
advertisement:

```json
{"method":"room_update","params":{"updated":[{"room_id":"general","log_id":"1789900000000","title":"General","latest_log_id":"1790000001000","history_log_id":"1789913600001"}]}}
```

```json
{"id":"h1","result":{"more":false,"latest_log_id":"1790000001000","history_log_id":"1789913600001"}}
```

This empty page can represent an out-of-range or expired query; only a room
whose retained log is empty uses `history_log_id: null`.

After advancing F, tell removed thread rooms' members first with `room_update` `left` (no storage access), then send every room whose `history_log_id` changed as `room_update` `updated` to the members of the room and of its parent, with the listing charged to the maintenance budget; a failed listing never suppresses committed removals. A cleanup job whose last batch reported more work (including thread rooms still awaiting removal) continues on its next run without the idle probe ending it. Attach both wire boundaries atomically with each history page's query snapshot; do not return entries evaluated under an older floor with a newer response floor. Capture response state synchronously without external awaits. Keep F monotonic on clients even if paginated responses arrive out of order.

### History queries

Follow protocol [§4.1](../../PROTOCOL.md#41-history): inclusive after/before, forward oldest selection when after is present, backward newest otherwise, always return each array ascending. Without `room_id` the default room `general` is paged; unknown rooms are `invalid_params`. A window with `after` equal to `before` returns exactly that record when it is retained in the requested room's log; a moved message's earlier snapshot is fetched from the room its `prev_room_id` names. Query only the intersection with the room's `[history_log_id, latest_log_id]`. `limit` counts records of every kind, and `first_log_id`/`last_log_id` span all kinds; results are partitioned into `rooms` (with the room's delivery fields), `messages`, `reactions`, and `membership`, each omitted when empty. An empty or entirely expired range returns `more: false` and neither bound, with F; do not invent pagination IDs. History carries no `users`. No compaction is required for this version.

Select from the room's own log before the source-slice limit. With a byte cap, shrink the effective positive limit before selecting the final contiguous slice in the requested direction. Return its true first_log_id/last_log_id and more, accounting for records omitted due to either count or byte cap. Each allowed snapshot must fit into at least one response with envelope overhead. Forward continuation is last_log_id+1, backward continuation first_log_id-1; never use string ordering or message IDs for pagination.

A move's snapshot appears in both rooms' histories and carries the destination `room_id`; the message's earlier history stays in the source room. Threads are separate rooms with independent histories and floors.

### Client recovery

The implementing harness must add this behavior to the demo client:

1. Track the greatest advertised F per room. Remove cached snapshots whose greatest applied log ID is below F; remove expired pending rendering references. Preserve newer snapshots even when their message creation IDs are old.
2. A checkpoint C is usable for forward recovery only when `C + 1 >= F`. If `C + 1 < F`, some uncovered records were discarded: clear that room's recovered state/checkpoint and rebuild from F. This handles the exact boundary without needless resets at `C = F - 1`.
3. Capture head H when establishing live delivery. Recover forward through fixed H, buffer live entries above H, apply newer snapshots only, then drain the buffer. If F>H, the retained initial view is empty and subsequent live entries can proceed.
4. Before applying each page, inspect its F. If retention has overtaken the next unprocessed recovery position, discard the partial history replay and rebuild against the new floor while preserving the fixed head H and retained live entries buffered above it. Do not mark a silently truncated gap as recovered. Cancel or ignore obsolete in-flight requests by a local recovery generation.
5. An increased floor within already processed coverage need not restart recovery, but must evict newly expired snapshots. Bound live/recovery buffers (1 MiB or 1,000 entries); on overflow, clear partial recovery and reconnect/recover with backoff.
6. Each room's checkpoint is independent; threads are separate rooms. Eviction and asynchronous older pages must never resurrect snapshots below the current floor or overwrite a newer snapshot.
7. Room record updates (`room_update`, listings) do not advance checkpoints or replace an active fixed recovery head by themselves. The floor only invalidates unavailable history.

Include a visible demo notice that only roughly the last day is retained.

### Cleanup algorithm and failure recovery

Use a single scheduler backed by the DO alarm API. Due cleanup fixes a cutoff (`effective_now - 24h`) and identifies an expired log prefix with indexed, bounded work. Persist logical floor advancement and a cleanup job before discarding its rows. Publish floor changes in commit order. If discovering the prefix requires several batches, advance the floor incrementally; each visible floor must match actual logical coverage.

Delete expired records, expired current message and reaction state, fully expired thread rooms and then their stored memberships, expired accepted-request entries, and expired limiter state in separately bounded, metered batches. Retained latest snapshots and necessary current state must not be accidentally removed with an older version of the same message. Never reset room head, floor, credentials, or live quota counters. A next task is scheduled until the job completes; ordinary cleanup starts hourly, continuation wakes only as needed and within the budget.

Retries are idempotent and work from persisted progress. A crash before or after any batch must preserve externally advertised coverage. If maintenance budget is exhausted, defer physical work until resources reset, suspend growth as needed, and do not spin alarms. Alarm/API failures must not permanently orphan cleanup: re-establish missing due work on subsequent valid activity as well as documented alarm retries. No live socket is needed to perform cleanup.

Use the same scheduler for unauthenticated socket deadlines, batching deadlines where possible; every alarm setup/invocation is accounted. Alarms are at-least-once and retries are finite: [Alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/).

## 10. Degradation and public-demo behavior

| Exhausted resource | Required behavior |
| --- | --- |
| Principal posting limit | Reject new mutations with retry_after; allow affordable reads |
| Global daily posting/foreground write budget | Read-only until replenished; matching dedup retries may return stored results |
| Read/history budget | Reject history; do not fake an empty successful history page |
| Registration count/durable identity cap | Stop registration; existing logins and guest use continue if affordable |
| Storage high-water | Stop growth, clean expired data using reserve, resume only when safe |
| Socket/admission cap | Reject upgrade; existing sockets continue if affordable |
| Global frame budget | Stop processing new application work, close sockets, reject admissions until reset |
| Cloudflare hard limit or uncertain accounting | Fail closed; no automatic paid fallback |

Compute retry delay from the limiting window where known; when multiple limits apply, use the longest applicable delay. Capacity/storage retries may use a documented backoff estimate, not a false guarantee of future availability. Persist an optional operator-configured admission-off flag; it must not require migrating or deleting the object.

For a permanent policy cap with no automatic replenishment, such as the identity or thread-room ceiling, use `denied` with an explanatory reason such as `registration_closed` or `thread_limit`; do not induce endless retries with an invented reset time. The operator can raise a policy ceiling only after reassessing the resource budget.

Keep UI messages concrete: "Guest posting limit reached", "Demo is read-only until daily reset", "History temporarily unavailable", or "Demo capacity reached". No billing/SQL details in normal user flows. Do not silently drop a successful write, alter user content, or hide an error as success.

Support a standalone `ALLOWED_ORIGINS = "*"` to admit every guest origin, including opaque origins. Exact allowlist deployments reject unexpected browser origins before upgrade. Require explicit exact RP origins for WebAuthn even under wildcard guest admission; advertise WebAuthn only to connections from those origins. Non-browser clients with no Origin may use the public protocol subject to the same quotas; origin checking is not bot authentication. Reuse the existing Markdown sanitization and iframe restrictions. No backend URL fetching from embeds. Secrets never enter logs, public status responses, or source control.

Limit observability to bounded structured events and counters: operation category, accepted/rejected reason, daily resource reservations/actuals, active sockets, database bytes, oldest retained commit, floor/head, cleanup backlog, and alarm failures. Sample repetitive rejection logs and never persist request bodies, passkey challenges, or raw IPs to analytics.

## 11. Required verification

Use unit tests for pure logic and Cloudflare's Workers/Vitest integration for runtime storage, WebSocket, and alarm behavior: [testing documentation](https://developers.cloudflare.com/workers/testing/vitest-integration/). Use a fake clock for deterministic policy tests. Confirm how the selected runtime version simulates hibernation; do not label a normal reconnect test as a hibernation test.

### Protocol and sequencing

- Minimal/JSON-RPC envelopes; valid/invalid IDs; parse failures; notifications without replies; unknown method/field behavior.
- Server precedes auth; pipelined slow auth then message cannot overtake authentication; a result reflects every notification sent before it (a `room_update` precedes the result of the request that caused it).
- Equal-millisecond and backward-clock creates/edits strictly increase IDs; head survives empty-log cleanup/restart.
- Concurrent sockets mutating the same room produce one ordered stream. Author spoofing fails. Edit/delete/restore follow replacement semantics and ownership.
- Message extensions, embeds, tombstones, and immutable fields survive storage/replay correctly.
- Same-ID retries with reordered object keys or different jsonrpc presence have one effect and broadcast; conflicting params are rejected. Parallel duplicates, lost reply, and restart recovery are covered.
- A retained accepted retry returns its original result despite a newly exhausted posting quota or expired message. Auth is never skipped by dedup.
- Inject failures before commit, after commit/before reply, and during fan-out. No broadcast of uncommitted data or silent stream gaps.

### History and retention

- Forward/backward inclusive bounds, numeric ordering, byte-limited contiguous pages spanning every record kind, exact more/first/last behavior, empty ranges, and unknown/empty rooms.
- Concurrent history/live delivery around captured H has no missing record; per-room checkpoints are not confused.
- Fake-clock advance: nothing younger than cutoff expires; hourly cleanup yields the intended approximate window. Same room ID/head persists.
- Recent edit of an old creation, recent tombstone, moves into and out of thread rooms, restoration, reaction sets, and room records survive trimming; fully expired thread rooms are removed.
- Unused and fully expired rooms report `history_log_id: null`; an expired room preserves its nonzero `latest_log_id`. Internally F=head+1 and the next creation is newer. Empty filtered pages retain the room-wide non-null boundary when history remains. Both fields are captured with every page. No accidental reset to zero or giant integer/string comparison bug.
- Client with C<F-1 rebuilds; C=F-1 resumes safely. Floor advancement during pagination, delayed older pages, and out-of-order replies cannot resurrect old state or create a checkpoint gap.
- Cleanup after latest-message update never removes its retained snapshot. Crash/retry at every batch boundary preserves logical floor visibility. Work continues without connected clients.
- Budget exhaustion delays physical cleanup safely; storage pressure blocks growth. Dedup expiry remains independent of records; credential/limiter state survives.

### Auth and abuse controls

- Guest sixth mutation within 60 seconds fails across tabs/reconnects; five can be accepted when timestamps permit. Test the calendar-minute boundary explicitly.
- Registered twenty-first mutation fails; several credentials at one IP cannot exceed aggregate IP limits. Failed/unverified WebAuthn cannot raise a tier.
- IPv4, mapped IPv6, equivalent textual forms, /64 rotation, spoofed forwarding fields, and missing trusted metadata behave as specified.
- WebAuthn wrong challenge, replay, expired challenge, wrong connection/action/origin/RP, bad signature, missing UV, duplicate credential, and unsupported oversized metadata are rejected.
- Registration races enforce global/IP/count limits; existing passkey login works when registration is full. Real browser or virtual-authenticator end-to-end registration/login complements verifier unit fixtures.
- Frame, connection, auth, history, registration, global posting, and byte/depth limits are independent and survive hibernation/restart as applicable.
- Unicode byte boundaries, escaped JSON, many tiny fields, binary input, invalid JSON, notifications, and oversized WebSocket messages cause bounded processing and correct close/error behavior.
- Exhaustion cannot be bypassed by deleting cookies, changing request IDs, reconnecting, upgrading guest auth, or client-supplied claims. Unique denied identities do not grow tables indefinitely.

### Capacity, accounting, and lifecycle

- Measure rows read/written per operation with the actual indexes, including quota writes, auth, alarms, failure paths, and deletion. Produce a cost table and test every claimed upper bound.
- Exercise at least three simulated UTC days: accepted traffic plus previous-day cleanup, midnight double bursts, worst-case snapshots, frequent edits, reconnect/history load, and invalid traffic. A 24–25 hour retention interval can span two daily posting allowances; never assume it contains at most 5,000 records.
- Verify metered work stops below configured ceilings with maintenance reserve intact. Include budget leases lost during crash, rollover while a handler is in flight, and accounting update failures. No allowance is reissued after a restart.
- Demonstrate 128 MiB pressure control and SQLite page reuse under repeated delete/reinsert cycles. No unmetered VACUUM/DDL/full scan or accidental account-wide delete.
- Hibernation wake restores socket auth/challenges and budget authority without reannouncing sessions, losing IP counters, resetting IDs, or storing history in attachments.
- Saturate 100 connections and maximum allowed fan-out; bounded queues and recovery buffers prevent memory growth. Validate slow/disconnected consumers without relying on an undocumented bufferedAmount API.
- Alarm scheduling handles simultaneous auth deadlines and cleanup, at-least-once retries, and retry exhaustion; no interval prevents idle hibernation.
- Constructor/redeploy never erases budgets or performs recurring schema writes. Platform failures produce controlled closure/backoff rather than retry storms.

Use tiny configured quotas for deterministic exhaustion tests and a separate calibrated load scenario for realistic defaults. Do not spend production free-tier quotas on exhaustive CI load tests. A local dry run is not proof of production billing; report measured assumptions and remaining platform-specific checks honestly.

## 12. Implementation order and deliverables

1. Add the Workers/DO package in the repository's appropriate location, native hibernation handling, versioned SQLite schema, metered storage wrapper, and fixed-room Level 0 conformance.
2. Add atomic sequencing, deduplication, history, quota gates, and payload/connection limits. Test the live/history boundary before expanding features.
3. Add edit/room/reaction support, rolling retention, base-protocol availability boundaries, and client recovery changes.
4. Add verified passkey registration/login and minimal client UI. Guest operation remains available.
5. Add maintenance/admission degradation, capacity tests, and operating documentation. Run the acceptance tests and review the full schema's cost model.

Deliver:

- Working source and lockfile; no placeholder auth or quota bypasses.
- Wrangler config with a fixed DO binding, SQLite migration, tested compatibility date, and no paid-service bindings.
- Configuration reference for every limit, RP ID/origins, account analytics, and feature toggles. Fail startup/config validation for impossible or unsafe relationships.
- Base-protocol history documentation and minimal client integration, including retention recovery fixtures and canonical WebAuthn fixtures.
- Automated tests, local dev commands, a bounded load/cost report, and a concise implementation summary.
- README describing Free-plan prerequisites, guest identity limitations, rolling history with a permanent room ID, quota exhaustion/recovery, secret setup, and manual deployment steps.
- A deployment checklist that verifies the real account plan and other workload usage, rechecks current platform quotas, applies migrations once, and tests the deployed hibernation/reconnect path when deployment is separately authorized.

Done means the integrated demo satisfies the protocol contract and failure cases above, with measured resource accounting and an honest zero-overage/availability distinction. It must not merely return correct messages while leaving cleanup, passkey verification, restart-safe limits, or retention-aware recovery as TODOs.
