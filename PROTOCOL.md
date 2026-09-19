# Bottomless Chat Protocol

A chat frontend/backend protocol over a single WebSocket, designed so that a
minimal conforming backend ("Level 0") is implementable in under ~100 lines in
any language, and every feature beyond the core is an independently optional
capability. Frontends MUST degrade gracefully in the absence of any capability.

Terminology per RFC 2119. "Server" = the WebSocket backend. "Client" = the chat
frontend.

---

## 1. Transport & framing

- One WebSocket connection. Each WebSocket text frame contains exactly one JSON
  object (a **frame**). No batching, no newline-delimited streams.
- Every frame has a string `type`.
- **Requests** (client→server) carry a client-chosen string `id`. The server's
  reply echoes `id`. Replies are `ok` or `error`. Requests MAY be pipelined;
  the server processes them in order but MAY reply out of order.
- **Events** (server→client, unsolicited) carry no `id`.
- Unknown frame types: servers reply `error/unsupported`; clients ignore.
  Unknown *fields* in known frames MUST be ignored by both sides.
- Frame size: implementations SHOULD accept frames up to 256 KiB and MAY
  reject larger ones with `error/too_large`. This is a suggested soft limit,
  not a conformance requirement.
- Liveness rides on WebSocket ping/pong at the transport layer. There is no
  application-level heartbeat; do not invent one.

### 1.1 Replies

```json
{"type": "ok", "id": "c42", ...}
{"type": "error", "id": "c42", "code": "unsupported", "message": "optional human text"}
```

Standard `code` values (others are freeform strings):

| code          | meaning                                        |
|---------------|------------------------------------------------|
| `unsupported` | capability not implemented                     |
| `denied`      | authentication/authorization failure           |
| `retry_after` | rate limited; carries integer `ms`             |

---

## 2. Identifiers (mandatory)

All IDs on the wire are **strings**. They come in two flavors:

**Log IDs** (event IDs and update IDs) are strings of decimal digits encoding
`unix_seconds * 1000 + counter`, where `counter` is a per-second sequence
(0–999) — e.g. `"1724803200042"`. Servers MUST guarantee log IDs are
**strictly monotonic per room** across events *and* updates, which share one
sequence (a `max(last+1, now_ms)` ratchet suffices; >1000 entries/sec borrows
into the next second, and backward clock steps are absorbed).

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
Client request `id`s SHOULD be random per connection (see §3.5 echo).

---

## 3. Level 0 — mandatory core

A Level 0 server implements this section and nothing else. All Level ≥1
features are advertised capabilities (§4); their absence is signaled by
omission from `caps` and/or `error/unsupported`.

### 3.1 `server` frame

Upon accepting a connection, the server MUST immediately send a `server` frame,
unprompted. There is no client hello.

```json
{"type": "server", "protocol": 0, "name": "impl-name/1.0",
 "caps": ["history", "typing"],
 "auth": ["token"],
 "upload": "https://example/upload"}
```

- `protocol`: integer. Bumped only for breaking changes to this mandatory core;
  never for capabilities.
- `caps`: capability identifiers (§4). MAY be empty.
- `auth`: supported auth methods (§3.2), in server preference order.
- `upload`: present iff cap `upload` (§6.1).

The server MAY send a new `server` frame at any time; each **fully replaces**
the previous (no merging). On receipt, clients re-evaluate feature UI but MUST
NOT retroactively un-render existing content. After replying
`error/unsupported`, servers SHOULD follow with a fresh `server` frame.

### 3.2 Authentication

```json
→ {"type": "auth", "id": "c1", "method": "token", "token": "...", "client": "bottomless-web/0.3"}
← {"type": "ok", "id": "c1", "you": {"id": "alice", "name": "Alice"}}
```

Methods:

- `anonymous` — no credentials; server assigns identity. Legal and expected in
  trusted deployments.
- `token` — bearer string. The reference default.
- `webauthn` — two-round-trip challenge: `auth(method=webauthn)` →
  `ok` carrying `challenge` → `auth` carrying the assertion → final `ok`.
  Details deferred to a companion doc; cap-gated as `auth.webauthn`.

A server MUST support at least one method. `client` is an optional free-form
implementation/version string for debugging. Clients MAY pipeline `auth`
before `server` arrives. All other requests before successful auth get
`denied`.

