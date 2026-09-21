# Apron public demo server on Cloudflare Workers

Date: 2026-09-20
Status: Implementation specification
Target: https://github.com/shazow/apron
Protocol: https://github.com/shazow/apron/blob/main/PROTOCOL.md
Protocol reference reviewed: protocol version 2, Git blob SHA `d24de5ec177d0c042d7237a7783ccdc8bffec3d5` (a file blob, not a commit).

## 1. Objective and instructions to the coding harness

Build a usable, publicly accessible Apron demo backend using native Cloudflare Workers, one SQLite-backed Durable Object (DO), and hibernating WebSockets. Support anonymous use and passkey authentication, bounded posting and history, and graceful resource exhaustion. The demo must run on the actual Workers Free plan without enabling paid services.

Read the repository's `AGENTS.md`, existing code, package-manager configuration, and `PROTOCOL.md` before implementing. Reuse existing client/protocol utilities where appropriate. Compare the current protocol with the reference above; preserve its mandatory behavior and document material differences. This specification defines deployment policies within the base chat protocol.

Implement the backend, the minimal Apron client changes required for passkeys and rolling-history recovery, tests, configuration, and operating documentation. Keep unrelated frontend work out of scope. If the frontend is in another repository, provide a concrete patch/adapter and integration instructions rather than silently omitting the client requirements. Prepare a deployable result; do not deploy, switch billing plans, or create paid resources merely to complete this implementation task.

Use MUST for required behavior and SHOULD for preferences. Centralize all limits in validated configuration with the defaults below. Do not silently increase limits to make tests pass.

### Required capabilities

- Protocol v2 Level 0: server announcement, authentication, room announcement, creation and broadcast of messages, framing, errors, IDs.
- `history`: complete transition snapshots, correct pagination and live/recovery ordering.
- `edit`: owner-authorized replacement, deletion, restoration of retained messages, thread creation and reassignment as required by that capability.
- Anonymous authentication and verified WebAuthn registration/login.
- Persistent request deduplication for mutating operations.
- Rolling 24-hour history with hourly cleanup, using the same room ID indefinitely.
- Base-protocol history availability boundaries and client recovery support.
- Enforced application budgets, including cleanup, auth, and quota bookkeeping.

### Non-goals

No public workspace creation, room creation/join/leave, federation, multiplexing proxy, presence service, typing broadcasts, uploads, R2, push, email, external URL previews, outbound bots, RTC, arbitrary search, FTS, or third-party analytics. Do not advertise unsupported capabilities. Passkeys do not establish one-human-one-account or solve Sybil resistance.

## 2. User scenarios

1. A visitor opens the public demo, connects, authenticates anonymously, reads recent history, and posts without signup.
2. Several anonymous tabs behind one IP share the five-posts-per-minute allowance; opening another socket does not reset it.
3. A visitor creates a passkey or signs in with one. Successful authentication grants the registered allowance of twenty posts per minute, subject to IP and global limits.
4. A user reconnects after losing a mutation reply. A retry with the same request ID and authenticated identity returns the original result without another mutation or broadcast.
5. A connected client watches a room while another client loads history. Neither misses entries at the history/live boundary.
6. A user returns after more than a day. The client notices the retention boundary, clears stale recovery state, and rebuilds the available room view.
7. An old message edited within the retained window remains recoverable from its complete recent snapshot even after its creation transition is purged.
8. A bot floods requests or creates identities. Per-principal controls and global budgets reject work without unbounded database, memory, or object creation.
9. A resource budget runs out. Posting, history, registration, or admission becomes unavailable as appropriate; accepted messages remain recoverable while resources permit.
10. The object hibernates, wakes, restarts, or is redeployed. Identity, room sequencing, retention boundaries, quotas, and deduplication remain correct; clients can reconnect when necessary.

## 3. Deployment and architecture

Use TypeScript, Wrangler, the native `DurableObject` base class from `cloudflare:workers`, and embedded SQLite. Follow the repository's tooling; pin resolved dependencies and a tested compatibility date. Prefer a small dependency surface and a maintained Workers-compatible WebAuthn verifier instead of handwritten cryptographic verification.

