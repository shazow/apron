# Bottomless Chat Protocol

A chat frontend/backend protocol over a single WebSocket, designed so that a
minimal conforming backend ("Level 0") is implementable in under ~100 lines in
any language. Server features beyond the core are optional; frontends MUST
degrade gracefully when they are unavailable.

Terminology per RFC 2119. "Server" = the WebSocket backend. "Client" = the chat
frontend.

After the WebSocket opens, the server announces itself, accepts authentication,
and announces visible rooms. The client can then send messages; the server
broadcasts them to all clients in the room, including the sender.

```jsonc
// <-
{"method": "server", "params": {"protocol": 2, "auth": ["anonymous"]}}
// ->
{"method": "auth", "id": "c1", "params": {"scheme": "anonymous"}}
// <-
{"id": "c1", "result": {"you": {"id": "guest_1"}}}
// <-
{"method": "room", "params": {"room": "general"}}
// ->
{"method": "send", "id": "c2", "params": {"room": "general", "body": {"text": "Hello"}}}
// <-
{"id": "c2", "result": {"event_id": "1724803200042"}}
// <- (broadcast)
{"method": "event", "params": {"room": "general", "echo": "c2", "event": {
  "event_id": "1724803200042", "sender": {"id": "guest_1"}, "body": {"text": "Hello"}
}}}
```

Request `id` correlates replies; `echo` links the broadcast to the send request.
The server-assigned `event_id` identifies the message in the room log.

---

## 1. Transport & framing

- One WebSocket connection. Each WebSocket text message contains exactly one JSON
  object (a **frame**).