### 3.3 Identity

Identity is server-authoritative and **denormalized**: every event carries its
sender inline. There is no user directory and no profile state.

```json
"sender": {"id": "alice", "name": "Alice", "avatar": "https://..."}
```

`id` is stable; `name`/`avatar` are advisory display data, current as of that
event. Rename request (server MAY comply, decline, or alter):

```json
→ {"type": "nick", "id": "c2", "name": "Alice ⚙"}
```

Bots and agents are ordinary senders; nothing distinguishes them at the
protocol level.

### 3.4 Rooms

Rooms have server-chosen string IDs. The server announces each room the client
can see (at minimum, once after auth):

```json
{"type": "room", "room": "general", "name": "General", "topic": "optional"}
```

Re-sending a `room` frame updates its metadata. Servers MUST announce a room
before delivering any entry in it. A Level 0 server announces one room and
never revisits the subject. Join/leave/create are cap `rooms.manage` (§6.3).

### 3.5 Messages

Send:

```json
→ {"type": "send", "id": "c3", "room": "general", "body": {"text": "hello *world*", "format": "markdown"}}
← {"type": "ok", "id": "c3", "event_id": "1724803200042"}
```

Broadcast (to all clients in the room, including the sender):

```json
{"type": "event", "room": "general", "echo": "c3", "event": {
  "event_id": "1724803200042",
  "sender": {"id": "alice", "name": "Alice"},
  "body": {"text": "hello *world*", "format": "markdown"}}}
```

- `body.format` ∈ `"plain" | "markdown"`. Both are mandatory to render;
  `markdown` is the expected default (CommonMark; fenced code blocks with
  language-tagged syntax highlighting are the baseline rich-content path).
  Renderers SHOULD disable raw inline HTML passthrough — CommonMark permits it
  by default, and enabling it reopens the sanitization hole that §6.4
  deliberately closes.
- **Echo:** the broadcast `event` for a client-originated `send` carries
  `echo` = the originating request `id`. Clients match `echo` against their
  own pending sends to confirm local echo and to reconcile retries — a `send`
  resent after reconnect that was already accepted produces a broadcast whose
  `echo` matches, preventing silent duplicates even though the server MAY
  assign it a fresh `event_id` or duplicate the message. Servers MAY include
  `echo` on all copies of the broadcast (simplest implementation); this is why
  client request `id`s SHOULD be random (§2) — clients MUST ignore `echo`
  values that don't match their own pending requests.
- Clients additionally dedup on `event_id`.
- `body.attachments` and `body.embeds`: see §6. **Clients MUST render entries
  of unknown `kind` as a labeled fallback card** (kind name + `url` if
  present). This rule is core; it is the forward-compatibility hook for future
  typed embeds.

The event object's defined fields, for reference (updates may set any key —
unknown keys are retained and ignored per §1):

| field       | set by                  | meaning                          |
|-------------|-------------------------|----------------------------------|
| `event_id`  | server, at creation     | log ID (§2)                      |
| `sender`    | server, at creation     | inline identity (§3.3)           |
| `body`      | sender; mutable         | `text`, `format`, `attachments`, `embeds` |
| `thread`    | server or `update`      | thread ID (§6.2)                 |
| `edited`    | `update`                | convention: true after body edits |
| `redacted`  | `update`                | tombstone marker (§5.3)          |

Fields a client supplies on `send` (`body`, and `thread` when replying in a
thread) sit at the **top level of the `send` frame**, alongside `room`; the
server copies them into the event object it creates.

### 3.6 Level 0 conformance checklist

Accept connection → emit `server` → accept one `auth` method → emit ≥1 `room`
→ accept `send`, reply `ok`, broadcast `event` with conforming IDs → reply
`error/unsupported` to everything else. That is the entire Level 0 surface.

### 3.7 A complete Level 0 session

