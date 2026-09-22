# Configuration reference

## Editing the deployment budget

`src/budget.ts` is the source of truth for application defaults, resource ceilings,
maintenance reserves, and admission rates. The Worker, standalone store, and
protocol parser all consume its defaults. Resource ceilings reference those
defaults rather than repeating numeric allocations. Separate calibrated parser,
payload, and memory bounds remain in that same file; increasing them requires
reviewing their consumers and repeating cost calibration.

After changing the policy, run from `servers/cloudflare-worker`:

```sh
npm run budget:generate
npm run typecheck
npm test
```

Commit the policy and generated changes together. Generation updates the marked
rate-limiter binding blocks in both Wrangler files and the edge-rule definitions
in `docs/edge-rules.generated.json`. It does not contact Cloudflare. Tests,
typechecking, and both supported deployment commands reject stale generated
configuration. Application defaults are imported directly and need no generated
copy. Use Node.js 24, as in the repository development environment.

`ADMISSION_BUDGET.requestsPerIpMinute` defaults to 10 attempted handshakes per
minute, before calling the DO. This leaves retry headroom over the five accepted
connections per IP per minute. `/` and `/ws` share a bucket. IPv4-mapped addresses
share their IPv4 bucket; native IPv6 shares a /64. Missing or failed limiter
bindings reject admission with 503. Exhaustion returns 429 and `Retry-After`.
The binding is approximate and local to each Cloudflare location, not a global
daily counter. NAT users share this limit. Development and production use distinct
limiter namespaces; additional deployments must use distinct namespace IDs too.

`ACCOUNT_USAGE_POLICY` in `src/budget.ts` defines the lightweight account-usage
stop. The Durable Object refreshes after about 1,000 incoming events, no more
often than once per minute, and treats a snapshot older than five minutes as
stale. Set `ACCOUNT_ID` and the read-only `ACCOUNT_ANALYTICS_TOKEN` secret on a
deployment to enable it. Without both values, local application limits remain
active and no analytics request is attempted. Refresh failures retain the last
successful snapshot and retry with backoff; they do not pause the service.
Set the token with `npx wrangler secret put ACCOUNT_ANALYTICS_TOKEN --config
wrangler.production.toml`; never put the token in Wrangler vars or source code.

The snapshot is account-wide and delayed. At 90% of any configured Workers Free
allowance, the object persists a stop for that UTC day, rejects new connections,
and closes live sockets. This is an early-stop signal, not an exact remaining-
quota meter: analytics lag, sampling, and other account workloads can still cause
an earlier or later platform limit.

The optional Free WAF rate rule uses `edgeRequestsPerIpWindow`,
`edgeWindowSeconds`, and `edgeBlockSeconds` from the same file. Its counting and
blocking windows must both be 10 seconds on Free. It is generated disabled because
it applies across hostnames in the zone. See [edge admission operations](edge-admission.md)
before applying rules or deploying changed budgets.

Keep the account on **Workers Free** for an absolute zero-overage boundary.
Changing this file never changes the account plan. These resource budgets are
not an account-wide dollar cap, and cannot guarantee availability under attack.

## Runtime overrides

Wrangler string variables use the exact names below. Numeric policy variables
accept camelCase, matching `src/budget.ts`, or uppercase snake case with an
optional `LIMIT_` prefix (for example `LIMIT_MAX_FRAME_BYTES`). The prefixed
form takes precedence, then uppercase, then camelCase. Omitted variables use the defaults.
Production should use the checked-in budget defaults; retain overrides for local
tests or deliberate temporary reductions. Overrides do not regenerate the native
limiter or edge rules. Remove temporary overrides before applying a budget increase.
All limits compose; reducing a global budget may prevent reaching a principal
allowance. Validate changes locally and rerun cost calibration before deployment.
Use small values for deterministic test exhaustion, not larger production limits
to make a test pass.

Every numeric variable is parsed as a positive JavaScript safe integer. `0`,
fractions, negative values, and values above `Number.MAX_SAFE_INTEGER` fail
startup. For example, `maxFrameBytes` accepts `LIMIT_MAX_FRAME_BYTES`,
`MAX_FRAME_BYTES`, or `maxFrameBytes`, in that precedence order. The same
aliases apply to every row in the numeric table; Wrangler deployments should
use the uppercase form, and local tests may use the camelCase form.

The worker validates relationships before it accepts an HTTP request or a
WebSocket. These checks are part of the deployment policy, not alternate
defaults:

- `historyDefaultLimit` cannot exceed `historyMaxLimit`, which is at most 50;
  one snapshot plus response overhead must fit `historyMaxResponseBytes`, which
  is at most 256 KiB.
