# Bottomless Chat Protocol

A chat frontend/backend protocol over a single WebSocket, designed so that a
minimal conforming backend ("Level 0") is implementable in under ~100 lines in
any language, and every feature beyond the core is an independently optional
capability. Frontends MUST degrade gracefully in the absence of any capability.

Terminology per RFC 2119. "Server" = the WebSocket backend. "Client" = the chat
frontend.

---

## 1. Transport & framing

- One WebSocket connection. Each WebSocket text message contains exactly one JSON
  object (a **frame**). No batching, no newline-delimited streams.
- The RECOMMENDED envelope follows [JSON-RPC 2.0](https://www.jsonrpc.org/specification),
  with §1.1 extensions. Receivers MUST accept omitted `jsonrpc` and request
  `id`. Omitted `jsonrpc` is an Apron extension to JSON-RPC 2.0.
- **Calls** have a string `method` and an object `params` (omission means `{}`).
  Method-specific fields reside in `params`. Frame names denote methods.
- A call with `id` is a **request**; its reply echoes `id` and contains exactly
  one of `result` or `error`. A call without `id` is a **notification** and
  MUST NOT receive a reply, including on failure; method side effects still apply.
- Requests MAY be pipelined; the server processes them in order but MAY reply
  out of order. Server announcements and broadcasts are notifications.
- Unknown methods: servers reply `error/unsupported` to requests and ignore
  notifications; clients ignore unknown notifications. Unknown *fields* in
  known methods MUST be ignored by both sides.
- Frame size: implementations SHOULD accept frames up to 256 KiB and MAY
  reject larger requests with `error/too_large`; oversized notifications may
  be dropped without a reply. The limit is advisory, not a conformance requirement.
- Liveness rides on WebSocket ping/pong at the transport layer. There is no
  application-level heartbeat; do not invent one.

### 1.1 Envelope and replies

`jsonrpc`, when present, MUST be `"2.0"`; senders SHOULD include it. Request
`id`, when present, MUST be a string (§2). Clients SHOULD include `id` for
result correlation or retries, including `auth`, `history`, and mutations.
Notifications omit `id`; event/update log IDs reside in `params`.

```json
→ {"jsonrpc": "2.0", "method": "send", "id": "c42",
   "params": {"room": "general", "body": {"text": "hello", "format": "plain"}}}
← {"jsonrpc": "2.0", "id": "c42", "result": {"event_id": "1724803200042"}}
```

A notification may omit both optional keys:

```json
{"method": "send", "params": {"room": "general", "body": {"text": "hello", "format": "plain"}}}
```

Success returns a `result` object (`{}` if empty). Errors contain integer
`code`, string `message`, and optional `data`:

```json
{"jsonrpc": "2.0", "id": "c42", "error": {"code": -32601, "message": "Unsupported method"}}
{"jsonrpc": "2.0", "id": "c43", "error": {"code": -32002, "message": "Try later", "data": {"ms": 1000}}}
```

`error/<name>` denotes the following numeric codes:

| code   | name             | meaning                                      |
|--------|------------------|----------------------------------------------|
| -32700 | `parse_error`    | invalid JSON                                 |
| -32600 | `invalid_request` | invalid envelope                            |
| -32601 | `unsupported`    | method/capability not implemented            |
| -32602 | `invalid_params` | invalid method parameters                    |
| -32603 | `internal_error` | internal server error                        |
| -32001 | `denied`         | authentication/authorization failure         |
| -32002 | `retry_after`    | rate limited; `data.ms` is an integer delay   |
| -32003 | `too_large`      | message too large                            |

Other application errors MAY use non-reserved JSON-RPC codes. Parse errors
and invalid envelopes whose request ID cannot be determined use `id: null`,
as in JSON-RPC; this is the sole exception to string IDs. Valid notifications
still receive no error replies. Examples below omit `jsonrpc` for brevity.

### 1.2 Retries and recommended deduplication

Retries SHOULD preserve `id`, `method`, and `params` across reconnects. New
operations, including changed parameters, MUST use new IDs. Deduplication
ignores `jsonrpc` presence and object key order.

Servers SHOULD deduplicate by `(authenticated sender, id)`, return the original
result for accepted duplicates without re-execution or rebroadcast, reject
conflicting methods/parameters with `invalid_params`, and coalesce concurrent
duplicates.

Retention and persistence across reconnects/restarts are implementation-defined.
Request IDs may be stored with accepted operations; no additional handshake or
capability is required. Pre-authentication IDs are connection-scoped;
authentication MUST execute on each connection.

Servers MAY re-execute retries with fresh log IDs. Duplicates are allowed;
clients MUST NOT assume exactly-once delivery. Notifications have no
request-level deduplication.

---

## 2. Identifiers (mandatory)

All IDs on the wire are **strings**, except the `null` response ID used for
unidentifiable invalid requests (§1.1). They come in two flavors:

**Log IDs** (event IDs and update IDs) are strings of decimal digits encoding
`unix_seconds * 1000 + counter`, where `counter` is a per-second sequence
(0–999) — e.g. `"1724803200042"`. Servers MUST guarantee log IDs are
**strictly monotonic per room** across events *and* updates, which share one
sequence (a `max(last+1, now_ms)` ratchet suffices; >1000 entries/sec borrows
into the next second, and backward clock steps are absorbed).
`"0"` is reserved for the empty-log boundary; entries MUST use positive IDs.

- Comparison is numeric (or equivalently, as strings after zero-padding —
  raw ms timestamps are 13 digits until the year 2286). Values fit exactly in
  float64 (< 2^53), so clients MAY parse them as integers for window
  arithmetic.
- Log IDs are *not* opaque: clients MAY derive timestamps from them, sort by
  them, and construct history windows arithmetically. There is no separate
  timestamp field.
- Ordering within a room is by log ID. Cross-room ordering is approximate.
  On a live connection, servers MUST deliver a room's entries (`event` and
  `update` frames) in ascending log-ID order.
