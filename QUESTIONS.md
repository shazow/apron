# Protocol review questions

Review of [README.md](README.md) and [PROTOCOL.md](PROTOCOL.md).
Edit scope: `PROTOCOL.md` and `QUESTIONS.md` only. Use technical, dense, brief
prose for senior implementers. Resolve items sequentially; record decisions
and specification changes before checking them off. Obtain explicit user
confirmation before advancing to the next question. Specify wire semantics and
correctness invariants; leave implementation strategies unspecified.

Status: All review items resolved.

## 1. Retry semantics and duplicate messages

- [x] Resolved

Reference: PROTOCOL.md §§1, 2, 3.5.

Issue: Lost acknowledgements permit retries to create distinct log events;
`echo` provides correlation, not deduplication.

Decision: Recommend JSON-RPC 2.0 `method`/`params` and `result`/`error`, with
optional `jsonrpc` and request `id`. Omitted `jsonrpc` is an Apron extension;
omitted `id` means notification/no reply. Retry with the same ID. Servers SHOULD
deduplicate by `(authenticated sender, id)` and return the original result
without re-execution. Retention is implementation-defined; duplicates remain
allowed. No new handshake or message ID. Request IDs remain separate from log
IDs.

## 2. Live traffic during history recovery

- [x] Resolved

Reference: PROTOCOL.md §§2, 3.4, 5.1.

Issue: Advancing a recovery checkpoint to the highest received live ID can
skip missing history after another disconnect; interleaved replay can overwrite
newer state.

Decision: Announce `room.latest_id`, required with `history`, optional otherwise.
It covers events and updates; `"0"` denotes an empty log. Establish the head and
live delivery at one serialization point. Recover cached state through this
fixed bound while buffering live entries; advance checkpoints only through
processed history, then drain the buffer in order. Re-announcements do not move
the active bound. Persist checkpoints with cached state; interrupted recovery
resumes from the processed checkpoint. No additional handshake or server cursor.
Question 3 uses source page bounds for checkpoint advancement; client storage
and unknown-target handling remain implementation-defined.

## 3. Replay and optional rastered history

- [x] Resolved

Reference: PROTOCOL.md §§5.1, 5.3.

Issue: Mandatory compacted backfill imposes server reduction and leaves snapshot
revision and reconciliation with live updates unspecified.

Decision: Frontends replay the full transition model. Servers may return raw
log slices or equivalent rastered transitions, independent of query direction.
Rastered updates carry complete event state in `replace` at an existing
`update_id`; no future mutations may be included. Raw and rastered replay MUST
produce equivalent terminal state. Document ordered full replay as the naive
implementation; leave caching, eviction, unknown-target handling, and scheduling
unspecified. Partial-history clients obtain required replay dependencies.
Page `first_id`/`last_id` describe the source slice before compaction; checkpoints
and continuation use those bounds. Initial replay starts at `"0"`, bounded by
`latest_id`.

## 4. Deletion and retrieval of original content

- [x] Resolved

Reference: PROTOCOL.md §§5.1, 5.3, 6.1.

Decision: Use capability `delete` and event field `deleted`. Deletion produces
a tombstone; raw history may retain earlier content. Content and media retention
policies are implementation-defined.

## 5. Log timestamps and identity across reconnects

- [x] Resolved

Reference: PROTOCOL.md §§2, 5.1, Appendix A.

Decision: Decimal-string IDs based on Unix epoch milliseconds; one strictly
increasing room sequence across events and updates. Generation is
implementation-defined; recommend `str(max(unix_epoch_ms(), last_id + 1))`.
Derived timestamps are approximate. No separate counter range, overflow rule,
or restart procedure. Design assumes fewer than 1,000 entries/sec per room.

Decision: Log namespacing and reconnect association are client-defined. Remove
the prescribed storage tuple; retain only per-room, per-server ID uniqueness.
Server IDs and identity proofs are deferred.

## 6. Room and thread metadata lifecycle

- [x] Resolved

Reference: PROTOCOL.md §§3.4, 6.2, 6.3.

Decision: `room` and `thread` announcements replace metadata; omitted optional
fields are cleared. After authentication, servers re-announce visible rooms
and their visible thread metadata; clients rebuild the current metadata view.
`removed: true` withdraws the room or thread. Removed-room history retention,
access, and client cache policy are implementation-defined.

## 7. Mandatory receiving behavior and capability evolution

- [x] Resolved

Reference: PROTOCOL.md §§3.1, 4, 5.3, 6.2.

Decision: Frontend update/replay support is mandatory regardless of mutation
capabilities. Change policy is deferred until the specification stabilizes;
there are no existing consumers. Removed frozen commitments and version-bump
rules; retained the wire `protocol` field and the `conn` reservation.

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

- [x] Resolved

Reference: PROTOCOL.md §§3.5, 5.3;
[RFC 7396](https://www.rfc-editor.org/rfc/rfc7396.html).

Decision: Reference RFC 7396; objects merge recursively, other values replace,
and `null` deletes keys. `event_id` is immutable. Added one nested-patch example;
history `replace` retains full-object replacement semantics.

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

- [x] Resolved

Reference: PROTOCOL.md §5.1.

Issue: Inclusive continuation stalls at `limit: 1`; compaction obscures source
coverage when omitted entries supplied the original page boundaries.

Decision: Apply positive limits before compaction. Report source `first_id` and
`last_id`; continue at `last_id + 1` forward or `first_id - 1` backward. Preserve
the opposite bound. `more` describes the remaining source window, independent
of representation. Empty source slices omit both IDs and return `more: false`.

## 12. Examples, required fields, and metadata replacement

- [x] Resolved

Reference: PROTOCOL.md §§3.1, 3.3–3.5, 6.1–6.3.

Decision: `server` requires `protocol` and nonempty `auth`; `caps` defaults to
`[]`. Sender and room/thread identifiers are required; display metadata is
optional, with names defaulting to IDs. `send` requires `room` and object `body`;
body defaults are `text: ""`, `format: "markdown"`, and empty attachment/embed
arrays. Attachment-only messages are valid; empty-message acceptance is backend
policy. Defaults do not modify merge patches. Missing required method fields
or incorrect types yield `invalid_params`; notifications receive no reply.
The upload example is corrected; question 6 defines metadata replacement.

## 13. Markdown HTML and the content trust model

- [x] Resolved

Reference: PROTOCOL.md §§3.5, 6.4.

Decision: Clients MUST disable raw HTML in Markdown or sanitize rendered HTML
using the same allowlist policy as `embed.html`. Renderer and sanitizer choice
remain implementation-defined.

## 14. Conformance authority and missing companion artifacts

- [x] Resolved

Decision: Remove the conformance section and ancillary test-planning discussion.
