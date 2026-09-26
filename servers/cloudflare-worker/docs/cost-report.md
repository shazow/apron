# Cloudflare Worker storage cost report

This report records local native SQLite measurements used for the storage
accounting review. It describes the schema and the Workers test runtime; it
does not claim a deployed account billing rate or a free-plan capacity.

The focused run was first made on 2026-09-20 and repeated on 2026-09-22 for
the protocol v3 schema (schema 2: one server-wide record log, room records,
reaction sets) with the repository's workerd launcher:

```sh
devenv shell -- npm --prefix servers/cloudflare-worker test -- \
  --run test/accounting.integration.test.ts --reporter=verbose
```

The test uses ten separate Durable Objects through `runInDurableObject` and
constructs a `Store` over each object's native SQLite state with a fake clock.
The traffic tests start at `2026-09-22T12:00:00Z`, cross three UTC posting
days, advance cleanup to `2026-09-25T01:00:00Z`, and evict/reinitialize one
object to check persisted limiter state.

## Reservation accounting

The reservations below gate work before it runs. Since 2026-09-24 the unused
part of each finished SQL reservation, measured from its cursors, is credited
back in one budget-row update, so the daily counters are charged about the rows
actually used plus one. A guest reconnect (admission, auth, one history page,
room listing) is charged about 61 writes instead of 176, a post about 39 instead
of 280, and an idle alarm run about 14 instead of 30. The reservation sizes still
matter: they decide whether an operation is admitted near the ceiling.

Also since 2026-09-24, only a `message` mutation naming a `message_id` (an edit,
which may be a move) keeps the 256-write floor; creates, reactions, rooms and
renames, measured at most 37 writes, reserve a 96-write floor. History pages
reserve a 32-write floor (about 20 observed for a first request). Reads keep
their floors. The figures below predate these changes.

`reserveCost` adds eight read and eight write rows for its bounded control
work. The first reservation after a wake or UTC-day handover also carries an
eight-row handover allowance. A normal mutation has a conservative 256/256
mutation floor, so its steady-state mutation reservation is 264/264.
Request-ID mutations also do an 8/8 pre-duplicate lookup, which reserves
16/16 after control overhead; the steady-state full request-ID mutation is
280/280. A mutation without a request ID reserves 264/264. A cleanup run has
a bounded due-check reservation plus a 1,032/1,032 batch reservation; the
latest first-maintenance handover measured 1,068/1,058 in total (the due check now reserves twelve reads for its six indexed existence probes).

The protocol v3 operations (reaction sets, thread room creation and saves,
moves that re-log reactions) run through the same mutation path and fit the
existing 256/256 floor, so the mutation reservation was not changed. Room
listing now embeds each room's intro message and was re-derived from the
thread ceiling (see below).

The table below includes the reservation SQL in the observed cursor counts.
Every operation in the runtime reservation matrix is listed so the claimed
upper bounds can be compared with the measured worst case.

| Operation | Observed reads | Observed writes | Reserved reads | Reserved writes | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Auth attempt reservation | 10 | 8 | 48 | 32 | accepted |
| History quota reservation | 15 | 15 | 72 | 24 | accepted |
| Frame reservation (one frame) | 15 | 15 | 28 | 24 | accepted |
| Frame block (10 frames) | 11 | 10 | 64 | 24 | accepted |
| Connection admission reservation | 16 | 15 | 72 | 40 | accepted |
| Identity registration | 24 | 23 | 136 | 72 | accepted |
| Credential lookup | 3 | 1 | 16 | 8 | accepted |
| Identity lookup | 4 | 1 | 24 | 8 | accepted |
| Identity count | 3 | 1 | 16 | 8 | accepted |
| Credential IDs lookup | 3 | 1 | 40 | 8 | accepted |
| Credential counter update | 4 | 2 | 16 | 16 | accepted |
| Message create with request ID | 31 | 35 | 280 | 280 | accepted |
| Deduplicated mutation retry | 4 | 1 | 16 | 16 | accepted |
| Reaction set | 25 | 25 | 280 | 280 | accepted |
| Thread room create (with intro message) | 27 | 25 | 280 | 280 | accepted |
| Thread room save | 19 | 17 | 280 | 280 | accepted |
| Message move with one reaction set | 25 | 30 | 280 | 280 | accepted |
| Registered name mutation | 21 | 17 | 280 | 280 | accepted |
| History page | 10 | 1 | 264 | 40 | accepted |
| Room record lookup (`general`) | 4 | 1 | 24 | 8 | accepted |
| Room join lookup | 4 | 1 | 24 | 8 | accepted |
| Room listing (representative matrix) | 7 | 1 | 444 | 8 | accepted |
| Admission snapshot | 5 | 1 | 40 | 24 | accepted |
| Cleanup | 104 | 40 | 1,068 | 1,058 | accepted |
| Alarm scheduling | 7 | 3 | 24 | 12 | accepted |