| Component | Responsibility |
| --- | --- |
| Entry Worker | Validate `/` and `/ws` upgrade requests, configured guest origin policy, route/method/body bounds, derive trusted IP metadata, apply cheap preliminary admission controls, forward to the fixed DO |
| `ApronDemoServer` DO | Own sockets, authenticate, authorize, sequence protocol operations, enforce budgets, persist state, serve history, broadcast, run cleanup |
| Embedded SQLite | Authoritative room state, transitions, current snapshots, credentials, deduplication, budgets, rate-limit state, maintenance progress |
| Existing Apron frontend | Anonymous access, passkey UI, retry/backoff, retention-aware recovery and concise demo status |

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
- Use native WebSocket control ping/pong; no application heartbeat and no permanent `setInterval` or `setTimeout`.
- Share one DO alarm scheduler between auth deadlines, cleanup, and maintenance retries. Always schedule the earliest outstanding task; cleanup scheduling must not overwrite an earlier auth deadline.
- A closing socket may remain visible to the runtime; do not let it receive broadcasts or grant extra admission while its close is pending.

API reference: [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/).

## 4. Feature and protocol contract

An illustrative initial announcement is:

```json
{"method":"server","params":{"protocol":2,"name":"apron-cloudflare-demo/1","caps":["history","edit"],"auth":["webauthn","anonymous"],"demo":{"retention_seconds":86400,"cleanup_seconds":3600,"max_frame_bytes":16384,"max_message_text_bytes":4096,"max_snapshot_bytes":8192,"anonymous_posts_per_minute":5,"registered_posts_per_minute":20}}}
```

`demo` is additive server-announcement policy metadata. Authentication uses the canonical `webauthn` scheme in protocol Appendix C, without an extension flag. Every later `server` announcement is a full replacement, including auth/caps/policy metadata. Temporary throttling does not mean a capability is unimplemented.

History availability is part of the base protocol's `history` capability, with no extension negotiation. Use `latest_log_id` and nullable `history_log_id` in room announcements and history results, following protocol section 5.1. This revision replaces the old `latest_id` spelling; update repository implementations together.

After final authentication, reply with `result.you`, announce `general` with its current `latest_log_id` and `history_log_id`, and then announce all existing thread metadata. Do not send room messages to unauthenticated sockets. Establish the room's head and eligibility for live delivery at one serialization point.

### Framing, ordering, and errors

- Accept the minimal and JSON-RPC 2.0 envelopes. One text message contains exactly one object, not a batch array. Reject binary application messages.
- IDs on the wire are strings; only unidentifiable invalid requests use response `id: null`.
- Unknown request methods receive `unsupported`; unknown notifications are ignored. Valid notifications never receive result or error replies, but successful mutation notifications still cause broadcasts.
- Ignore unknown envelope/non-message fields. Preserve accepted unknown message extension fields in complete snapshots and on replay. Never trust client-supplied `from`; reject client `log_id` on a save.
- Process frames in arrival order per socket, including auth and later pipelined writes. External awaits and WebAuthn verification must not allow overtaking. Bound pending work instead of accumulating unlimited promises.
- Coordinate mutation commit and broadcast scheduling globally within this DO. No live room log ID may be sent after a newer ID on the same connection.
- Commit durable state before a success becomes externally observable. Use documented storage/output-gate behavior; do not disable it. A failed send to one socket must not roll back an accepted mutation or skip all remaining recipients.
- On an ambiguous post-commit failure, preserve the recorded result and force affected recovery/reconnection rather than continuing a socket with an unexplained gap. Persistent exactly-once mutation effects within the deduplication window do not imply exactly-once network delivery.

| Error | Code | Use |
| --- | ---: | --- |
| parse_error | -32700 | Invalid JSON |
| invalid_request | -32600 | Invalid envelope |
| unsupported | -32601 | Unimplemented request |
| invalid_params | -32602 | Invalid fields, conflicting duplicate, nonexistent/expired message or thread |
| internal_error | -32603 | Unexpected failure, with sanitized text |
| denied | -32001 | Authentication or ownership failure |
| retry_after | -32002 | Temporary resource/rate limit; integer `data.ms` |
| too_large | -32003 | Valid identifiable request exceeds a payload policy |

For oversized frames, reject before parsing. If an ID cannot be safely obtained, close with 1009 rather than parsing an arbitrarily large payload just to return an error. Close binary input with 1003 and persistent policy violations with 1008. Use HTTP 429/503 before upgrade where applicable, with an appropriate Retry-After. Do not turn capacity limits into fabricated malformed-request errors.