- Log IDs are unique only within a room on a single server. Clients
  aggregating multiple servers MUST key entries by
  *(connection, room, log_id)*; two servers are two clocks and WILL collide.

**Opaque IDs** (rooms, threads, sessions, sender IDs, client request `id`s)
are arbitrary strings chosen by whichever side mints them. Servers SHOULD
prefix them by type — `t_` for threads, `call_` for RTC sessions, etc. — to
keep IDs self-describing in logs and impossible to confuse across kinds.
Client request `id`s SHOULD be randomly generated to avoid collisions across
devices and connections, including devices authenticated as the same sender.
A retry reuses the original ID (§1.2); reconnecting does not change that ID.
Request IDs identify operations, not positions in the server's room log.

---

## 3. Level 0 — mandatory core

A Level 0 server implements this section and nothing else. All Level ≥1
features are advertised capabilities (§4); their absence is signaled by
omission from `caps` and/or `error/unsupported`.

### 3.1 `server` frame

Upon accepting a connection, the server MUST immediately send a `server` frame,
unprompted. There is no client hello.

```json
{
  "method": "server",
  "params": {
    "protocol": 2,
    "name": "impl-name/1.0",
    "caps": ["history", "typing", "upload"],
    "auth": ["token"],
    "upload": "https://example/upload"
  }
}
```

- `protocol`: integer. Current value `2` replaces mandatory compacted backfill
  with replayable history (§5.1), a frozen-contract change under §8. Version `1`
  introduced the JSON-RPC envelope; version `0` used `type`.
- `caps`: capability identifiers (§4). MAY be empty.
- `auth`: supported auth methods (§3.2), in server preference order.
- `upload`: present iff cap `upload` (§6.1).

The server MAY send a new `server` frame at any time; each **fully replaces**
the previous (no merging). On receipt, clients re-evaluate feature UI but MUST
NOT retroactively un-render existing content. After replying
`error/unsupported`, servers SHOULD follow with a fresh `server` frame.

### 3.2 Authentication

```json
→ {"method": "auth", "id": "c1", "params": {"method": "token", "token": "...", "client": "bottomless-web/0.3"}}
← {"id": "c1", "result": {"you": {"id": "alice", "name": "Alice"}}}
```

Methods:

- `anonymous` — no credentials; server assigns identity. Legal and expected in
  trusted deployments.
- `token` — bearer string. The reference default.
- `webauthn` — two-round-trip challenge: `auth(params.method=webauthn)` →
  `result` carrying `challenge` → `auth` carrying the assertion → final `result`.
  Details deferred to a companion doc; cap-gated as `auth.webauthn`.