The matrix uses a fresh object and one representative operation for each
boundary. The room-listing test separately populated the 100-thread policy
ceiling, each thread with an intro message embedded from current message
state; listing all 101 rooms measured 306/1 against its 452/16 reservation.
That reservation is now derived from the calibrated thread ceiling
(`32 + 4 * 101` rows plus reservation control), up from the fixed 256-row
listing reservation, because each room adds an indexed intro-message lookup.
A 180-record fixture mixing room, message, and reaction records returned a
50-record forward page (`more: true`, first/last spanning all kinds) at 60/5
against its 272/48 reservation. The maximum snapshot test used a 4,096-byte
text body plus an `ext` field and produced an 8,154-byte serialized snapshot.
Its maximum observed accepted mutation was 32/35, below the 280/280 request-ID
bound.

The worst move was measured at the calibrated reaction ceilings rather than
the defaults: 64 reacting users, each with 16 distinct 64-byte emoji and a
320-byte name. Each reaction set measured at most 91/30. Moving the message
re-logged all 64 sets in one 92,693-byte reaction record and measured 214/156
against its 280/280 reservation; the record still fit one history response.
The per-message cap is what bounds this move: without it, the re-logged set
count would be limited only by posting quotas.

## Protocol v6 operations

Measured on 2026-09-26 with the same operation matrix after the protocol v6
changes (schema 4: membership records in the log, and a `memberships` table of
registered users' rooms, keyed by room with an index by user, which replaces
schema 3's per-identity room list). These figures include the credit-back and
the 96-write floor described above, so they are the current ones; the
operations not listed here did not change.

| Operation | Observed reads | Observed writes | Reserved reads | Reserved writes |
| --- | ---: | ---: | ---: | ---: |
| Identity registration (starts in `general`, logs that membership) | 29 | 33 | 338 | 880 |
| Identity registration starting in 100 rooms | 228 | 825 | 338 | 880 |
| Identity lookup (with the user's rooms) | 8 | 2 | 434 | 8 |
| Message create with request ID | 33 | 37 | 280 | 120 |
| Thread room create by a registered user (stores and logs the membership) | 31 | 35 | 280 | 120 |
| Thread room save | 21 | 19 | 280 | 120 |
| Registered room leave (logs the membership) | 24 | 20 | 482 | 72 |
| Registered room join (logs the membership) | 23 | 17 | 482 | 72 |
| Registered room join at the 100-thread ceiling | 333 | 32 | 482 | 72 |
| History page (no `users`) | 12 | 2 | 264 | 40 |
| Room listing (representative matrix) | 8 | 2 | 444 | 8 |
| Room members, `general` and one thread | 8 | 2 | 424 | 8 |
| Room members, 101 rooms with 100 registered members each | 20,203 | 2 | 20,620 | 8 |
| Cleanup (matrix, one day later) | 128 | 51 | 1,070 | 1,058 |

- A registered user's join or leave is still one reservation that counts as a
  post; it now also appends one membership record and advances the room's
  head, about 8 more writes than the identity-row update it replaces, within
  the same 64-write floor. It no longer prunes against the rooms table; the
  read floor instead covers the user's rooms, read by the user index and
  joined to `rooms` (`8 + 2 × (101 + 100)` rows for live rooms and removed
  rooms awaiting purge). A join or leave that changes nothing writes nothing.
- A registration logs a membership in each starting room (at most the 101
  rooms), so its write floor is `64 + 8 × 101`. Registrations are capped at
  100 a day; the credit-back returns the unused part.
- A guest's joins and leaves live in its connection and are not logged; a
  join reads the room record (24/8) and its members (below).
- `members` (`room_list` with `members: true`, and `room_update` `joined`)
  read each listed room's registered members by primary-key range with one
  identity lookup each, at most `roomListMembers` (100) per room: the
  reservation is `8 + rooms × (4 + 2 × 100)` reads. Connected members come from
  connection attachments. A user in `general` and a few threads reads about
  two rows per registered member of those rooms; the worst case, a listing of
  all 101 rooms each at the cap, measured 20,203 reads, which the 2,500,000
  foreground reads a day allow about 120 times. Listings without `members`
  cost what they did.
- History pages no longer look up `users`, and membership records are read
  from the same room range as every other record.
- Cleanup purges a removed thread's membership rows in the same bounded
  batch, after its other deletions; its due check reserves 14 reads (seven
  probes, one of them the purge list). The full-batch test now also purges one
  membership per removed room within the 1,032/1,032 batch reservation.
- `room_list` ignores `latest_log_id`, so a reconnect's listing is always the
  full joined listing it was under protocol v5.
- `@private` throttle notices and `/help` replies carry no `log_id`, so they
  need no SQL.

For the three-day traffic sample, the operation rows were:

| Operation | Observed reads/writes | Reserved reads/writes |
| --- | ---: | ---: |
| Day 0 create | 34 / 37 | 288 / 128 |
| Day 1 create | 27 / 23 | 296 / 136 |
| Day 2 edit of older message | 29 / 22 | 296 / 296 |
| Day 2 create | 21 / 22 | 280 / 120 |
| Cleanup | 61 / 18 | 1,070 / 1,058 |
| History after cleanup | 8 / 2 | 264 / 40 |

The final counters for that sample were 217 observed reads and 142 observed
writes, against 2,518 reserved reads and 1,786 reserved writes. The native
SQLite file reported `databaseSize = 147,456` bytes (135,168 under schema 3;
the new table and index add pages). These values are a small schema/data
sample and are not a per-message capacity estimate.

## Frame blocks, activity, and throttle notices

Measured on 2026-09-24 with the operation matrix above. A single-frame
reservation reserves 28 reads and 24 writes. Connections now reserve frames in
blocks of 10 for 64 reads and 24 writes, so each frame's own bookkeeping is 2.4
reserved writes instead of 24. The 60,000-row foreground write ceiling
therefore covers about 25,000 frames a day on their own, up from 2,500. A
connection that sends one frame and closes still pays a whole block, which is
what a single frame cost before.

Blocks change what frames without SQL work of their own cost (`room_join`
lookups aside, notifications, rejected frames). They barely change posting: a
post is one frame plus its mutation reservation (264–280 writes), so the
foreground ceiling still allows about 210 posts a day (`60,000 / 282.4`), up
from about 197 (`60,000 / 304`). The mutation floor below is what bounds posts.

`activity` is off by default (`ACTIVITY=true` enables it). When it is on, the
web client sends a typing update when typing starts, every 12 seconds while it
continues, and when typing pauses: about 5 frames, or 12 reserved writes, per
typing minute. Read-cursor updates, which the demo drops, cost the same per
frame. The per-user relay limit (10 a minute) and the frame limits (60 per
connection and 120 per IP a minute) bound a single sender.

A throttled sender's `@private` notice is sent to that connection only, at
most once per user per minute, and needs no SQL. `room_list` reuses the
room-listing reservation (444 reads, 8 writes) and adds no writes; with
`members: true` it also reads each listed room's registered members (see
Protocol v6 operations), and its connected members come from connection
attachments.

The liveness ping (`{"method":"ping"}` every `server.ping` = 45 seconds, from
clients that support it) is answered by `setWebSocketAutoResponse`: it never
wakes the object or reaches `webSocketMessage`, so it uses no duration, frame
budget, or SQL. A ping with other spacing is an ordinary frame. Incoming
WebSocket messages count as Durable Object requests at 20:1, so 100 connections
that ping all day add about 9,600 requests (under 10% of the 100,000 daily
allowance). Pings are not rate limited by the demo; a client flooding them can
spend that allowance, which the account-usage stop and the platform's own Free
limits bound.

The default foreground write ceiling is 60,000 rows per UTC day. At the
current conservative floor this permits at most 227 mutations without a
request-ID (`60,000 / 264`) or 214 full request-ID mutations
(`60,000 / 280`), before other foreground operations consume the same daily
budget. The 256-row mutation floor is the configured conservative upper bound
for the complete posting path and its indexed control rows; the measured
maximum accepted mutation is much smaller, so lowering that floor requires a
separate proof for every allowed mutation shape and its control rows.

Rejected work is charged when it reaches a reservation boundary. Depending on
which bounded admission check rejects a request, a post-limit failure may have
paid either the request-ID lookup or the full mutation reservation; both paths
remain within the measured bound. The explicit 1,000/1,000 foreground test
ceiling accepts a bounded pool of requests, then drains the remaining
request-ID lookup allowance. Once that pool is exhausted, repeated denials
perform no additional Store SQL. This covers the fail-closed repeated-denial
path without assuming a fixed mutation cost.

The maximum-snapshot test accepted five operations before midnight, rejected
the sixth in that minute, then accepted a five-operation burst after midnight
and two groups of four edits separated by a minute. The resulting current-day
limiter count was 13, demonstrating that the UTC reset and the two bursts are
independent.

## Retention, maintenance, and persistent state

The three-day cleanup advanced the internal server-wide retention floor
(`history_floor` in SQLite) past three old records (the seeded `general` room
record and two creates), removed the unreferenced old current message, and kept
the edited message whose latest record was still inside the retention window. It also removed two expired accepted-request rows without changing
the room head.

The maintenance-reserve test accepted three mutations under an explicit
1,000/1,000 foreground ceiling, rejected the next mutation, then ran cleanup
on `2026-09-23`. The previous day's foreground counter was 880 while the new
day's cleanup consumed 1,058 maintenance writes and removed four records
(three creates and the seeded room record), three messages, three request
rows, and three limiter rows. The
current budget row must be read by day; calling `budget()` after midnight
correctly returns the new day's foreground counters rather than the exhausted
previous day.

After `evictDurableObject`, a fresh Store instance observed a bounded set of
schema, effective-clock, and budget-cache reads and zero schema writes. The persisted principal-limit rows retained the
original daily post count and the second mutation was rejected by that daily
limit. The SQLite file remained 135,168 bytes across eviction.

## Storage pressure and page reuse

The pressure integration uses a separate native SQLite calibration table with
8,192-byte payloads inserted in 64-row transactions. It reached
`132,177,920` occupied bytes (within 3 MiB of the 128 MiB hard target), and a
default Store mutation was rejected before growth. Deleting and reinserting
the same 15,168 rows three times produced the same occupied size each time,
without VACUUM.

The fixture then reduced occupied bytes to `93,749,248` (about 89.4 MiB),
evicted the object, and confirmed that the persisted pressure latch still
rejected growth above the 80 MiB low-water mark. After reducing the occupied
size to `81,371,136` (about 77.6 MiB) and evicting again, a new Store accepted
a mutation. The runtime's `databaseSize` excludes freelist pages, so these
are occupied-byte measurements from the supported API; they do not claim a
filesystem-file shrink or require VACUUM.

## Query plans

`EXPLAIN QUERY PLAN` returned these details in the native test runtime:

```text
history (one room's log, every record kind):
  SEARCH records USING INDEX sqlite_autoindex_records_1
    (room_id=? AND log_id>? AND log_id<?)
cleanup (server-wide prefix by commit time):
  SEARCH records USING COVERING INDEX records_retention_idx (commit_ms<?)
cleanup physical delete:
  SEARCH records USING INDEX records_log_idx (log_id<?)
message state expiry:
  SEARCH message_state USING INDEX message_state_latest_idx (latest_log_id<?)
reaction state expiry:
  SEARCH reaction_state USING INDEX reaction_state_log_idx (log_id<?)
move re-logging reactions:
  SEARCH reaction_state USING INDEX sqlite_autoindex_reaction_state_1 (message_id=?)
  USE TEMP B-TREE FOR ORDER BY
room listing:
  SCAN r
  SEARCH m USING INDEX sqlite_autoindex_message_state_1 (message_id=?) LEFT-JOIN
  USE TEMP B-TREE FOR ORDER BY
dedup expiry:
  SEARCH accepted_requests USING INDEX accepted_requests_expiry_idx (expires_ms<?)
limiter expiry:
  SEARCH principal_limits USING INDEX principal_limits_updated_idx (updated_ms<?)
room members:
  SEARCH m USING COVERING INDEX sqlite_autoindex_memberships_1 (room_id=?)
  SEARCH i USING INDEX sqlite_autoindex_identities_1 (user_id=?) LEFT-JOIN
a user's rooms:
  SEARCH m USING INDEX memberships_user_idx (user_id=?)
  SEARCH r USING INDEX sqlite_autoindex_rooms_1 (room_id=?)
  USE TEMP B-TREE FOR ORDER BY
```

History reads one contiguous primary-key range of one room's log; a move is
stored once in each room it touches, so no membership filter or `UNION` is
needed. The cleanup source selection explicitly uses `records_retention_idx`
for the strict commit-time cutoff, then `records_log_idx` for the bounded
physical delete. The move's reaction read and the room listing sort at most
the capped per-message reaction sets and the capped room table respectively;
the thread-room expiry check in cleanup scans that same capped table. Room
members are one primary-key range per room, already in `user_id` order, with a
primary-key identity lookup per member; a user's rooms are one index range,
sorted after joining the capped rooms table.

## Schema reset

A stored schema version other than the current one resets the object with
`deleteAll()` and recreates the schema (`test/schema-reset.integration.test.ts`).
The reset is charged the same one-time 512/512 bootstrap reservation as a new
object, added to the carried-over current-day reservation row without a
capacity check.

## Measurement limits

The native test runtime reports occupied SQLite bytes with freelist pages
excluded. The pressure test therefore verifies the supported occupied-byte
contract and page reuse; it does not claim a filesystem-file shrink or a
portable freelist counter. The measured row bounds also describe this schema
and runtime, not deployed billing or a guaranteed per-message capacity.

The native calibration in
[`test/native-storage.test.ts`](../test/native-storage.test.ts) measures basic
indexed insert/update/delete costs and page reuse. Its freelist result is
explicitly unsupported by this runtime; this report does not infer physical
freelist behavior from `databaseSize` alone.

The executable coverage for this report is in
[`test/accounting.integration.test.ts`](../test/accounting.integration.test.ts)
and [`test/pressure.integration.test.ts`](../test/pressure.integration.test.ts).