- Receivers MUST accept both the [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
  envelope and a minimal form (omitting unused keys like `jsonrpc`).
- Requests MAY be pipelined; the server processes them in order but MAY reply
  out of order. Server announcements and broadcasts are notifications.
- Unknown methods: servers reply `error/unsupported` to requests and ignore
  notifications; clients ignore unknown notifications. Unknown *fields* in
  known methods MUST be ignored by both sides.
- Frame size: implementations SHOULD accept frames up to 256 KiB and MAY
  reject larger requests with `error/too_large`; oversized notifications may
  be dropped. The limit is advisory.
- Liveness uses WebSocket ping/pong; there is no application-level heartbeat.

### 1.1 Envelope and replies

Request `id`, when present, MUST be a string (§2). Clients SHOULD include `id`
for result correlation or retries, including `auth`, `history`, and mutations.
Event/update log IDs reside in `params`.

```jsonc
// ->
{"jsonrpc": "2.0", "method": "send", "id": "c42",
   "params": {"room": "general", "body": {"text": "hello", "format": "plain"}}}
// <-
{"jsonrpc": "2.0", "id": "c42", "result": {"event_id": "1724803200042"}}
```

Equivalent minimal exchange:

```jsonc
// ->
{"method": "send", "id": "c42",
   "params": {"room": "general", "body": {"text": "hello", "format": "plain"}}}
// <-
{"id": "c42", "result": {"event_id": "1724803200042"}}
```

A notification additionally omits `id`:

```json
{"method": "send", "params": {"room": "general", "body": {"text": "hello", "format": "plain"}}}
```

Success returns a `result` object (`{}` if empty). Errors contain integer
`code`, string `message`, and optional `data`:

```json
{"id": "c42", "error": {"code": -32601, "message": "Unsupported method"}}
{"id": "c43", "error": {"code": -32002, "message": "Try later", "data": {"ms": 1000}}}
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
still receive no error replies. Examples below use the minimal form for brevity.

### 1.2 Retries and recommended deduplication

Retries SHOULD preserve `id`, `method`, and `params` across reconnects. New
operations, including changed parameters, MUST use new IDs. Deduplication
ignores `jsonrpc` presence and object key order.

Servers SHOULD deduplicate by `(authenticated sender, id)`, return the original
result for accepted duplicates without re-execution or rebroadcast, reject
conflicting methods/parameters with `invalid_params`, and coalesce concurrent
duplicates.

Retention and persistence across reconnects/restarts are implementation-defined.
Pre-authentication IDs are connection-scoped; authentication MUST execute on
each connection.

---

## 2. Identifiers (mandatory)

All IDs on the wire are **strings**, except the `null` response ID used for
unidentifiable invalid requests (§1.1). They come in two flavors:

**Log IDs** (`event_id`) are decimal strings based on Unix epoch
milliseconds — e.g. `"1724803200042"`. Events and updates MUST share one
strictly increasing sequence per room. Generation is implementation-defined.
Recommended generator: `id = str(max(unix_epoch_ms(), last_id + 1))`.
`"0"` is reserved for the empty-log boundary; entries MUST use positive IDs.

A creation's `event_id` is the message's permanent identity. Each update has
its own `event_id` and references the creation's ID through `target` (§5.3).

- Compare numerically. Values are below `2^53`; clients MAY parse them as
  integers.
- Derived timestamps and time-window bounds are approximate. There is no
  separate timestamp field.
- Cross-room ordering is approximate. On a live connection, servers MUST
  deliver a room's entries (`event` and `update` frames) in ascending log-ID order.
- Log IDs are unique only within a room on a single server. Log namespacing
  is client-defined.

**Opaque IDs** (rooms, threads, sessions, sender IDs, client request `id`s)
are arbitrary strings chosen by whichever side mints them. Servers SHOULD
prefix them by type — e.g. `t_` for threads, `call_` for RTC sessions.
Client request `id`s SHOULD be randomly generated to avoid collisions across
devices and connections, including devices authenticated as the same sender.
Request IDs identify operations, not positions in the server's room log.

---

## 3. Level 0 — mandatory core

A Level 0 server implements this section. Selected optional features are
advertised through capabilities (§4).

### 3.1 `server` frame

Upon accepting a connection, the server MUST immediately send a `server` frame,
unprompted. There is no client hello.

```json
{
  "method": "server",
  "params": {
    "protocol": 2,
    "name": "impl-name/1.0",
    "caps": ["history", "edit", "rooms"],
    "auth": ["token"],
    "upload": "https://example/upload"
  }
}
```

- `protocol`: required integer. Current value `2`.
- `name`: optional implementation/version string.
- `caps`: array of capability strings (§4), default `[]`.
- `auth`: required nonempty array of supported authentication schemes (§3.2),
  in server preference order.
- `upload`: optional upload URL; its presence enables uploads (§6.1).

The server MAY send a new `server` frame at any time; each **fully replaces**
the previous. On receipt, clients re-evaluate feature UI but MUST
NOT retroactively un-render existing content. After replying
`error/unsupported`, servers SHOULD follow with a fresh `server` frame.

### 3.2 Authentication

```jsonc
// ->
{"method": "auth", "id": "c1", "params": {"scheme": "token", "token": "...", "client": "bottomless-web/0.3"}}
// <-
{"id": "c1", "result": {"you": {"id": "alice", "name": "Alice"}}}
```

`params.scheme` selects the authentication scheme:

- `anonymous` — no credentials; server assigns identity.
- `token` — bearer string. The reference default.
- `webauthn` — suggested optional scheme; exchange details are
  implementation-defined.

Servers MAY accept `auth` regardless of `params.scheme` and ignore credentials.
Credential validation, identity assignment, and privilege policy are
implementation-defined.

`client` is an optional free-form implementation/version string for debugging.
Clients MAY pipeline `auth` before `server` arrives. Before successful auth,
other requests get `denied`; other notifications are ignored.

### 3.3 Identity

Identity is server-authoritative: every event carries its sender inline.
There is no user directory or profile state.

```json
"sender": {"id": "alice", "name": "Alice", "avatar": "https://..."}
```

`id` is required and stable. `name`/`avatar` are optional advisory strings,
current as of that event; absent `name` falls back to `id`. Rename request
(server MAY comply, decline, or alter):

```jsonc
// ->
{"method": "nick", "id": "c2", "params": {"name": "Alice ⚙"}}
```

Bots and agents are ordinary senders; nothing distinguishes them at the
protocol level.

### 3.4 Rooms

Rooms have server-chosen string IDs. After authentication, servers MUST announce
all currently visible rooms. Clients rebuild the current metadata view from
these announcements:

```json
{"method": "room", "params": {
  "room": "general", "name": "General", "topic": "optional", "latest_id": "1724803200042"
}}
```

Re-sending `room` fully replaces its metadata; omitted optional fields are
cleared. `room` is required; `name` and `topic` are optional strings, with
`name` defaulting to `room`. Servers MUST emit `removed: true` when a room
leaves the client's visible set, withdrawing the room and its thread metadata.
Only `room` and `removed` are required:

```json
{"method": "room", "params": {"room": "general", "removed": true}}
```

Omitted `removed` means false. History retention and access after room removal,
including client cache policy, are implementation-defined. Servers MUST
announce a room before delivering entries in it. A Level 0 server announces
one room. Join/leave/create require cap `rooms` (§6.3).

`latest_id` is the maximum committed room log ID, including events and updates;
`"0"` denotes an empty log. It is REQUIRED on active room announcements when
`history` is supported, OPTIONAL otherwise. For history-enabled rooms, an
announcement establishing live delivery MUST establish `latest_id` at the same
serialization point: transitions through `latest_id` are recoverable via history
(raw or equivalent rasters), and subsequent entries MUST be delivered live in
log order. Re-announcements report the current head but MUST NOT advance
client checkpoints or replace an active recovery bound (§5.1).

### 3.5 Messages

Send:

```jsonc
// ->
{
  "method": "send",
  "id": "c3",
  "params": {"room": "general", "body": {"text": "hello *world*", "format": "markdown"}}
}
// <-
{"id": "c3", "result": {"event_id": "1724803200042"}}
```

Broadcast (to all clients in the room, including the sender):

```jsonc
// <- (broadcast)
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

- `send` requires string `room` and object `body`. Body fields are optional:
  string `text` defaults to `""`; `format` defaults to `"markdown"`;
  array `embeds` defaults to `[]`. Messages containing only embeds are valid;
  acceptance of empty messages is backend policy. Defaults apply
  when interpreting message bodies, not when applying merge patches (§5.3).
- `body.format` ∈ `"plain" | "markdown"`. Both are mandatory to render.
  Markdown uses CommonMark; fenced code blocks with language-tagged syntax
  highlighting are the baseline rich-content path.
  Clients MUST disable raw HTML in Markdown or sanitize rendered HTML using
  the same allowlist policy as HTML embeds (§6.4).
- **Echo:** the broadcast `event` for a client-originated `send` with `id`
  carries `params.echo` = the originating request `id`. Omit `echo` for sends
  without `id`. Clients match `echo` against their own pending sends to
  reconcile local echo. Servers MAY include it on all copies of the broadcast;
  clients MUST ignore values that do not match their own pending requests.
  Clients MUST also accept the `send` result as confirmation, including when
  deduplication suppresses a retry's broadcast (§1.2).
- Clients additionally dedup on `event_id`.
- `body.embeds`: see §6. **Clients MUST render entries
  of unknown `kind` as a labeled fallback card** (kind name + `url` if
  present).

The event object's defined fields (`event_id` is immutable; other unknown keys
are retained during replay and ignored by renderers):