### Messages, edits, and threads

- New messages receive `message_id = log_id = max(now_ms, last_log_id + 1)`, checked below `2^53`; use integer columns and decimal strings on the wire.
- Maintain `last_log_id` even after the entire log has expired. Clock rollback must not reuse IDs.
- Store each accepted transition as a complete authoritative message snapshot. Broadcast to every eligible socket, including the sender; include `echo` for requests with IDs.
- Only the original author may replace/delete/restore their retained message. Preserve immutable author/ID fields. Replacement removes omitted editable fields; it is not a patch/merge. Tombstones omit `body`.
- Anonymous authors own messages under their assigned guest identity; passkey authentication does not automatically transfer ownership of earlier guest messages.
- `thread` creation, existing-thread validation, and message reassignment follow the base protocol. Retain both previous and new thread membership on each transition for filtered history.
- Allow at most 100 thread metadata records, each at most 2 KiB. All thread creation consumes posting and resource budgets. No implicit thread creation. Keep bounded thread metadata even if its messages expire, since the base protocol lacks thread removal; deny further creation when full.
- Reject empty text with no embeds as local policy. Accept plain and Markdown formats. Limit embeds to four within all byte budgets; store accepted URLs/content without backend fetching or rendering. Unknown embed kinds remain opaque. Client sanitization/sandboxing remains mandatory under the base protocol.
- `nick` may be implemented as a bounded, rate-limited identity operation; otherwise return unsupported. No avatar downloads or automatic link previews.

## 5. Authentication and IP attribution

### Anonymous

`auth` with `scheme: "anonymous"` assigns a random server-authoritative guest ID and a generated bounded display name. Repeated anonymous auth on that same connection must not mint fresh identities to escape limits. No durable account row is necessary for each guest socket.

Guest identity lasts for that socket, including hibernation. This initial version does not promise guest identity recovery after reconnect; explain that anonymous retry deduplication/ownership cannot span a reconnect that assigns a new identity. IP posting limits still span reconnects. Registered users have stable identity across devices/reconnects.

### Canonical WebAuthn authentication

Implement protocol Appendix C: `action` is `register` or `login`, `step` is `begin` or `finish`, and both steps require request IDs. Support discoverable passkeys; do not download a directory of all credentials to the client.

```json
{"method":"auth","id":"a1","params":{"scheme":"webauthn","action":"register","step":"begin"}}
```

The intermediate response is `{"id":"a1","result":{"challenge_id":"...","public_key":{...}}}`. `public_key` is JSON-encoded WebAuthn creation options, with binary fields represented as base64url; the client adapter converts them to browser API types. For `action: "login"`, return request options. An intermediate result does not authenticate the socket or trigger room announcements.

```json
{"method":"auth","id":"a2","params":{"scheme":"webauthn","action":"register","step":"finish","challenge_id":"...","credential":{}}}
```

`credential` contains the serialized browser credential response, not the empty illustrative object above. On successful verification return normal `result.you`, store the authenticated tier in the attachment, and establish live room delivery. Login uses the same exchange with `action: "login"`.

- Challenge TTL: 120 seconds, one outstanding challenge per connection. A challenge is bound to connection, action, RP ID, and allowed origin, and is consumed by a matching finish attempt. Begin replaces an earlier challenge. A challenge does not extend the initial authentication deadline; challenge expiry and unauthenticated timeout are independent.
- Anonymous users may initiate an upgrade on their authenticated guest socket; they retain guest rights until success. After final registered authentication, identity switching requires reconnect. Failed upgrade grants no higher allowance.
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
| auth_attempts_per_ip_minute | 10 | Begin/finish/anonymous/failed attempts |

Posting includes message creates, edits, deletes, restores, thread creation, and implemented mutable metadata operations. Count only newly accepted operations against posting quotas; matching deduplicated retries do not post again. Invalid requests and rejected attempts still spend frame/read/verification budgets. Notifications receive no exemption.

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