A server MUST support at least one method. `client` is an optional free-form
implementation/version string for debugging. Clients MAY pipeline `auth`
before `server` arrives. All other requests before successful auth get
`denied`; unauthenticated notifications other than `auth` are ignored.
An `auth` notification can authenticate the connection, but returns no `you`
or challenge, so clients SHOULD use a request when they need those results.

### 3.3 Identity

Identity is server-authoritative and **denormalized**: every event carries its
sender inline. There is no user directory and no profile state.

```json
"sender": {"id": "alice", "name": "Alice", "avatar": "https://..."}
```

`id` is stable; `name`/`avatar` are advisory display data, current as of that
event. Rename request (server MAY comply, decline, or alter):

```json
→ {"method": "nick", "id": "c2", "params": {"name": "Alice ⚙"}}
```

Bots and agents are ordinary senders; nothing distinguishes them at the
protocol level.

### 3.4 Rooms

Rooms have server-chosen string IDs. The server announces each room the client
can see (at minimum, once after auth):

```json
{"method": "room", "params": {
  "room": "general", "name": "General", "topic": "optional", "latest_id": "1724803200042"
}}
```

Re-sending a `room` frame updates its metadata. Servers MUST announce a room
before delivering any entry in it. A Level 0 server announces one room and
never revisits the subject. Join/leave/create are cap `rooms.manage` (§6.3).

`latest_id` is the maximum committed room log ID, including events and updates;
`"0"` denotes an empty log. It is REQUIRED on room announcements when `history`
is supported, OPTIONAL otherwise. For history-enabled rooms, the first
announcement after auth MUST establish `latest_id` and live delivery at one
serialization point: transitions through `latest_id` are recoverable via history
(raw or equivalent rasters), and subsequent entries MUST be delivered live in
log order. No commit may fall between these paths. Re-announcements report the
current head but MUST NOT advance client checkpoints or replace an active
recovery bound (§5.1).

### 3.5 Messages

Send:

```json
→ {
  "method": "send",
  "id": "c3",
  "params": {"room": "general", "body": {"text": "hello *world*", "format": "markdown"}}
}
← {"id": "c3", "result": {"event_id": "1724803200042"}}
```

Broadcast (to all clients in the room, including the sender):

```json
{
  "method": "event",
  "params": {
    "room": "general",
    "echo": "c3",
    "event": {
      "event_id": "1724803200042",
      "sender": {"id": "alice", "name": "Alice"},
      "body": {"text": "hello *world*", "format": "markdown"}
    }
  }
}
```

- `body.format` ∈ `"plain" | "markdown"`. Both are mandatory to render;
  `markdown` is the expected default (CommonMark; fenced code blocks with
  language-tagged syntax highlighting are the baseline rich-content path).
  Renderers SHOULD disable raw inline HTML passthrough — CommonMark permits it
  by default, and enabling it reopens the sanitization hole that §6.4
  deliberately closes.
- **Echo:** the broadcast `event` for a client-originated `send` with `id`
  carries `params.echo` = the originating request `id`. Omit `echo` for sends
  without `id`. Clients match `echo` against their own pending sends to
  reconcile local echo. Servers MAY include it on all copies of the broadcast;
  clients MUST ignore values that do not match their own pending requests.
  Echo is correlation, not a duplicate-prevention guarantee. A server following
  §1.2 returns the original `event_id` in its result for a recognized retry,
  without a second broadcast; clients MUST also accept that result as
  confirmation.
  Otherwise, retries MAY create multiple events with different `event_id`s.
- Clients additionally dedup on `event_id`.
- `body.attachments` and `body.embeds`: see §6. **Clients MUST render entries
  of unknown `kind` as a labeled fallback card** (kind name + `url` if
  present). This rule is core; it is the forward-compatibility hook for future
  typed embeds.

The event object's defined fields (`event_id` is immutable; other unknown keys
are retained during replay and ignored by renderers):

| field       | set by                  | meaning                          |
|-------------|-------------------------|----------------------------------|
| `event_id`  | server, at creation     | log ID (§2)                      |
| `sender`    | server, at creation     | inline identity (§3.3)           |
| `body`      | sender; mutable         | `text`, `format`, `attachments`, `embeds` |
| `thread`    | server or `update`      | thread ID (§6.2)                 |
| `edited`    | `update`                | convention: true after body edits |
| `redacted`  | `update`                | tombstone marker (§5.3)          |