- `maxTextBytes`, credential bytes, challenge bytes, and request IDs must fit
  the frame policy. Text, names, and snapshots must fit their respective
  snapshot/frame bounds; parser depth, node, embed, and metadata caps have the
  calibrated ceilings below.
- A connection's pending frame count and bytes must hold every admitted frame.
  Across `openConnections`, the pending-byte allocation is at most 32 MiB.
  Pending frames, connection rates, and limiter records have bounded ceilings.
- Per-minute and per-day budgets cannot contradict their own windows. Global
  posting, registration, identity, and processed-frame caps are fixed demo
  ceilings. Low, high, and hard storage watermarks must be strictly ordered.
- A moved message re-logs every reaction set in one record, so
  `reactionUsersPerMessage` times the per-user bound (emoji at most 64 UTF-8
  bytes each, escaped, plus the user's name) must fit `historyMaxResponseBytes`.
- Foreground plus maintenance SQL budgets must fit the daily SQL ceilings.
  Each maintenance budget is at least 520 operations, covering the one-time
  512-row bootstrap reservation and eight control rows for deferred cleanup.

The calibrated hard ceilings are `maxFrameBytes` 16 KiB, `maxTextBytes` 4 KiB,
`maxSnapshotBytes` 8 KiB, JSON depth 8, JSON nodes 2,048, request IDs 128
bytes, names 80 Unicode code points/320 UTF-8 bytes, embeds 4, history limit
50, history response 256 KiB, pending work 8 frames/128 KiB, open sockets 100,
registered identities and limiter records 10,000 each, processed frames
100,000/day, global posts 60/minute and 5,000/day, registrations 100/day,
connection frame rate 120/minute, SQL writes 80,000/day, SQL reads 3,000,000/day,
database high-water 96 MiB and hard target 128 MiB, cleanup 100 records,
thread rooms 100 with 2 KiB of client fields, reactions 64 users per message
and 16 emoji per user, and credentials/challenges 16 KiB. Operators
may lower these values but cannot raise them without changing the implementation
and recalibrating its resource model.

| Variable | Meaning |
| --- | --- |
| `RP_ID` | Explicit passkey relying-party hostname; local default `localhost` |
| `RP_ORIGINS` | Comma-separated exact WebAuthn origins; required explicitly with wildcard guest admission; never accepts wildcards |
| `ALLOWED_ORIGINS` | Exact browser-origin allowlist, or standalone `*` to admit every guest origin (including opaque/missing Origin); cannot mix `*` with explicit origins; all clients remain subject to quotas |
| `RP_NAME` | Bounded display name for browser passkey prompts |
| `ADMISSION_OFF` | Operator admission switch; `true` rejects new sockets in the entry Worker before the limiter or DO call; existing sockets remain subject to DO budgets |
| `ENVIRONMENT` | Set to `development` to enable local origin defaults when `ALLOWED_ORIGINS` and `RP_ORIGINS` are omitted |
| `NODE_ENV` | Set to `test` to enable the same local origin defaults for tests; production-like deployments must configure origins explicitly |

Numeric values are positive safe integer counts. Values named `Bytes` count
UTF-8 bytes, `CodePoints` count Unicode code points, and values named `Seconds`
are durations. `Limit`, `Embeds`, `Connections`, `Records`, and `Identities`
are item/count caps. `Bytes` on storage watermarks means effective occupied
SQLite bytes. Posting, history, authentication, frame, and admission `Minute`
limits are rolling 60-second windows. `Day` limits use the server's effective
monotonic time and UTC calendar date; a backward wall-clock jump cannot reset
them. Cleanup and deduplication run in bounded batches/records, while
`foreground*` and `maintenance*` are daily SQL operation budgets.

`threadLimit` counts thread rooms (rooms with a `parent_room_id`) and
`threadMetadataBytes` bounds a room's serialized client fields (`title`,
`intro_message` reference, `ext`). The `anonymous*` variables configure the
guest tier (the protocol v3 `guest` auth scheme); their names are unchanged.

The numeric rows are grouped by their unit and enforcement scope:

- Durations: `retentionSeconds`, `cleanupSeconds`, `challengeTtlSeconds`,
  `unauthenticatedTimeoutSeconds`, `dedupTtlSeconds`.
- Payload/storage bytes: `maxFrameBytes`, `maxTextBytes`, `maxSnapshotBytes`,
  `maxRequestIdBytes`, `maxNameBytes`, `historyMaxResponseBytes`, `pendingBytesPerConnection`,
  `databaseHighWaterBytes`, `databaseHardTargetBytes`,
  `databaseResumeLowWaterBytes`, `threadMetadataBytes`, `maxCredentialBytes`,
  `maxChallengeBytes`.