Durable block reservation is allowed to avoid a SQL write on every incoming/rejected frame: commit an allowance before spending it; tie it to an owner and UTC day; never grant the same allowance twice. Persist consumption where necessary, or burn unused allowance on restart. Connection attachments can preserve connection-local lease state across normal hibernation. Budget reservations must remain charged even if subsequent work rolls back or crashes; a rolled-back row is not evidence of refunded platform usage. Exhausted/uncertain accounting fails closed.

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
| room_state | Fixed room ID, last log ID, monotonic history floor, last commit time, metadata |
| transitions | Room/log primary key, internal commit time, message ID, complete snapshot JSON, previous/new thread IDs |
| messages | Room/message primary key, latest log ID, latest snapshot and author; may instead reference a retained transition to avoid duplicating payloads |
| threads | Server-minted ID and bounded metadata, capped at 100 |
| identities/credentials | Stable user ID, unique credential ID, public key, required verifier state, bounded name |
| accepted_requests | User/request primary key, canonical method+params digest, original result, expiry |
| resource_budgets | UTC day, charged/reserved reads/writes/frames/admissions/posts/registrations |
| principal_limits | Bounded IP/user counters and rolling posting timestamps |
| maintenance | Next due tasks, pending cleanup cutoff/cursor, schema version |

Suggested indexes cover numeric room log ranges, latest log for expiration, dedup expiry, and thread transitions. Thread filtering must include membership immediately before OR after a transition; avoid duplicate rows when both memberships match. Benchmark the actual query plan rather than assuming two indexes make an OR query cheap.

Each mutation, after resource reservation and validation, performs one atomic decision: check dedup, recheck all applicable quotas/ownership, allocate ID if needed, update snapshot, append transition, record result, update applicable posting counters. Send the recorded result and ordered broadcast only after success. Do not call remote services inside the mutation transaction.

Store internal commit time for retention, distinct from the wire log ID. Make commit times nondecreasing so expiration is a prefix of the log even if the system clock rolls back. Keep a nondecreasing effective time for budget/retention decisions; clock anomalies may delay expiry, never resurrect expired data or replenish a used budget.

### Deduplication

Deduplicate accepted mutating requests by `(user_id, request_id)` for 24 hours after acceptance. Canonicalize method and params recursively with stable object-key ordering, preserving arrays/types; ignore envelope `jsonrpc`. Store a cryptographic digest rather than a full duplicate message payload where practical. Same key/same operation returns the original result; same key/different operation returns invalid_params. Concurrent copies cause one effect and one broadcast. Dedup responses still spend their bounded lookup/frame costs.

Check an unexpired duplicate before applying new-post quotas or deciding an old message has expired; a previously accepted result remains valid through the dedup window. Expired records are logically absent even if physical cleanup is pending. Failed/limited operations are not recorded as accepted. Notifications have no dedup guarantee. After the documented TTL, replaying an old request ID may execute again; the client must not retry stale queued operations indefinitely.

## 9. Rolling history and base-protocol availability

Retention replaces all earlier daily-reset/room-rotation ideas. Keep `general` unchanged. Every hour, expire the prefix of transitions committed more than 24 hours earlier. Healthy operation normally exposes 24–25 hours of transitions; scheduling delay or quota exhaustion can delay physical cleanup. This is a demo history policy, not a secure-erasure SLA or a guarantee about backups, provider recovery, or copies on clients.

### Retention semantics

- Expire transitions by their internal nondecreasing commit time, not message creation ID.
- Retain a current message while its latest transition remains retained. Remove current state when its latest transition expires. Tombstones follow the same rule.
- A recent edit can keep a message visible past 24 hours from creation. Its older creation/edit transitions may be removed; its latest complete snapshot is sufficient to reconstruct it.
- Physical row deletion is separate from logical visibility. History, edits, and lookups always enforce the published floor, including during partial cleanup.
- Passkeys and global/principal budgets are independent of chat retention. Dedup uses its own 24-hour expiry; thread metadata stays bounded rather than being silently invalidated.

### Floor definition and wire shape

Internally maintain a positive log boundary F, initially 1. All transitions
with `log_id < F` have been logically discarded; transitions at/above F, if
committed, are available. F never decreases and is not a client checkpoint.
Advance F to one greater than the greatest transition logically expired. If
nothing further expires, retain F. Future IDs must be at least F.

On the wire, `latest_log_id` is the historical committed head H, including when
history expires. `history_log_id` is the inclusive decimal-string coverage
boundary F while F <= H, and `null` when no history remains (F > H). An unused
room has H = 0 and `history_log_id: null`. Clients derive the effective floor
from a null value as H + 1; no inverted range is sent on the wire.