Fields a client supplies on `send` (`body`, and `thread` when replying in a
thread) sit in **`send.params`**, alongside `room`; the server copies them
into the event object it creates.

### 3.6 Level 0 conformance checklist

Accept connection → emit `server` → accept one `auth` method → emit ≥1 `room`
→ accept `send`, return a `result` for requests, broadcast `event` with
conforming IDs → reply `error/unsupported` to other requests and ignore unknown
notifications. Accept omission of `jsonrpc` and `id` as specified in §1;
deduplication is recommended, not required. That is the entire Level 0 surface.

### 3.7 A complete Level 0 session

```json
← {"method": "server", "params": {"protocol": 2, "name": "demo/1", "caps": [], "auth": ["token"]}}
→ {"method": "auth", "id": "a", "params": {"method": "token", "token": "hunter2"}}
← {"id": "a", "result": {"you": {"id": "alice", "name": "Alice"}}}
← {"method": "room", "params": {"room": "general", "name": "General"}}
→ {"method": "send", "id": "b", "params": {"room": "general", "body": {"text": "hi", "format": "markdown"}}}
← {"id": "b", "result": {"event_id": "1724803200000"}}
← {
  "method": "event",
  "params": {
    "room": "general",
    "echo": "b",
    "event": {
      "event_id": "1724803200000",
      "sender": {"id": "alice", "name": "Alice"},
      "body": {"text": "hi", "format": "markdown"}
    }
  }
}
→ {"method": "history", "id": "c", "params": {"room": "general", "limit": 50}}
← {"id": "c", "error": {"code": -32601, "message": "Unsupported method"}}
```

Every conforming implementation, at any level, produces a superset of this
exchange.

---

## 4. Capabilities

Capability identifiers are flat strings, dot-namespaced by convention. The
client learns them only from `server` frames. Absence of a cap obligates the
client to a defined fallback:

| cap            | fallback behavior                              |
|----------------|------------------------------------------------|
| `history`      | session-only scrollback; divider on reconnect  |
| `typing`       | no indicators                                  |
| `edit`         | edit UI hidden                                 |
| `redact`       | delete UI hidden                               |
| `threads`      | flat message list                              |
| `rooms.manage` | fixed room list                                |
| `upload`       | attach button disabled                         |
| `embed.iframe` | fallback card                                  |
| `embed.html`   | fallback card                                  |
| `push`         | no mobile wake-ups                             |
| `auth.webauthn`| other auth methods only                        |

---

## 5. Level 1 capabilities

### 5.1 `history`

Stateless window query over the room's **append-only transition log**. Events
and updates (§5.3) share one ID sequence (§2). Frontends MUST support complete
transition replay. Servers MAY return raw transitions or equivalent rastered
transitions (complete event snapshots); no capability negotiation is required.
A raw implementation only slices the log. Compaction is optional.

```json
→ {
  "method": "history",
  "id": "c9",
  "params": {"room": "general", "after": "1724803200000", "before": "1724806800000", "limit": 200}
}
← {"id": "c9", "result": {
  "entries": [...], "first_id": "1724803200000", "last_id": "1724803200199", "more": true
}}
```

Bounds and ordering:

- `after`/`before` are **inclusive transition-ID bounds**; either MAY be
  omitted. They select transitions, not event creation dates or current state.
- Select a contiguous source-log slice within the bounds. `limit` is a positive
  source-entry count, applied **before compaction**; servers MAY clamp it to a
  positive value. An omitted limit uses a server default. With `after`, select
  the oldest entries; otherwise select the newest entries.
- `first_id`/`last_id` are the first/last IDs of that source slice, before
  compaction. Return both for nonempty slices; omit both for an empty slice.
  `more` indicates additional source entries in the selected direction within
  the requested bounds. Empty slices return `entries: []` and `more: false`.
- Forward continuation uses `after = last_id + 1`; backward continuation uses
  `before = first_id - 1`. Preserve the opposite bound. Arithmetic is numeric;
  encode the result as a string. Never derive continuation from compacted entries.
- `entries` are always ascending by transition ID: `event_id` for creation,
  `update_id` for mutation. Pages may mix raw and rastered transitions; their
  representation is independent of query direction.

**Optional rastering.** For each target touched by a source slice, a server MAY
replace its selected transitions with one complete snapshot at that target's
last transition in the slice. If that transition is a creation, return the
original event object. Otherwise return an update with `replace` instead of
`set`:

```json
{"update_id": "1724803312007", "target": "1724803200042", "replace": {
  "event_id": "1724803200042", "sender": {"id": "alice", "name": "Alice"},
  "body": {"text": "hello world", "format": "plain"}, "edited": true
}}
```

`replace` MUST equal the complete event state after replay through `update_id`,
including unknown fields and deletions. It MUST NOT incorporate later updates.
`replace.event_id` MUST equal `target`. The update ID is the existing last
source transition for that target, not a newly allocated ID. Omitted transitions
remain covered by `first_id`/`last_id`. Raw and rastered replies MUST yield the
same terminal event state when applied to the source slice's preceding state.
Replay equivalence concerns stored event state, not intermediate rendering.

**Replay.** Clients MUST support ordered transition replay: creations insert
events, `set` applies merge patch, and `replace` installs complete event state
whether or not the target is loaded. Clients loading partial history MUST
obtain the dependencies required for correct replay. Caching, eviction,
unknown-target handling, and replay scheduling are implementation-defined.

Naive recovery:

1. Capture `H = room.latest_id`; buffer live transitions above `H`.
2. From empty state, page forward from `after: "0"` through `before: H`.
   With state checkpointed through `C`, resume at `after: C+1` instead.
3. Replay pages in order until `more: false`, then apply buffered live entries.

Checkpoints MUST represent processed source-log coverage and corresponding
recoverable client state. Neither an announced head, a received live maximum,
nor a per-event snapshot alone establishes a room checkpoint. Interrupted
recovery resumes from the last valid checkpoint.

Recovery boundary example:

```json
← {"method": "room", "params": {"room": "general", "name": "General", "latest_id": "1724803200120"}}
→ {"method": "history", "id": "recover1", "params": {
  "room": "general", "after": "1724803200101", "before": "1724803200120"
}}
```

Recovery adds no handshake round trip or server-held cursor.

Reference storage: an append-only list per room; history returns bounded slices.
An optimizing server may fold target state through a selected update ID to emit
rasters. A current-state map is usable only if it represents that revision.

### 5.2 `typing`

Fire-and-forget ephemera sent as notifications (omit `id`); no replies,
servers MAY drop freely.

```json
→ {"method": "typing", "params": {"room": "general", "active": true, "timeout": 8}}
← {
  "method": "typing",
  "params": {"room": "general", "sender": {...}, "active": true, "timeout": 8}
}
```

`timeout` (optional, seconds) is how long the indicator should persist without
refresh; clients expire remote typing state after `timeout`, defaulting to 10s
when absent. There is deliberately no presence system in this spec.

### 5.3 `edit`, `redact` — and the `update` frame

All retroactive mutation uses one server→client frame. Updates consume room
log IDs (§2) and appear in history (§5.1), raw or represented by rasters.
Frontend update/replay support is mandatory regardless of mutation capabilities.

```json
{
  "method": "update",
  "params": {
    "room": "general",
    "update_id": "1724803312007",
    "target": "1724803200042",
    "set": {"body": {"text": "hello world", "format": "plain"}, "edited": true}
  }
}
```

Client rule: replay `set` on event `target` using **JSON Merge Patch semantics
(RFC 7386)**: recursively merge objects, replace other values, and delete keys
whose patch value is `null`. `set` MUST be an object; `event_id` MUST NOT be
changed or deleted.
History rasters use `replace` for full-object replacement, not merge patch;
an update contains exactly one of `set` or `replace`. Live updates and client
`update_request`s use `set`. Partial-history replay follows §5.1.
Re-render after reduction. Servers MAY update any event, including ones
predating the connection; the same mechanism covers edits, redaction,
re-threading (§6.2), and future state mutations.

Client-initiated mutation is one request frame mirroring the server frame:

```json
→ {
  "method": "update_request",
  "id": "c12",
  "params": {"room": "general", "target": "1724803200042", "set": {"body": {"text": "hello world", "format": "plain"}}}
}
← {"id": "c12", "result": {"update_id": "1724803312007"}}
```

The server validates which keys this sender may touch on this target
(policy is entirely server-defined), replies with `result` or `error/denied`
when `id` is present, and on success broadcasts the resulting `update`
(the broadcast is authoritative and MAY differ from the request).
Capabilities `edit` and `redact` gate client UI
only; both use `update_request`.

