# Protocol review questions

Review of [README.md](README.md) and [PROTOCOL.md](PROTOCOL.md).
Work through these in order, recording each decision and any corresponding
specification changes before marking the item resolved.

XXX: Unchecked questions remain unresolved; proposed directions for those items
are discussion options, not protocol requirements.

## 1. Retry semantics and duplicate messages

- [x] Resolved

Reference: PROTOCOL.md §§1, 2, 3.5.

Are duplicate messages after reconnect acceptable? `echo` reconciles a pending
send, but cannot prevent duplicates across clients or history. If the server
accepts a send, the connection drops before acknowledgement, and the client
retries, the server may store two events with different IDs. Other clients
display both.

Should the protocol explicitly allow duplicates, or support a persistent
idempotency key? The current claim about preventing silent duplicates needs
narrowing unless the protocol adds a mechanism to guarantee it. If deduplication
is supported, define its scope and retention period, and how retry identity
survives reconnects.

Decision: Recommend a JSON-RPC 2.0 envelope with optional `jsonrpc` and request
`id`. Omitting `jsonrpc` is an Apron shorthand; omitting `id` makes a call a
notification with no reply. Calls use `method`/`params`; replies use
`result`/`error`. Retry the same operation with the same ID. Servers SHOULD
deduplicate by ID within the authenticated sender's namespace and return the
original result without repeating the operation. Deduplication and its
retention are best effort; duplicates remain explicitly allowed. No additional
client-instance handshake or separate message ID is required. Request IDs
remain distinct from server-assigned log IDs. The revised wire envelope bumps
the draft protocol to `1` under §8.

## 2. Live traffic during history recovery

- [ ] Resolved

Reference: PROTOCOL.md §§2, 5.1.

How should live traffic interleave with history recovery? Receiving a high ID
does not establish that everything before it was received. A client reconnecting
from `100` could receive live event `120` before recovering `101–119`. Advancing
its checkpoint to `120` would lose the gap on another disconnect. An older
history update could also overwrite a newer live update.

Would a history watermark and an explicit buffering/replay procedure be
acceptable? These can still avoid server-held per-client cursors. Define when
the client may advance its recovery checkpoint.

## 3. Compacted history revision and window semantics

- [ ] Resolved

Reference: PROTOCOL.md §§5.1, 5.3.

What revision does compacted history represent? Backfill returns current event
state without identifying which updates that state includes, making its merge
with live updates ambiguous. An update for an unloaded event may be ignored,
then a history response generated before that update can arrive and install
stale content.

Should pages identify their snapshot position, or events carry their latest
applied update ID? Does `before` restrict event creation only, with later edits
still applied, or request state as of that bound?

## 4. Redaction and retrieval of original content

- [ ] Resolved

Reference: PROTOCOL.md §§5.1, 5.3, 6.1.

Does redaction mean hiding content or stopping the server from returning it?
The specification says content is stripped everywhere, but raw gap-fill still
contains the original event and previous edits in the append-only log. Uploaded
media also has its own lifetime.

Is redaction presentation-only? If future retrieval must exclude the content,
define the additional replay and media-retention rules.

## 5. Log timestamps and identity across reconnects

- [ ] Resolved

Reference: PROTOCOL.md §§2, 5.1, Appendix A.

Are log-derived timestamps deliberately approximate? Borrowing future time
under sustained throughput above 1,000 entries/second, or absorbing clock
corrections, can separate IDs from actual creation time. History nevertheless
describes wall-clock windows as straightforward arithmetic.

Is this tradeoff acceptable? Document its effect on time-window queries and
specify monotonicity across server restarts. Does `connection` in the storage
key mean a stable configured backend identity across reconnects, rather than a
particular socket instance?

## 6. Room and thread metadata lifecycle

- [ ] Resolved

Reference: PROTOCOL.md §§3.4, 6.2, 6.3.

How do clients learn that rooms or threads disappeared or changed while
disconnected? Leaving a room is confirmed with a `room` frame, but that frame
has no membership/removal field. Thread metadata has no stated replay
requirement.

What should happen after access revocation, room deletion, or an offline thread
rename? Consider a replacement snapshot or an explicit removal convention,
and define which metadata is re-announced after reconnect.

## 7. Mandatory receiving behavior and capability evolution

- [ ] Resolved