Include both fields in every active room announcement and successful history
result, without an extension advertisement:

```json
{"method":"room","params":{"room_id":"general","name":"General","latest_log_id":"1790000001000","history_log_id":"1789913600001"}}
```

```json
{"id":"h1","result":{"entries":[],"more":false,"latest_log_id":"1790000001000","history_log_id":"1789913600001"}}
```

This empty page can represent a filtered or expired query; only an empty
room-wide retained log uses `history_log_id: null`.

After advancing F, re-announce full room metadata to all authenticated clients. Attach both wire boundaries atomically with each history page's query snapshot; do not return entries evaluated under an older floor with a newer response floor. Capture response state synchronously without external awaits. Keep F monotonic on clients even if paginated responses arrive out of order.

### History queries

Follow protocol section 5.1: inclusive after/before, forward oldest selection when after is present, backward newest otherwise, always return selected entries ascending. Query only the intersection with `[F, latest_log_id]`. An entirely expired range returns an empty result with F; do not invent pagination IDs. No compaction is required for this version.

Apply room/thread filters before the source-slice limit. With a byte cap, shrink the effective positive limit before selecting the final contiguous slice in the requested direction. Return its true first_id/last_id and more, accounting for entries omitted due to either count or byte cap. Each allowed snapshot must fit into at least one response with envelope overhead. Forward continuation is last_id+1, backward continuation first_id-1; never use string ordering or message IDs for pagination.

Thread history matches a transition if its before OR after membership equals the requested thread. A departure's snapshot carries the new membership. Unknown thread IDs are invalid_params; known empty threads return empty pages. A historical root message expiring does not make an existing thread unknown.

### Client recovery

The implementing harness must add this behavior to the demo client:

1. Track the greatest advertised F per room. Remove cached snapshots whose greatest applied log ID is below F; remove expired pending rendering references. Preserve newer snapshots even when their message creation IDs are old.
2. A checkpoint C is usable for forward recovery only when `C + 1 >= F`. If `C + 1 < F`, some uncovered transitions were discarded: clear that scope's recovered state/checkpoint and rebuild from F. This handles the exact boundary without needless resets at `C = F - 1`.
3. Capture head H when establishing live delivery. Recover forward through fixed H, buffer live entries above H, apply newer snapshots only, then drain the buffer. If F>H, the retained initial view is empty and subsequent live entries can proceed.
4. Before applying each page, inspect its F. If retention has overtaken the next unprocessed recovery position, discard the partial history replay and rebuild against the new floor while preserving the fixed head H and retained live entries buffered above it. Do not mark a silently truncated gap as recovered. Cancel or ignore obsolete in-flight requests by a local recovery generation.
5. An increased floor within already processed coverage need not restart recovery, but must evict newly expired snapshots. Bound live/recovery buffers (1 MiB or 1,000 entries); on overflow, clear partial recovery and reconnect/recover with backoff.
6. Room and thread checkpoints remain independent. Filtered recovery cannot advance the room checkpoint. Eviction and asynchronous older pages must never resurrect snapshots below the current floor or overwrite a newer snapshot.
7. Metadata re-announcements do not advance checkpoints or replace an active fixed recovery head by themselves. The floor only invalidates unavailable history.

Update clients to the base-protocol fields; clients using the previous wire contract are not guaranteed correct recovery. Include a visible demo notice that only roughly the last day is retained.

### Cleanup algorithm and failure recovery

Use a single scheduler backed by the DO alarm API. Due cleanup fixes a cutoff (`effective_now - 24h`) and identifies an expired log prefix with indexed, bounded work. Persist logical floor advancement and a cleanup job before discarding its rows. Publish floor changes in commit order. If discovering the prefix requires several batches, advance the floor incrementally; each visible floor must match actual logical coverage.

Delete expired transitions, unreferenced expired current states, expired accepted-request entries, and expired limiter state in separately bounded, metered batches. Retained latest snapshots and necessary current state must not be accidentally removed with an older version of the same message. Never reset room head, floor, credentials, or live quota counters. A next task is scheduled until the job completes; ordinary cleanup starts hourly, continuation wakes only as needed and within the budget.