**Redaction is an ordinary update.** A delete request is
`update_request` with `"set": {"redacted": true}`; the server SHOULD
broadcast (and store) it as
`"set": {"redacted": true, "body": null, "attachments": null, "embeds": null}` —
merge-patch `null` deletion strips the reduced event state. Raw replay may
still contain earlier content; rastered state after redaction omits it.
Clients render redacted events as tombstones. Content and media retention
policies are implementation-defined.

---

## 6. Level 2 capabilities

### 6.1 `upload`

Media travels over HTTP, not the socket. The client POSTs
`multipart/form-data` to the `upload` URL from the `server` frame, receiving
`{"url": "..."}`; it then references the URL:

```json
"body": {"text": "look:", "format": "markdown",
         "attachments": [{"kind": "image", "url": "...", "mime": "image/png", "w": 800, "h": 600}]}
```

Upload authentication: with `token` auth, the same token as bearer. With
other methods there is no reusable credential, so the server SHOULD re-send
the `server` frame after auth carrying a per-session `upload` URL (capability
re-announcement, §3.1 — no new machinery).

Attachment kinds: `image`, `video`, `audio`, `file` (with `name`, `size`).
Unknown kinds → fallback card rule (§3.5).

### 6.2 `threads`

`thread` is an optional field on events: an opaque string thread ID
(recommended prefix `t_`, per §2). Thread metadata is its own re-sendable
frame:

```json
{
  "method": "thread",
  "params": {
    "room": "general",
    "thread": "t_deploy",
    "name": "Deploy discussion",
    "summary": "Debugging the 4pm outage",
    "root": "1724801100007"
  }
}
```

`root` is optional advisory metadata (the event the thread grew from), not a
protocol mechanism.

Threading is server-authoritative and retroactive: moving an event into a
thread is `update` with `"set": {"thread": "t_deploy"}`; removing it is
`"set": {"thread": null}` (merge-patch deletion). A moderator agent
re-threading a message group emits N `update`s plus a `thread` frame carrying
its summary. Clients MUST re-home moved messages without treating them as
deleted, and SHOULD indicate the move at the message's original position.

Client participation reuses existing frames — no thread-specific requests
exist:

- **Reply in a thread:** `send` with `"thread": "t_deploy"` in `params` (an
  existing thread ID; see the field-placement rule in §3.5).
- **Propose a new thread:** `update_request` on the intended root event with
  `"set": {"thread": "t_<random>"}`, a fresh client-generated ID. The server
  accepts (broadcasting the `update` and an authoritative `thread` metadata
  frame) or replies `denied`. The `thread` field is always a string; there is
  no root-reference form.

### 6.3 `rooms.manage`

```json
→ {"method": "room_create", "id": "c20", "params": {"name": "Ops"}}
→ {"method": "room_join", "id": "c21", "params": {"room": "ops"}}
→ {"method": "room_leave", "id": "c22", "params": {"room": "ops"}}
```

Server confirms requests with `result: {}` and emits the corresponding `room`
notification. Visibility and membership policy are entirely server-defined.

### 6.4 `embed.iframe`, `embed.html`

Embeds are `body.embeds` entries.

```json
{"kind": "iframe", "url": "https://backend:8443/term/abc", "h": 300}
{"kind": "html", "html": "<table>…</table>"}
```

- `iframe`: clients MUST render with
  `sandbox="allow-scripts"` — **never** `allow-same-origin` together with
  `allow-scripts` — no top-navigation or popups, a restrictive
  Permissions-Policy, clamped dimensions (`h` is a suggestion), lazy loading
  offscreen, and a cap on concurrently-live iframes. Intended use: the backend
  serves live views (streaming terminals, dashboards) adjacent to its socket.
- `html`: clients MUST sanitize with an allowlist sanitizer (e.g. DOMPurify)
  before insertion, regardless of source. Servers make no safety promises and
  clients extend no trust; the trusted-deployment assumption does not cover
  content flowing *through* backends.
- Typed embeds (`diff`, `poll`, …) are future capabilities; until then such
  kinds hit the fallback-card rule, which is what makes them additive.

### 6.5 `push`

UnifiedPush-shaped registration; the client supplies an HTTPS endpoint owned
by its push relay:

```json
→ {
  "method": "push_register",
  "id": "c30",
  "params": {"endpoint": "https://relay.example/p/xyz", "token": "..."}
}
→ {"method": "push_unregister", "id": "c31", "params": {"endpoint": "https://relay.example/p/xyz"}}
```