| field       | set by                  | meaning                          |
|-------------|-------------------------|----------------------------------|
| `event_id`  | server, at creation     | log ID (§2)                      |
| `sender`    | server, at creation     | inline identity (§3.3)           |
| `body`      | sender; mutable         | `text`, `format`, `embeds`        |
| `thread`    | server or `update`      | thread ID (§6.2)                 |
| `deleted`   | `update`                | tombstone marker (§5.3)          |

Fields a client supplies on `send` (`body`, and `thread` when replying in a
thread) sit in **`send.params`**, alongside `room`; the server copies them
into the event object it creates.

### 3.6 Level 0 conformance checklist

Accept connection → emit `server` → accept one auth scheme → emit ≥1 `room`
→ accept `send`, return a `result` for requests, broadcast `event` with
conforming IDs → reply `error/unsupported` to other requests and ignore unknown
notifications. Framing and retries follow §1.

### 3.7 A complete Level 0 session

```jsonc
// <-
{"method": "server", "params": {"protocol": 2, "name": "demo/1", "caps": [], "auth": ["token"]}}
// ->
{"method": "auth", "id": "a", "params": {"scheme": "token", "token": "hunter2"}}
// <-
{"id": "a", "result": {"you": {"id": "alice", "name": "Alice"}}}
// <-
{"method": "room", "params": {"room": "general", "name": "General"}}
// ->
{"method": "send", "id": "b", "params": {"room": "general", "body": {"text": "hi", "format": "markdown"}}}
// <-
{"id": "b", "result": {"event_id": "1724803200000"}}
// <- (broadcast)
{
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
// ->
{"method": "history", "id": "c", "params": {"room": "general", "limit": 50}}
// <-
{"id": "c", "error": {"code": -32601, "message": "Unsupported method"}}
```

---

## 4. Capabilities

`server.caps` advertises optional requests. Absence of a cap obligates the
client to the corresponding fallback:

| cap            | fallback behavior                              |
|----------------|------------------------------------------------|
| `history`      | session-only scrollback; divider on reconnect  |
| `edit`         | edit, delete, and thread reassignment/creation UI hidden |
| `rooms`        | fixed room list                                |
| `push`         | no mobile wake-ups                             |