Retries are idempotent and work from persisted progress. A crash before or after any batch must preserve externally advertised coverage. If maintenance budget is exhausted, defer physical work until resources reset, suspend growth as needed, and do not spin alarms. Alarm/API failures must not permanently orphan cleanup: re-establish missing due work on subsequent valid activity as well as documented alarm retries. No live socket is needed to perform cleanup.

Use the same scheduler for unauthenticated socket deadlines, batching deadlines where possible; every alarm setup/invocation is accounted. Alarms are at-least-once and retries are finite: [Alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/).

## 10. Degradation and public-demo behavior

| Exhausted resource | Required behavior |
| --- | --- |
| Principal posting limit | Reject new mutations with retry_after; allow affordable reads |
| Global daily posting/foreground write budget | Read-only until replenished; matching dedup retries may return stored results |
| Read/history budget | Reject history; do not fake an empty successful history page |
| Registration count/durable identity cap | Stop registration; existing logins and anonymous use continue if affordable |
| Storage high-water | Stop growth, clean expired data using reserve, resume only when safe |
| Socket/admission cap | Reject upgrade; existing sockets continue if affordable |
| Global frame budget | Stop processing new application work, close sockets, reject admissions until reset |
| Cloudflare hard limit or uncertain accounting | Fail closed; no automatic paid fallback |

Compute retry delay from the limiting window where known; when multiple limits apply, use the longest applicable delay. Capacity/storage retries may use a documented backoff estimate, not a false guarantee of future availability. Persist an optional operator-configured admission-off flag; it must not require migrating or deleting the object.

For a permanent policy cap with no automatic replenishment, such as the identity or thread-record ceiling, use `denied` with an explanatory reason such as `registration_closed` or `thread_limit`; do not induce endless retries with an invented reset time. The operator can raise a policy ceiling only after reassessing the resource budget.

Keep UI messages concrete: "Anonymous posting limit reached", "Demo is read-only until daily reset", "History temporarily unavailable", or "Demo capacity reached". No billing/SQL details in normal user flows. Do not silently drop a successful write, alter user content, or hide an error as success.

Support a standalone `ALLOWED_ORIGINS = "*"` to admit every guest origin, including opaque origins. Exact allowlist deployments reject unexpected browser origins before upgrade. Require explicit exact RP origins for WebAuthn even under wildcard guest admission; advertise WebAuthn only to connections from those origins. Non-browser clients with no Origin may use the public protocol subject to the same quotas; origin checking is not bot authentication. Reuse the existing Markdown sanitization and iframe restrictions. No backend URL fetching from embeds. Secrets never enter logs, public status responses, or source control.

Limit observability to bounded structured events and counters: operation category, accepted/rejected reason, daily resource reservations/actuals, active sockets, database bytes, oldest retained commit, floor/head, cleanup backlog, and alarm failures. Sample repetitive rejection logs and never persist request bodies, passkey challenges, or raw IPs to analytics.

## 11. Required verification

Use unit tests for pure logic and Cloudflare's Workers/Vitest integration for runtime storage, WebSocket, and alarm behavior: [testing documentation](https://developers.cloudflare.com/workers/testing/vitest-integration/). Use a fake clock for deterministic policy tests. Confirm how the selected runtime version simulates hibernation; do not label a normal reconnect test as a hibernation test.

### Protocol and sequencing

- Minimal/JSON-RPC envelopes; valid/invalid IDs; parse failures; notifications without replies; unknown method/field behavior.
- Server precedes auth; room precedes live messages; pipelined slow auth then message cannot overtake authentication.
- Equal-millisecond and backward-clock creates/edits strictly increase IDs; head survives empty-log cleanup/restart.
- Concurrent sockets mutating the same room produce one ordered stream. Author spoofing fails. Edit/delete/restore follow replacement semantics and ownership.
- Message extensions, embeds, tombstones, and immutable fields survive storage/replay correctly.
- Same-ID retries with reordered object keys or different jsonrpc presence have one effect and broadcast; conflicting params are rejected. Parallel duplicates, lost reply, and restart recovery are covered.
- A retained accepted retry returns its original result despite a newly exhausted posting quota or expired message. Auth is never skipped by dedup.
- Inject failures before commit, after commit/before reply, and during fan-out. No broadcast of uncommitted data or silent stream gaps.

### History and retention

