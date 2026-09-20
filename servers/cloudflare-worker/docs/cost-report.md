# Cloudflare Worker storage cost report

This report records local native SQLite measurements used for the storage
accounting review. It describes the schema and the Workers test runtime; it
does not claim a deployed account billing rate or a free-plan capacity.

The focused run was made on 2026-09-20 with the repository's Nix workerd
launcher:

```sh
devenv shell -- npm --prefix servers/cloudflare-worker test -- \
  --run test/accounting.integration.test.ts --reporter=verbose
```

The test uses nine separate Durable Objects through `runInDurableObject` and
constructs a `Store` over each object's native SQLite state with a fake clock.
The traffic tests start at `2026-09-22T12:00:00Z`, cross three UTC posting
days, advance cleanup to `2026-09-25T01:00:00Z`, and evict/reinitialize one
object to check persisted limiter state.

## Reservation accounting

`reserveCost` adds eight read and eight write rows for its bounded control
work. The first reservation after a wake or UTC-day handover also carries an
eight-row handover allowance. A normal mutation has a conservative 256/256
mutation floor, so its steady-state mutation reservation is 264/264.
Request-ID mutations also do an 8/8 pre-duplicate lookup, which reserves
16/16 after control overhead; the steady-state full request-ID mutation is
280/280. A mutation without a request ID reserves 264/264. A cleanup run has
a bounded due-check reservation plus a 1,032/1,032 batch reservation; the
latest first-maintenance handover measured 1,064/1,058 in total.

The table below includes the reservation SQL in the observed cursor counts.
Every operation in the runtime reservation matrix is listed so the claimed
upper bounds can be compared with the measured worst case.

| Operation | Observed reads | Observed writes | Reserved reads | Reserved writes | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Auth attempt reservation | 10 | 8 | 48 | 32 | accepted |
| History quota reservation | 15 | 15 | 72 | 24 | accepted |
| Frame reservation (one frame) | 15 | 15 | 28 | 24 | accepted |
| Connection admission reservation | 16 | 15 | 72 | 40 | accepted |
| Identity registration | 24 | 23 | 136 | 72 | accepted |
| Credential lookup | 3 | 1 | 16 | 8 | accepted |
| Identity lookup | 4 | 1 | 24 | 8 | accepted |
| Identity count | 3 | 1 | 16 | 8 | accepted |
| Credential IDs lookup | 3 | 1 | 40 | 8 | accepted |
| Credential counter update | 4 | 2 | 16 | 16 | accepted |
| Message create with request ID | 29 | 36 | 280 | 280 | accepted |
| Deduplicated mutation retry | 4 | 1 | 16 | 16 | accepted |
| Thread create | 25 | 22 | 280 | 280 | accepted |
| Registered nick mutation | 22 | 17 | 280 | 280 | accepted |
| History page | 5 | 1 | 264 | 40 | accepted |
| Room state announcement | 3 | 1 | 16 | 8 | accepted |
| Thread listing (representative matrix) | 3 | 1 | 264 | 8 | accepted |
| Domain room listing (representative matrix) | 4 | 1 | 264 | 8 | accepted |
| Admission snapshot | 5 | 1 | 40 | 24 | accepted |
| Cleanup | 62 | 26 | 1,064 | 1,058 | accepted |
| Alarm scheduling | 7 | 3 | 24 | 12 | accepted |

The matrix uses a fresh object and one representative operation for each
boundary. The 100-thread listing test separately populated all 100 policy
rows and measured 104/1 for `room()` and 102/1 for `getThreads()`; the current
256-row listing reservation covers both. A 180-row thread fixture put 60
records in each indexed membership branch; a forward history request returned
exactly 50 entries, `more: true`, and stayed within its 272/48 reservation.
The maximum snapshot test used a 4,096-byte text body plus a preserved
extension field and produced an 8,161-byte serialized snapshot. Its maximum
observed accepted mutation was 30/36, and each maximum-size edit was 19/20,
below the 280/280 request-ID bound.

For the three-day traffic sample, the operation rows were:

| Operation | Observed reads/writes | Reserved reads/writes |
| --- | ---: | ---: |
| Day 0 create | 30 / 36 | 288 / 288 |
| Day 1 create | 23 / 22 | 296 / 296 |
| Day 2 edit of older message | 25 / 21 | 296 / 296 |
| Day 2 create | 17 / 21 | 280 / 280 |
| Cleanup | 45 / 15 | 1,064 / 1,058 |
| History after cleanup | 6 / 1 | 264 / 40 |

The final counters for that sample were 181 observed reads and 133 observed
writes, against 2,504 reserved reads and 2,266 reserved writes. The native
SQLite file reported `databaseSize = 135,168` bytes. These values are a
small schema/data sample and are not a per-message capacity estimate.

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

The three-day cleanup advanced the internal retention floor (`history_floor` in SQLite) to `1790172000001`, removed two
old transition rows, removed the unreferenced old current message, and kept
the edited message whose latest transition was still inside the retention
window. It also removed two expired accepted-request rows without changing
the room head.

The maintenance-reserve test accepted three mutations under an explicit
1,000/1,000 foreground ceiling, rejected the next mutation, then ran cleanup
on `2026-09-23`. The previous day's foreground counter was 880 while the new
day's cleanup consumed 1,058 maintenance writes and removed three
transitions, three messages, three request rows, and three limiter rows. The
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
history:
  SEARCH transitions USING INDEX sqlite_autoindex_transitions_1
    (room_id=? AND log_id>? AND log_id<?)
cleanup:
  SEARCH transitions USING INDEX transitions_retention_idx
    (room_id=? AND commit_ms<?)
cleanup physical delete:
  SEARCH transitions USING INDEX sqlite_autoindex_transitions_1
    (room_id=? AND log_id<?)
thread before-membership branch:
  SEARCH transitions USING INDEX transitions_thread_before_idx
    (room_id=? AND previous_thread_id=? AND log_id>? AND log_id<?)
thread after-membership branch:
  SEARCH transitions USING INDEX transitions_thread_after_idx
    (room_id=? AND thread_id=? AND log_id>? AND log_id<?)
dedup expiry:
  SEARCH accepted_requests USING INDEX accepted_requests_expiry_idx (expires_ms<?)
limiter expiry:
  SEARCH principal_limits USING INDEX principal_limits_updated_idx (updated_ms<?)
```

History and thread paths use range-capable indexes. Thread history performs
two independently limited indexed scans and merges/deduplicates them in
JavaScript, so the outer `UNION` temporary B-tree is not part of the runtime
path. The cleanup source selection explicitly uses `transitions_retention_idx`
for the strict commit-time cutoff, then uses the primary-key index for the
bounded physical delete.

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