`typing`, thread metadata, and embeds require no capability flags. Clients
handle supported notifications and content when received; unknown methods and
kinds follow §1 and §3.5. Upload availability follows `server.upload` (§6.1).
Capabilities advertise support, not authorization; servers apply local policy
to each request.

---

## 5. Level 1 features

### 5.1 `history`

Stateless window query over the room's **append-only transition log** (§2).
Servers MAY return raw transitions or equivalent rastered transitions
(complete event snapshots); no capability negotiation is required.

```jsonc
// ->
{
  "method": "history",
  "id": "c9",
  "params": {"room": "general", "after": "1724803200000", "before": "1724806800000", "limit": 200}
}
// <-
{"id": "c9", "result": {
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
- `entries` are always ascending by `event_id`. Pages may mix raw and rastered
  transitions; their representation is independent of query direction.

**Optional rastering.** For each target touched by a source slice, a server MAY
replace its selected transitions with one complete snapshot at that target's
last transition in the slice. If that transition is a creation, return the
original event object. Otherwise return an update with `replace` instead of
`set`:

```json
{"event_id": "1724803312007", "target": "1724803200042", "replace": {
  "event_id": "1724803200042", "sender": {"id": "alice", "name": "Alice"},
  "body": {"text": "hello world", "format": "plain"}
}}
```

`replace` MUST equal the complete event state after replay through the outer
`event_id`, including unknown fields and deletions. It MUST NOT incorporate
later updates. `replace.event_id` MUST equal `target`. The outer `event_id`
is the target's last source transition ID, not a newly allocated ID. Omitted
transitions remain covered by `first_id`/`last_id`. Raw and rastered replies
MUST yield the same terminal event state when applied to the source slice's
preceding state.
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

```jsonc
// <-
{"method": "room", "params": {"room": "general", "name": "General", "latest_id": "1724803200120"}}
// ->
{"method": "history", "id": "recover1", "params": {
  "room": "general", "after": "1724803200101", "before": "1724803200120"
}}
```

### 5.2 `typing`

Ephemeral notifications; clients MAY send them without capability discovery.
Servers MAY drop them.

```jsonc
// ->
{"method": "typing", "params": {"room": "general", "active": true, "timeout": 8}}
// <- (broadcast)
{
  "method": "typing",
  "params": {"room": "general", "sender": {...}, "active": true, "timeout": 8}
}
```

`timeout` (optional, seconds) is how long the indicator should persist without
refresh; clients expire remote typing state after `timeout`, defaulting to 10s
when absent. There is no presence system.

### 5.3 `edit` — and the `update` frame

All retroactive mutation uses one server→client frame. Updates consume room
log IDs (§2) and appear in history (§5.1), raw or represented by rasters.
Frontend update/replay support is mandatory regardless of cap `edit`.

```jsonc
// <- (broadcast)
{
  "method": "update",
  "params": {
    "room": "general",
    "event_id": "1724803312007",
    "target": "1724803200042",
    "set": {"body": {"text": "hello world", "format": "plain"}}
  }
}
```

Client rule: replay `set` on event `target` using
[JSON Merge Patch (RFC 7396)](https://www.rfc-editor.org/rfc/rfc7396.html):
recursively merge objects, replace other values, and delete keys
whose patch value is `null`. `set` MUST be an object; the target message's
`event_id` MUST NOT be changed or deleted.

For example, `{"body": {"text": "new", "embeds": null}}` updates text,
removes embeds, and preserves other body fields such as `format`.

History rasters use `replace` for full-object replacement, not merge patch;
an update contains exactly one of `set` or `replace`. Live updates and client
`update_request`s use `set`. Partial-history replay follows §5.1.
Re-render after reduction. Servers MAY update any event, including ones
predating the connection; the same mechanism covers edits, deletion,
re-threading (§6.2), and future state mutations.

Clients submit mutations with `update_request`:

```jsonc
// ->
{
  "method": "update_request",
  "id": "c12",
  "params": {"room": "general", "target": "1724803200042", "set": {"body": {"text": "hello world", "format": "plain"}}}
}
// <-
{"id": "c12", "result": {"event_id": "1724803312007"}}
```

The server authorizes changes according to local policy, replies to requests
with `result` or `error/denied`, and on success broadcasts an authoritative
`update` that MAY differ from the request. Cap `edit` advertises `update_request`
for edits, deletion, and thread reassignment/creation (§6.2).

**Deletion is an ordinary update.** A delete request is
`update_request` with `"set": {"deleted": true}`; the server SHOULD
broadcast (and store) it as
`"set": {"deleted": true, "body": null}` —
merge-patch `null` deletion strips the reduced event state. Raw replay may
still contain earlier content; rastered state after deletion omits it.
Clients render deleted events as tombstones. Content and media retention
policies are implementation-defined.

---

## 6. Level 2 features

### 6.1 `upload`

Media travels over HTTP, not the socket. The client POSTs
`multipart/form-data` to the `upload` URL from the `server` frame, receiving
`{"url": "..."}`; it then references the URL:

```json
"body": {"text": "look:", "format": "markdown",
         "embeds": [{"kind": "image", "url": "...", "mime": "image/png", "w": 800, "h": 600}]}