- Forward/backward inclusive bounds, numeric ordering, byte-limited contiguous pages, exact more/first/last behavior, empty ranges, and unknown/empty threads.
- Concurrent history/live delivery around captured H has no missing transition; per-scope checkpoints are not confused.
- Fake-clock advance: nothing younger than cutoff expires; hourly cleanup yields the intended approximate window. Same room ID/head persists.
- Recent edit of an old creation, recent tombstone, thread arrival/departure, restoration, and before/after membership survive trimming.
- Unused and fully expired rooms report `history_log_id: null`; an expired room preserves its nonzero `latest_log_id`. Internally F=head+1 and the next creation is newer. Empty filtered pages retain the room-wide non-null boundary when history remains. Both fields are captured with every page. No accidental reset to zero or giant integer/string comparison bug.
- Client with C<F-1 rebuilds; C=F-1 resumes safely. Floor advancement during pagination, delayed older pages, and out-of-order replies cannot resurrect old state or create a checkpoint gap.
- Cleanup after latest-message update never removes its retained snapshot. Crash/retry at every batch boundary preserves logical floor visibility. Work continues without connected clients.
- Budget exhaustion delays physical cleanup safely; storage pressure blocks growth. Dedup expiry remains independent of transitions; credential/limiter state survives.

### Auth and abuse controls

- Anonymous sixth mutation within 60 seconds fails across tabs/reconnects; five can be accepted when timestamps permit. Test the calendar-minute boundary explicitly.
- Registered twenty-first mutation fails; several credentials at one IP cannot exceed aggregate IP limits. Failed/unverified WebAuthn cannot raise a tier.
- IPv4, mapped IPv6, equivalent textual forms, /64 rotation, spoofed forwarding fields, and missing trusted metadata behave as specified.
- WebAuthn wrong challenge, replay, expired challenge, wrong connection/action/origin/RP, bad signature, missing UV, duplicate credential, and unsupported oversized metadata are rejected.
- Registration races enforce global/IP/count limits; existing passkey login works when registration is full. Real browser or virtual-authenticator end-to-end registration/login complements verifier unit fixtures.
- Frame, connection, auth, history, registration, global posting, and byte/depth limits are independent and survive hibernation/restart as applicable.
- Unicode byte boundaries, escaped JSON, many tiny fields, binary input, invalid JSON, notifications, and oversized WebSocket messages cause bounded processing and correct close/error behavior.
- Exhaustion cannot be bypassed by deleting cookies, changing request IDs, reconnecting, upgrading guest auth, or client-supplied claims. Unique denied identities do not grow tables indefinitely.

### Capacity, accounting, and lifecycle

- Measure rows read/written per operation with the actual indexes, including quota writes, auth, alarms, failure paths, and deletion. Produce a cost table and test every claimed upper bound.
- Exercise at least three simulated UTC days: accepted traffic plus previous-day cleanup, midnight double bursts, worst-case snapshots, frequent edits, reconnect/history load, and invalid traffic. A 24–25 hour retention interval can span two daily posting allowances; never assume it contains at most 5,000 transitions.
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
3. Add edit/thread support, rolling retention, base-protocol availability boundaries, and client recovery changes.
4. Add verified passkey registration/login and minimal client UI. Anonymous operation remains available.
5. Add maintenance/admission degradation, capacity tests, and operating documentation. Run the acceptance tests and review the full schema's cost model.

Deliver:

- Working source and lockfile; no placeholder auth or quota bypasses.
- Wrangler config with a fixed DO binding, SQLite migration, tested compatibility date, and no paid-service bindings.
- Configuration reference for every limit, RP ID/origins, account analytics, and feature toggles. Fail startup/config validation for impossible or unsafe relationships.
- Base-protocol history documentation and minimal client integration, including retention recovery fixtures and canonical WebAuthn fixtures.
- Automated tests, local dev commands, a bounded load/cost report, and a concise implementation summary.
- README describing Free-plan prerequisites, anonymous identity limitations, rolling history with a permanent room ID, quota exhaustion/recovery, secret setup, and manual deployment steps.
- A deployment checklist that verifies the real account plan and other workload usage, rechecks current platform quotas, applies migrations once, and tests the deployed hibernation/reconnect path when deployment is separately authorized.

Done means the integrated demo satisfies the protocol contract and failure cases above, with measured resource accounting and an honest zero-overage/availability distinction. It must not merely return correct messages while leaving cleanup, passkey verification, restart-safe limits, or retention-aware recovery as TODOs.