- Parser, item, and concurrency counts: `maxJsonDepth`, `maxJsonNodes`,
  `maxNameCodePoints`, `maxEmbeds`,
  `historyDefaultLimit`, `historyMaxLimit`, `concurrentHistoryPerConnection`,
  `registeredIdentityCount`, `openConnections`, `anonymousConnectionsPerIp`,
  `registeredConnectionsPerUser`, `connectionsPerIp`,
  `pendingFramesPerConnection`, `repeatedPolicyViolations`, `cleanupBatch`,
  `threadLimit`, `reactionUsersPerMessage`, `reactionEmojisPerUser`,
  `limiterRecordCap`.
- Rolling minute budgets: `historyRequestsPerUserMinute`,
  `historyRequestsPerIpMinute`, `anonymousPostsPerMinute`,
  `registeredPostsPerMinute`, `ipPostsPerMinute`, `globalPostsPerMinute`,
  `authAttemptsPerIpMinute`, `framesPerConnectionMinute`,
  `framesPerIpMinute`, `connectionAdmissionsPerIpMinute`.
- UTC-day budgets: `anonymousPostsPerDay`, `registeredPostsPerDay`,
  `ipPostsPerDay`, `globalPostsPerDay`, `registrationsPerIpDay`,
  `registrationsPerDay`, `connectionAdmissionsPerDay`,
  `processedFramesPerDay`, `sqlWritesPerDay`, `sqlReadsPerDay`,
  `foregroundWritesPerDay`, `maintenanceWritesPerDay`,
  `foregroundReadsPerDay`, `maintenanceReadsPerDay`.

| Variable | Default |
| --- | ---: |
| `retentionSeconds` | 86400 |
| `cleanupSeconds` | 3600 |
| `challengeTtlSeconds` | 120 |
| `maxFrameBytes` | 16384 |
| `maxTextBytes` | 4096 |
| `maxSnapshotBytes` | 8192 |
| `maxJsonDepth` | 8 |
| `maxJsonNodes` | 2048 |
| `maxRequestIdBytes` | 128 |
| `maxNameCodePoints` | 80 |
| `maxNameBytes` | 320 |
| `maxEmbeds` | 4 |
| `historyDefaultLimit` | 20 |
| `historyMaxLimit` | 50 |
| `historyMaxResponseBytes` | 262144 |
| `historyRequestsPerUserMinute` | 10 |
| `historyRequestsPerIpMinute` | 30 |
| `concurrentHistoryPerConnection` | 1 |
| `anonymousPostsPerMinute` | 5 |
| `anonymousPostsPerDay` | 100 |
| `registeredPostsPerMinute` | 20 |
| `registeredPostsPerDay` | 500 |
| `ipPostsPerMinute` | 30 |
| `ipPostsPerDay` | 1000 |
| `globalPostsPerMinute` | 60 |
| `globalPostsPerDay` | 5000 |
| `registrationsPerIpDay` | 3 |
| `registrationsPerDay` | 100 |
| `registeredIdentityCount` | 10000 |
| `authAttemptsPerIpMinute` | 10 |
| `openConnections` | 100 |
| `anonymousConnectionsPerIp` | 2 |
| `registeredConnectionsPerUser` | 3 |
| `connectionsPerIp` | 10 |
| `connectionAdmissionsPerIpMinute` | 5 |
| `connectionAdmissionsPerDay` | 2000 |
| `unauthenticatedTimeoutSeconds` | 30 |
| `pendingFramesPerConnection` | 8 |
| `pendingBytesPerConnection` | 131072 |
| `framesPerConnectionMinute` | 60 |
| `framesPerIpMinute` | 120 |
| `processedFramesPerDay` | 100000 |
| `repeatedPolicyViolations` | 3 |
| `sqlWritesPerDay` | 80000 |
| `sqlReadsPerDay` | 3000000 |
| `foregroundWritesPerDay` | 60000 |
| `maintenanceWritesPerDay` | 20000 |
| `foregroundReadsPerDay` | 2500000 |
| `maintenanceReadsPerDay` | 500000 |
| `databaseHighWaterBytes` | 100663296 |
| `databaseHardTargetBytes` | 134217728 |
| `databaseResumeLowWaterBytes` | 83886080 |
| `cleanupBatch` | 100 |
| `threadLimit` | 100 |
| `threadMetadataBytes` | 2048 |
| `reactionUsersPerMessage` | 32 |
| `reactionEmojisPerUser` | 8 |
| `dedupTtlSeconds` | 86400 |
| `limiterRecordCap` | 10000 |
| `maxCredentialBytes` | 16384 |
| `maxChallengeBytes` | 16384 |