```

Upload authentication: with `token` auth, the same token as bearer. With
other schemes there is no reusable credential, so the server SHOULD re-send
the `server` frame after auth carrying a per-session `upload` URL (§3.1).

Media embed kinds: `image`, `video`, `audio`, `file` (with `name`, `size`).
Unknown kinds → fallback card rule (§3.5).

### 6.2 Threads

`thread` is an optional opaque ID on events (§2). Metadata uses a `thread`
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

`room` and `thread` are required. `name` and `summary` are optional strings;
`name` defaults to `thread`. `root` is an optional advisory event ID.

Thread announcements fully replace metadata. Servers MUST re-announce current
visible thread metadata after authentication, following the containing room's
announcement. Servers MUST emit `removed: true` when a thread leaves the
client's visible set, unless its room is removed. Only `room`, `thread`, and
`removed` are required for removal. Omitted `removed` means false.

```json
{"method": "thread", "params": {"room": "general", "thread": "t_deploy", "removed": true}}
```

Threading is server-authoritative and retroactive: moving an event into a
thread is `update` with `"set": {"thread": "t_deploy"}`; removing it is
`"set": {"thread": null}` (merge-patch deletion). A moderator agent
re-threading a message group emits N `update`s plus a `thread` frame carrying
its summary. Clients MUST re-home moved messages without treating them as
deleted, and SHOULD indicate the move at the message's original position.

Client participation:

- **Reply in a thread:** `send` with `"thread": "t_deploy"` in `params` (an
  existing thread ID; see the field-placement rule in §3.5).
- **Propose a new thread:** `update_request` on the intended root event with
  `"set": {"thread": "t_<random>"}`, a fresh client-generated ID. The server
  accepts (broadcasting the `update` and an authoritative `thread` metadata
  frame) or replies `denied`.

### 6.3 `rooms`

```jsonc
// ->
{"method": "room_create", "id": "c20", "params": {"name": "Ops"}}
// ->
{"method": "room_join", "id": "c21", "params": {"room": "ops"}}
// ->
{"method": "room_leave", "id": "c22", "params": {"room": "ops"}}
```

Server confirms requests with `result: {}` and emits the corresponding `room`
notification; successful `room_leave` emits `removed: true`. Visibility and
membership policy are server-defined.

### 6.4 Embeds

`body.embeds` contains media (§6.1) and rich content in display order;
`kind` selects the renderer.

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
- Future typed embeds (`diff`, `poll`, …) use the fallback rule (§3.5).

### 6.5 `push`

UnifiedPush-shaped registration; the client supplies an HTTPS endpoint owned
by its push relay:

```jsonc
// ->
{
  "method": "push_register",
  "id": "c30",
  "params": {"url": "https://relay.example/p/xyz", "token": "..."}
}
// ->
{"method": "push_unregister", "id": "c31", "params": {"url": "https://relay.example/p/xyz"}}
```

When the user should be woken while disconnected, the server POSTs JSON
`{room, event_id, sender, preview}` to `url` with the token as bearer.
`sender` uses the inline identity object (§3.3). Delivery beyond that POST
(APNs/FCM, coalescing) is the relay's concern. Wake policy (mentions, all
messages) is server-defined.

Note: registered endpoints are client-supplied URLs the server will POST to —
an SSRF vector into the server's network. Servers SHOULD accept only `https`
endpoints resolving to non-internal addresses.

---

## Appendix A — Multiplexing envelope (informative)

Multiple logical protocol connections can share one physical WebSocket via an
aggregator that proxies backends. This envelope is **outside the core protocol**.

### A.1 Model

A mux endpoint wraps every core-protocol frame in an envelope carrying an
opaque connection ID:

```json
{
  "conn": "b1",
  "frame": {"method": "send", "id": "c3", "params": {"room": "general", "body": {...}}}
}
```

Each `conn` carries an independent core-protocol session. A demultiplexer
passes inner frames to the corresponding client instance. Frame ordering is
preserved per `conn`; no ordering is guaranteed across `conn`s.

### A.2 Control frames

Envelope-level control uses unwrapped frames (no `frame` field):

```jsonc
// ->
{"type": "conn_open", "conn": "b1", "url": "wss://backend.example/ws"}
// <-
{"type": "conn_ready", "conn": "b1"}
// <-
{"type": "conn_error", "conn": "b1", "code": "unreachable", "message": "..."}
// <-
{"type": "conn_close", "conn": "b1"}
// ->
{"type": "conn_close", "conn": "b1"}
```

- `conn` is an opaque string chosen by the opener, unique per physical socket.
- After `conn_ready`, the proxied backend's `server` frame arrives wrapped, as
  the first frame on that `conn`.
- `conn_close` from either side terminates the logical connection; the
  aggregator closes the upstream socket.
- Aggregator authentication (who may open conns, to where) is out of scope
  here and deployment-defined.

### A.3 Properties

The aggregator forwards inner frames without parsing them and holds only the
`conn`↔upstream-socket mapping. Backends remain authoritative; the envelope
can carry encrypted frame contents. Log namespacing remains client-defined (§2).

---

## Appendix B — Out-of-band channel negotiation: WebRTC (informative)

Planned capability `rtc`: the socket carries signaling; media travels out of
band. Future channels (screenshare, collaborative documents, file transfer)
should reuse this pattern: a session announcement with server-authoritative
membership, a join request returning connection configuration, and an opaque
relay frame.

### B.1 Sessions

A call is a server-announced, room-scoped session, following the re-sendable
metadata-frame idiom of `room` and `thread`:

```jsonc
// <-
{
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

Re-sent on membership change; `"active": false` ends the session.

### B.2 Join / leave

```jsonc
// ->
{"method": "rtc_join", "id": "c40", "params": {"room": "general", "session": "call_7"}}
// <-
{
  "id": "c40",
  "result": {
    "ice": [{"urls": "stun:stun.example:3478"}, {"urls": "turn:turn.example", "username": "u", "credential": "c"}]
  }
}
// ->
{"method": "rtc_leave", "id": "c41", "params": {"session": "call_7"}}
```

ICE server configuration is vended at join time (mirroring the `upload` URL
pattern), since TURN credentials are deployment-specific and often
short-lived. Session creation is server-defined; a client MAY request one via
`rtc_join` with a fresh session ID, which the server confirms with the
authoritative `rtc` frame or rejects with `denied`.

### B.3 Signaling relay

The server relays notifications with opaque `payload` (SDP offers/answers,
ICE candidates, etc.). WebRTC handles loss and renegotiation.

```jsonc
// ->
{
  "method": "rtc_signal",
  "params": {"session": "call_7", "to": "bob", "payload": {"sdp_type": "offer", "sdp": "v=0..."}}
}
// <-
{
  "method": "rtc_signal",
  "params": {
    "session": "call_7",
    "sender": {"id": "alice", "name": "Alice"},
    "payload": {"sdp_type": "offer", "sdp": "v=0..."}
  }
}
```

The backend routes `rtc_signal` by `to` within a session.

### B.4 Topology

- **Mesh (normative baseline):** peers negotiate pairwise; the server purely
  relays. No media infrastructure; suitable for small trusted groups. Clients
  SHOULD soft-cap participant count.
- **SFU (future cap `rtc.sfu`):** a media server joins the session as an
  ordinary member with the reserved ID `@sfu`; clients negotiate a single
  PeerConnection with it via `rtc_signal`.

### B.5 Exclusions and knock-ons

- Mute/camera state frames are out of scope: state is derivable from media
  streams; an ephemeral notification may be added if needed.
- Invite/ring/reject state machines are out of scope: an `rtc` frame plus a
  push notification covers call arrival.
- Recording/transcoding is server-side and outside the protocol.
- When `rtc` lands, push payloads (§6.5) gain an optional `kind` hint
  (e.g. `{"kind": "rtc", "session": "...", ...}`) so mobile clients can show
  an incoming-call UI instead of a message notification.
- Without `rtc`, hide call UI; without `rtc.sfu`, use mesh only.
