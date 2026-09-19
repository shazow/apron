# Protocol review questions

Review of [README.md](README.md) and [PROTOCOL.md](PROTOCOL.md).
Edit scope: `PROTOCOL.md` and `QUESTIONS.md` only. Use technical, dense, brief
prose for senior implementers. Resolve items sequentially; record decisions
and specification changes before checking them off. Obtain explicit user
confirmation before advancing to the next question. Specify wire semantics and
correctness invariants; leave implementation strategies unspecified.

XXX: Unchecked questions remain unresolved; proposed directions for those items
are discussion options, not protocol requirements.

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
IDs. Envelope changes bump `protocol` to `1` under §8.

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
`latest_id`. The history-contract change bumps `protocol` to `2` under §8.

## 4. Deletion and retrieval of original content

- [x] Resolved

Reference: PROTOCOL.md §§5.1, 5.3, 6.1.

Decision: Use capability `delete` and event field `deleted`. Deletion produces
a tombstone; raw history may retain earlier content. Content and media retention
policies are implementation-defined.

## 5. Log timestamps and identity across reconnects

- [ ] Resolved

Reference: PROTOCOL.md §§2, 5.1, Appendix A.

Decision: Decimal-string IDs based on Unix epoch milliseconds; one strictly
increasing room sequence across events and updates. Generation is
implementation-defined; recommend `str(max(last_id + 1, unix_epoch_ms()))`.
Derived timestamps are approximate. No separate counter range, overflow rule,
or restart procedure. Design assumes fewer than 1,000 entries/sec per room.

Open: Does `connection` in storage keys denote stable backend identity across
reconnects rather than a socket instance?

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
and `delete` gate UI only, and `threads` can independently produce updates.
Must every frontend therefore understand `update`, even without those caps?
Separate mandatory receiving behavior from optional requests.

Progress: Full update/replay support is now mandatory (§5.3).

Remaining: §8 freezes history semantics despite `history` being optional.
Should future capability changes use separate versions or protocol bumps?

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

Progress: Recursive merge semantics and immutable `event_id` are explicit after
the replay change. The RFC citation update and nested-patch example remain open.

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
during backfill, and deletion during replay after their semantics are decided.
Concrete traces should make subsequent reviews and conformance checks easier.