Reference: PROTOCOL.md §§3.1, 4, 5.3, 6.2, 8.

Which receive-side behaviors are mandatory regardless of capabilities? `edit`
and `redact` gate UI only, and `threads` can independently produce updates.
Must every frontend therefore understand `update`, even without those caps?
Separate mandatory receiving behavior from optional requests.

Which evolution rule takes precedence? Section 3.1 says capabilities never
cause protocol bumps, while §8 freezes history semantics and requires bumps
for changes.

## 8. WebSocket messages versus transport frames

- [x] Resolved

Reference: PROTOCOL.md §1;
[RFC 6455 §5.4](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.4).

Use “WebSocket text message” for the unit containing one JSON object. A message
may span several transport frames, and receivers must support fragmentation.
Keep application-level frame terminology distinct from transport framing.

Decision: Use “WebSocket text message” in §1 while retaining “frame” as the
application-level name for its JSON object. Corrected during the envelope change.

## 9. Merge-patch semantics and immutable fields

- [ ] Resolved

Reference: PROTOCOL.md §§3.5, 5.3, 7, 8;
[RFC 7396](https://www.rfc-editor.org/rfc/rfc7396.html).

Correct the merge-patch explanation: object values merge recursively rather
than simply replacing the corresponding object. Updating `body.text` therefore
preserves existing attachments. Cite RFC 7396, which replaces RFC 7386, and
include an example that demonstrates nested merging and deletion.

Explicitly prohibit changes to `event_id`; reconcile this with the statement
that updates may set any key.

## 10. Reply envelopes and fire-and-forget exceptions

- [x] Resolved

Reference: PROTOCOL.md §§1, 5.1, 5.2, Appendix B.

Section 1 permits only `ok`/`error` replies, but history returns `history_page`.
Should data replies use `ok`, or should the envelope rules permit typed replies?

Unsupported fire-and-forget frames have no request `id` to echo. Define their
handling, including how the pre-authentication denial rule applies to them.

Decision: All successful requests return `result`, including history pages;
errors use the JSON-RPC `error` object with numeric codes. Notifications have no
`id` and receive no replies, including on failure. Unknown notifications and
unauthenticated notifications other than `auth` are ignored. Protocol examples
now use the common envelope throughout; multiplexing control frames remain a
separate outer protocol.

## 11. Pagination progress and compaction limits

- [ ] Resolved

Reference: PROTOCOL.md §5.1.

Inclusive continuation repeats the same entry forever with `limit: 1`,
including when a server clamps the limit to one. Should continuation use
exclusive bounds, or advance to the last ID plus one / first ID minus one?

Specify whether backfill applies its limit before or after omitting updates,
and how `more` and continuation work when a raw log window contains only
updates. Ensure every nonterminal page permits progress.

## 12. Examples, required fields, and metadata replacement

- [ ] Resolved

Reference: PROTOCOL.md §§3.1, 3.3–3.5, 6.1–6.3.

The initial `server` example includes `upload` without its capability; align it
with the stated “present iff” rule.

Progress: The `upload` capability is now included in that example. The other
field/default and metadata questions below remain open.

Specify required fields and defaults, whether attachment-only messages may
omit text, and how malformed requests are handled. Clarify whether re-sent
room/thread metadata frames merge or replace previous metadata, including how
optional fields are cleared.

## 13. Markdown HTML and the content trust model

- [ ] Resolved

Reference: PROTOCOL.md §§3.5, 6.4.

Markdown rendering only recommends disabling raw HTML, while `embed.html`
requires sanitization. Should raw Markdown HTML be required to be disabled or
sanitized to enforce the same content trust model?

## 14. Conformance authority and missing companion artifacts

- [ ] Resolved

Reference: PROTOCOL.md §7.

The specification says the harness and reference backend ship with it, but
neither is present in this checkout. Is this paragraph describing planned work?
It also refers to `SPEC.md`, whereas the document is named `PROTOCOL.md`.

Should the prose be normative, with the harness providing executable checks,
rather than making passing the harness the sole definition of conformance?
Define how discrepancies between prose and tests are resolved.

## Review follow-up

TODO: Add expected wire transcripts for disconnect-after-send, live updates
during backfill, and redaction during replay after their semantics are decided.
Concrete traces should make subsequent reviews and conformance checks easier.