```json
← {"type": "server", "protocol": 0, "name": "demo/1", "caps": [], "auth": ["token"]}
→ {"type": "auth", "id": "a", "method": "token", "token": "hunter2"}
← {"type": "ok", "id": "a", "you": {"id": "alice", "name": "Alice"}}
← {"type": "room", "room": "general", "name": "General"}
→ {"type": "send", "id": "b", "room": "general", "body": {"text": "hi", "format": "markdown"}}
← {"type": "ok", "id": "b", "event_id": "1724803200000"}
← {"type": "event", "room": "general", "echo": "b", "event": {
     "event_id": "1724803200000",
     "sender": {"id": "alice", "name": "Alice"},
     "body": {"text": "hi", "format": "markdown"}}}
→ {"type": "history", "id": "c", "room": "general", "limit": 50}
← {"type": "error", "id": "c", "code": "unsupported"}
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

Stateless window query over the room's **append-only log**. No server-held
cursors, no pagination tokens. The log contains two entry kinds — events and
updates (§5.3) — sharing one ID sequence (§2).

```json
→ {"type": "history", "id": "c9", "room": "general",
   "after": "1724803200000", "before": "1724806800000", "limit": 200}
← {"type": "history_page", "id": "c9", "entries": [...], "more": true}
```

Bounds and ordering:

- `after`/`before` are **inclusive** log-ID bounds; either or both MAY be
  omitted. IDs are timestamps, so "3pm–4pm yesterday" is client arithmetic.
- `entries` are **always in chronological order (oldest first)**, ascending by
  ID. No exceptions.
- `limit` is a request; servers MAY clamp. When the window holds more entries
  than the limit, truncation keeps the end nearest the anchor: with `after`
  present, return the *oldest* entries in the window (forward pagination —
  the client continues with `after` = last received ID); with only `before`
  (or no bounds), return the *newest* (backward scrollback — the client
  continues with `before` = first received ID). Because bounds are inclusive,
  continuation windows overlap by one entry; ID dedup absorbs this.
- `more: true` means the window wasn't exhausted.

Two response modes, chosen by the query shape:

- **Backfill (compacted)** — no `after` bound: `entries` contains only event
  objects, with all updates **already applied** and update entries omitted.
  Scrollback therefore renders final state directly — a message moved into a
  thread arrives already threaded; a redacted message arrives already
  stripped. Never replay-then-mutate on backfill.
- **Gap-fill (log replay)** — `after` present: `entries` contains the raw log
  slice — event objects *and* update objects (distinguished by `event_id` vs
  `update_id` keys), in log order. The client applies each in sequence. This
  is how mutations to *old* messages survive reconnection: an edit,
  redaction, or re-threading of a message the client already rendered arrives
  as an update entry in the gap.

Reconnect procedure: reconnect, re-auth, `history` with
`after: last_seen_id` per room, where `last_seen_id` is the max ID of any
entry (event or update) previously received. This is the entire sync model.

Reference storage model: an append-only list per room; backfill reads fold
updates into their targets (or read a materialized current-state map),
gap-fill reads slice the list. A dict and a list suffice.

### 5.2 `typing`

Fire-and-forget ephemera; no replies, servers MAY drop freely.

```json
→ {"type": "typing", "room": "general", "active": true, "timeout": 8}
← {"type": "typing", "room": "general", "sender": {...}, "active": true, "timeout": 8}
```

`timeout` (optional, seconds) is how long the indicator should persist without
refresh; clients expire remote typing state after `timeout`, defaulting to 10s
when absent. There is deliberately no presence system in this spec.

### 5.3 `edit`, `redact` — and the `update` frame

All retroactive mutation uses one server→client frame. Updates are log
entries: each consumes an ID from the room's sequence (§2) and appears in
gap-fill history (§5.1).

```json
{"type": "update", "room": "general", "update_id": "1724803312007",
 "target": "1724803200042",
 "set": {"body": {"text": "hello world", "format": "plain"}, "edited": true}}
```

Client rule: apply `set` to the local copy of event `target` using **JSON
Merge Patch semantics (RFC 7386)** — each key in `set` replaces the
corresponding key on the event, and a `null` value **deletes** the key.
Re-render. Unknown `target` MAY be ignored or lazily fetched via `history`.
This single rule implements edits, redaction, re-threading (§6.2), reactions,
and anything a future capability defines; servers MAY `update` any event,
including ones predating the connection.

Client-initiated mutation is one request frame mirroring the server frame:

```json
→ {"type": "update_request", "id": "c12", "room": "general",
   "target": "1724803200042", "set": {"body": {"text": "hello world", "format": "plain"}}}