When the user should be woken while disconnected, the server POSTs JSON
`{room, event_id, sender_name, preview}` to the endpoint with the token as
bearer. Delivery beyond that POST (APNs/FCM, coalescing) is the relay's
concern. Wake policy (mentions, all messages) is server-defined for now.

Note: registered endpoints are client-supplied URLs the server will POST to —
an SSRF vector into the server's network. Servers SHOULD accept only `https`
endpoints resolving to non-internal addresses.

---

## 7. Conformance

A conformance harness (companion to this spec) connects to a backend and
verifies, per level: envelope shape with and without `jsonrpc`; request/result
correlation and notification behavior without `id`; `server` frame timing and
shape; auth flows; log-ID monotonicity (across events and updates) and
digit-string encoding under
burst load; `send`/`event` round-trip including `echo` when a request ID is
present and its omission otherwise; per-cap behavior
including RFC 7386 merge semantics, raw/rastered replay equivalence (including
nested object resets and deletions), source-span
pagination with `limit: 1`, `room.latest_id` (including update-only and empty
logs), gap-free history/live boundaries, and `unsupported` responses for
undeclared caps. Client recovery checks include interleaved live traffic and
disconnects between history pages; checkpoints MUST NOT skip unprocessed entries.
Retry deduplication is recommended only; accepting duplicates MUST NOT fail
conformance. If tested, deduplication checks include returning the original
result without rebroadcasting a recognized duplicate.
**Passing the harness, not matching this prose, is the definition of
conformance.** The harness plus a Level 0 reference backend (~80 lines,
Python/`websockets`) ship with the spec; the acceptance test for this
document is that an LLM given only SPEC.md one-shots a Level 0 backend that
passes.

## 8. Design commitments (frozen)

Changing any of these is a `protocol` bump: the frame envelope (§1), the
identifier scheme (§2 — digit-string log IDs on one per-room sequence, opaque
string IDs elsewhere), the unsolicited replaceable `server` frame (§3.1),
inline denormalized senders (§3.3), the RFC 7386 merge-patch `update` rule
(§5.3), the replayable history contract (§5.1 — source spans, raw transitions,
optional equivalent rasters), and the unknown-kind fallback-card rule (§3.5).
Everything else evolves as capabilities.

Additionally reserved: the field name `conn` MUST NOT appear at the top level
of any core frame. It is reserved for the multiplexing envelope (Appendix A),
which is a layer *beneath* this protocol, not a frame field within it.

---

## Appendix A — Multiplexing envelope (informative)

This appendix defines how multiple logical protocol connections share one
physical WebSocket — e.g. a frontend talking to an aggregator/bouncer that
proxies N backends, or a mobile app holding a single socket to a local daemon.
It is **not part of the core protocol**: servers implementing this spec need
no knowledge of it, and a Level 0 backend is unaffected by its existence.

### A.1 Model

A mux endpoint wraps every core-protocol frame in an envelope carrying an
opaque connection ID:

```json
{
  "conn": "b1",
  "frame": {"method": "send", "id": "c3", "params": {"room": "general", "body": {...}}}
}
```

Within each `conn`, the core protocol applies verbatim and in full: per-`conn`
`server` frames, per-`conn` auth and identity, per-`conn` capability sets,
per-`conn` ID monotonicity. The envelope is transparent — a demultiplexer
strips it and hands each inner frame to an ordinary protocol client instance.
Frame ordering is preserved per `conn`; no ordering is guaranteed across
`conn`s.

### A.2 Control frames

Envelope-level control uses unwrapped frames (no `frame` field):

```json
→ {"type": "conn_open", "conn": "b1", "url": "wss://backend.example/ws"}
← {"type": "conn_ready", "conn": "b1"}
← {"type": "conn_error", "conn": "b1", "code": "unreachable", "message": "..."}
← {"type": "conn_close", "conn": "b1"}
→ {"type": "conn_close", "conn": "b1"}
```

- `conn` values are chosen by the opener and are opaque strings, unique per
  physical socket.
- After `conn_ready`, the proxied backend's `server` frame arrives wrapped, as
  the first frame on that `conn` — the connection bootstrap is unchanged.
- `conn_close` from either side terminates the logical connection; the
  aggregator closes the upstream socket.