← {"type": "ok", "id": "c12", "update_id": "1724803312007"}
```

The server validates which keys this sender may touch on this target
(policy is entirely server-defined), replies `ok`/`denied`, and on success
broadcasts the resulting `update` (the broadcast is authoritative and MAY
differ from the request). Capabilities `edit` and `redact` gate client UI
only; both use `update_request`.

**Redaction is an ordinary update.** A delete request is
`update_request` with `"set": {"redacted": true}`; the server SHOULD
broadcast (and store) it as
`"set": {"redacted": true, "body": null, "attachments": null, "embeds": null}` —
merge-patch `null` deletion strips the content everywhere, including compacted
history, with no special redaction machinery. Clients render redacted events
as tombstones.

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
{"type": "thread", "room": "general", "thread": "t_deploy",
 "name": "Deploy discussion", "summary": "Debugging the 4pm outage",
 "root": "1724801100007"}
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

- **Reply in a thread:** `send` with top-level `"thread": "t_deploy"` (an
  existing thread ID; see the field-placement rule in §3.5).
- **Propose a new thread:** `update_request` on the intended root event with
  `"set": {"thread": "t_<random>"}`, a fresh client-generated ID. The server
  accepts (broadcasting the `update` and an authoritative `thread` metadata
  frame) or replies `denied`. The `thread` field is always a string; there is
  no root-reference form.

### 6.3 `rooms.manage`

```json
→ {"type": "room_create", "id": "c20", "name": "Ops"}
→ {"type": "room_join",   "id": "c21", "room": "ops"}
→ {"type": "room_leave",  "id": "c22", "room": "ops"}
```

Server confirms with `ok` and the corresponding `room` frame. Visibility and
membership policy are entirely server-defined.

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
→ {"type": "push_register",   "id": "c30", "endpoint": "https://relay.example/p/xyz", "token": "..."}
→ {"type": "push_unregister", "id": "c31", "endpoint": "https://relay.example/p/xyz"}
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
verifies, per level: `server` frame timing and shape; auth flows; log-ID
monotonicity (across events and updates) and digit-string encoding under
burst load; `send`/`event` round-trip including `echo`; per-cap behavior
including RFC 7386 merge semantics, both history modes (chronological
ordering, inclusive bounds, truncation direction, compaction on backfill,
update replay on gap-fill), and `unsupported` responses for undeclared caps.
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
(§5.3), the two-mode history contract (§5.1 — compacted backfill, log-replay
gap-fill), and the unknown-kind fallback-card rule (§3.5). Everything else
evolves as capabilities.

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
{"conn": "b1", "frame": {"type": "send", "id": "c3", "room": "general", "body": {...}}}
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
→ {"type": "conn_open",  "conn": "b1", "url": "wss://backend.example/ws"}
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

Planned capability `rtc`, targeted at v1. Included here to document the
pattern it instantiates: **the socket is a signaling plane; heavy traffic goes
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
← {"type": "rtc", "room": "general", "session": "call_7",
   "kind": "voice", "members": [{"id": "alice", "name": "Alice"}], "active": true}
```

Re-sent on membership change; `"active": false` ends the session. Membership
is server-authoritative, not peer gossip.

### B.2 Join / leave

```json
→ {"type": "rtc_join",  "id": "c40", "room": "general", "session": "call_7"}
← {"type": "ok", "id": "c40", "ice": [{"urls": "stun:stun.example:3478"},
                                      {"urls": "turn:turn.example", "username": "u", "credential": "c"}]}
→ {"type": "rtc_leave", "id": "c41", "session": "call_7"}
```

ICE server configuration is vended at join time (mirroring the `upload` URL
pattern), since TURN credentials are deployment-specific and often
short-lived. Session creation is server-defined; a client MAY request one via
`rtc_join` with a fresh session ID, which the server confirms with the
authoritative `rtc` frame or rejects with `denied`.

### B.3 Signaling relay

One fire-and-forget frame; the server is a mailbox, not a participant.
`payload` is opaque to the server (SDP offers/answers, ICE candidates —
whatever the peers need). No acks: WebRTC's own state machine handles loss and
renegotiation.

```json
→ {"type": "rtc_signal", "session": "call_7", "to": "bob",
   "payload": {"sdp_type": "offer", "sdp": "v=0..."}}
← {"type": "rtc_signal", "session": "call_7", "from": {"id": "alice", "name": "Alice"},
   "payload": {"sdp_type": "offer", "sdp": "v=0..."}}
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