- Aggregator authentication (who may open conns, to where) is out of scope
  here and deployment-defined.

### A.3 Properties

The aggregator is a dumb pipe: it never parses inner frames, holds no
protocol state beyond the `conn`↔upstream-socket mapping, and adds no trust
surface — the backend remains authoritative end to end, which keeps this layer
compatible with any future end-to-end encryption of frame contents. Client
support is a thin demux shim feeding N unmodified protocol sessions; per §2,
event storage is keyed by *(connection, room, event_id)* regardless of whether
connections arrive muxed or on separate sockets.

---

## Appendix B — Out-of-band channel negotiation: WebRTC (informative)

Planned capability `rtc`, targeted at a future draft. Included here to document
the pattern it instantiates: **the socket is a signaling plane; heavy traffic goes
elsewhere.** The `upload` URL (§6.1) and iframe embeds (§6.4) are prior
instances. Any future out-of-band channel (screenshare, collaborative
documents, file transfer over data channels) should reuse the same three-frame
shape: a session-announce frame with server-authoritative membership, a join
request that vends connection config, and an opaque relay frame. Note that the
core protocol requires zero changes to accommodate this appendix.

### B.1 Sessions

A call is a server-announced, room-scoped session, following the re-sendable
metadata-frame idiom of `room` and `thread`:

```json
← {
  "method": "rtc",
  "params": {
    "room": "general",
    "session": "call_7",
    "kind": "voice",
    "members": [{"id": "alice", "name": "Alice"}],
    "active": true
  }
}
```

Re-sent on membership change; `"active": false` ends the session. Membership
is server-authoritative, not peer gossip.

### B.2 Join / leave

```json
→ {"method": "rtc_join", "id": "c40", "params": {"room": "general", "session": "call_7"}}
← {
  "id": "c40",
  "result": {
    "ice": [{"urls": "stun:stun.example:3478"}, {"urls": "turn:turn.example", "username": "u", "credential": "c"}]
  }
}
→ {"method": "rtc_leave", "id": "c41", "params": {"session": "call_7"}}
```

ICE server configuration is vended at join time (mirroring the `upload` URL
pattern), since TURN credentials are deployment-specific and often
short-lived. Session creation is server-defined; a client MAY request one via
`rtc_join` with a fresh session ID, which the server confirms with the
authoritative `rtc` frame or rejects with `denied`.

### B.3 Signaling relay

One fire-and-forget notification (omit `id`); the server is a mailbox, not a
participant.
`payload` is opaque to the server (SDP offers/answers, ICE candidates —
whatever the peers need). No acks: WebRTC's own state machine handles loss and
renegotiation.

```json
→ {
  "method": "rtc_signal",
  "params": {"session": "call_7", "to": "bob", "payload": {"sdp_type": "offer", "sdp": "v=0..."}}
}
← {
  "method": "rtc_signal",
  "params": {
    "session": "call_7",
    "from": {"id": "alice", "name": "Alice"},
    "payload": {"sdp_type": "offer", "sdp": "v=0..."}
  }
}
```

A conforming backend's obligation is routing `rtc_signal` by `to` within a
session — on the order of 15 lines.

### B.4 Topology

- **Mesh (normative baseline):** peers negotiate pairwise; the server purely
  relays. No media infrastructure; suitable for small trusted groups. Clients
  SHOULD soft-cap participant count.
- **SFU (future cap `rtc.sfu`):** a media server joins the session as an
  ordinary member with the reserved ID `@sfu`; clients negotiate a single
  PeerConnection with it via the same `rtc_signal` frames. Because senders are
  IDs and payloads are opaque, the upgrade introduces **no new frame types** —
  the reserved member ID is the capability's only protocol-visible artifact.

### B.5 Exclusions and knock-ons

Deliberately out of scope: mute/camera state frames (derivable from media
streams; a tiny ephemeral can be added later if UX demands), telephony-style
invite/ring/reject state machines (an `rtc` frame plus a push notification
covers call arrival), and recording/transcoding (server-side, protocol-
invisible). Knock-on for `push` (§6.5): when `rtc` lands, push payloads gain
an optional `kind` hint (e.g. `{"kind": "rtc", "session": "...", ...}`) so
mobile clients can surface an incoming-call UI instead of a message
notification.

Fallbacks: no `rtc` → no call UI; no `rtc.sfu` → mesh only.
