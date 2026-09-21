# Apron public demo Worker

A single SQLite Durable Object serves the permanent `general` room over
hibernating WebSockets. The backend supports anonymous access, discoverable
passkeys, complete-snapshot history, message replacement/deletion/restoration,
threads, and a rolling retention floor. It speaks protocol 2 with `history` and
`edit`; see [authentication and policy](docs/policy.md) and [the implementation
specification](SPEC.md).

See the [configuration reference](docs/configuration.md) for all policy variables
and the [local cost report](docs/cost-report.md) for measured bounds and assumptions.

Edit resource and admission budgets in [`src/budget.ts`](src/budget.ts), then run
`npm run budget:generate` from this directory. It updates the native Worker rate
limiter configuration and reviewable edge-rule definitions; it does not deploy.
The entry Worker rejects excessive connection attempts before calling the DO.
See [edge admission operations](docs/edge-admission.md) for applying WAF rules,
their Free-plan limitations, and the quota-exhaustion runbook.

For an additional delayed account-wide safety stop, configure `ACCOUNT_ID` and
the `ACCOUNT_ANALYTICS_TOKEN` secret. The Durable Object refreshes account usage
periodically and keeps local limits as the fallback when analytics is unavailable.
Provision it with `npx wrangler secret put ACCOUNT_ANALYTICS_TOKEN --config wrangler.production.toml`.

Use **Workers Free**, with SQLite Durable Objects. No paid plan or auxiliary
service is required. This repository does not deploy as part of installation
or tests. A paid plan's included allowance is not a spending cap.

## Local development

Use Node.js 24 and the repository's existing Nix/devenv environment. From the
repository root, `make install` installs each package from its lockfile.

No secret provisioning is required for local development. Production can run
with local limits alone; configure the optional analytics secret above to enable
the delayed account-wide safety stop.

Start `make dev-worker` and `make dev-web` in separate terminals, then open
`http://localhost:5173`. The existing frontend proxy connects to port 8080.
Use **localhost**, matching the development passkey RP ID and origin.
Wrangler persists local SQLite state between runs. Do not delete its state
while investigating restart-safe quotas or identity recovery.

```sh
make test-worker
make test-worker-browser
```

The first command runs pure-policy and actual Workers runtime tests. The
second starts an isolated local Wrangler serving the built frontend and uses Chromium's
virtual authenticator against the real verifier. Existing browser prerequisites
are documented in [DEVELOPMENT.md](../../DEVELOPMENT.md). Tests use local
resources, never production account quotas.

On NixOS, enter `devenv shell` before running Wrangler or Workers tests. The
repository sets `MINIFLARE_WORKERD_PATH` to a launcher using Nix's ELF loader
and libraries with the npm lockfile's workerd executable. It does not patch
`node_modules` or require system-wide `nix-ld`. Re-enter the shell after changing
`devenv.nix`. Other platforms use the normal npm executable.

## Connecting a custom frontend

Point a browser WebSocket client at `wss://server.apron.chat/` (`/ws` is also
accepted). No frontend registration, access token, or origin approval is needed.
For example, run this from your localhost frontend's browser console:

```js
const socket = new WebSocket('wss://server.apron.chat/');
socket.onmessage = ({ data }) => {
  const frame = JSON.parse(data);
  console.log(frame);
  if (frame.method === 'server') {
    socket.send(JSON.stringify({ id: 'guest', method: 'auth', params: { scheme: 'anonymous' } }));
  } else if (frame.id === 'guest' && frame.result) {
    socket.send(JSON.stringify({ id: 'history', method: 'history', params: { room_id: 'general' } }));
  }
};
```

Use the protocol's `message` and `thread` requests to exercise posting, editing,
deletion/restoration, and threads. This is a shared public `general` room, not
an isolated sandbox: test messages are visible to others, guest ownership lasts
only for the socket, and IP/resource quotas and retention still apply. Changing
frontend origins does not give an IP a fresh allowance. Honor `retry_after`.

The server advertises only `anonymous` authentication to custom frontends.
`web.apron.chat` additionally receives `webauthn` and `token`; inspect each connection's
`server.params.auth` rather than assuming passkeys are available everywhere.
A frontend with a Content Security Policy must permit the endpoint in
`connect-src` (for example, `connect-src wss://server.apron.chat`). Wildcard
admission cannot override the frontend's own browser policies.

## User-visible policies

Only roughly the last day of transitions is retained. Hourly cleanup normally
exposes 24–25 hours; quota exhaustion may delay physical deletion. The room ID
and historical head never rotate. Recent edits can keep old messages visible.
This is not secure erasure, and says nothing about provider backups or copies
on clients.

Anonymous identities last only for their socket, including hibernation. A
reconnect receives a new guest identity, so earlier anonymous messages cannot
be edited or deduplicated across that reconnect. A passkey creates a separate,
stable registered identity; it does not inherit guest message ownership.
Passkeys require authentication on each new connection and do not prevent
multiple registrations by one person.

Anonymous posting is shared by IP (native IPv6 grouped by /64): five accepted
mutations per rolling minute and 100 per UTC day. Registered users receive
20/minute and 500/day, subject to the common IP and global limits. NAT users
share allowances. Creates, edits, deletion, restoration, and thread changes
all consume posting quota. Matching accepted request retries consume lookup
and frame resources, but do not post again. Request deduplication lasts 24 hours.

Temporary limits return `retry_after` with `data.ms`; clients back off. Daily
posting/write exhaustion makes the demo read-only while affordable reads remain
available. History exhaustion returns an error. Registration caps do not revoke
existing passkeys. Permanent identity/thread caps return `denied`. Storage
pressure suspends growth and retains the published history boundary; it never
shortens history to accept another post. Global frame exhaustion closes sockets
and rejects new admissions until replenishment.

## Operations and secrets

IP rate limits use the first 128 bits of SHA-256 of the canonical address key,
encoded as 22 base64url characters. IPv4-mapped IPv6 shares its IPv4 key; native
IPv6 is grouped by /64. No IP secret or backup is needed. These internal hashes
are compact identifiers, not anonymization: candidate IPs can be hashed to
recover a match. Neither raw IPs nor these keys are sent to chat clients.

Switching from the former keyed hashes resets per-IP buckets once as clients
reconnect; existing buckets expire through normal cleanup. User and global
quotas, credentials, and chat history are unchanged. Keep the hash format stable
across future deployments to preserve active IP windows.

The public Worker reaches exactly `DEMO.getByName("public-demo-v1")`. URL,
query, room, and identity input cannot select another object. Do not expose a
second entry point or bind the namespace to an unrelated public Worker.
Requests from other Workers need particular care: Cloudflare's subrequest IP
semantics differ from direct client requests. The entry point fails admission
when trusted client attribution is missing or unusable.

Maintenance uses one alarm scheduler shared with authentication deadlines.
Expiration first publishes a durable monotonic floor, then deletes bounded
batches. Budget authority, credentials, and the room head are independent of
retention. SQLite frees pages for reuse without necessarily shrinking the file.
The inspected [workerd implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.c++)
reports occupied pages through `databaseSize`, excluding freelist pages. Pressure
stops growth at 96 MiB and resumes only below 80 MiB; transactions also check the
128 MiB hard target before committing. Recheck this runtime assumption on upgrades.
Do not delete the database or run unmetered VACUUM as a space-recovery measure.

## Deployment checklist (manual, separately authorized)

The production backend at `wss://server.apron.chat/` uses
`wrangler.production.toml`. The frontend is deployed separately at
`https://web.apron.chat` using `clients/web/wrangler.toml`; `apron.chat` is
reserved for static documentation. The production backend has no static assets.
WebSocket upgrades use `/`; `/ws` remains an alias for existing clients.
The default development Worker is `apron-cloudflare-demo-dev`; it is separate
from the production Worker `apron-cloudflare-demo`. It keeps serving the
frontend for local development and browser tests. Keep bindings, migrations,
and compatibility settings in sync.
Custom Domains configure DNS and HTTPS through Cloudflare; workers.dev and
preview URLs are disabled for both deployments.

The RP ID stays `apron.chat` to preserve existing passkey credentials across
the move. Guest connections accept every origin, including localhost, LAN
frontends, local files (opaque origins), and clients without Origin. Passkey
verification allows only the exact `https://web.apron.chat` origin. Browser
local storage is origin-specific, so saved names and server preferences do not
move from the apex automatically.

From `devenv shell`, authenticate:

```sh
cd servers/cloudflare-worker
npx wrangler login
npx wrangler whoami
```

After completing the checks below, run `make deploy-worker` and
`make deploy-web` from the repository root. The former deploys only the backend;
the latter builds the frontend with `wss://server.apron.chat/` as its default
server and deploys the static assets using the existing Worker package's Wrangler.
For direct Wrangler production commands, always pass
`--config wrangler.production.toml` and run `npm run budget:check` first.

1. Verify the **actual account is on Workers Free** and SQLite Durable Objects
   are enabled. Inventory other Workers, DO namespaces, and staging workloads;
   their usage shares the same account allowances. Do not switch billing plans.
2. Recheck [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
   and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
   The documentation checked 2026-09-20 lists daily Free allowances of 100,000 DO
   requests, 13,000 GB-seconds, 5 million SQLite rows read, 100,000 rows written,
   5 GB account SQLite storage, and 100,000 entry Worker requests. Reserve
   headroom for all account workloads. Confirm the application cost tests and
   configured limits still fit; 5,000 daily posts is a ceiling, not a promise.
3. Set `ALLOWED_ORIGINS = "*"` for the public reference server. Keep the
   passkey RP ID `apron.chat` and the explicit, exact `RP_ORIGINS` allowlist;
   wildcard guest admission never enables wildcard passkey verification.
   RP changes can make previously registered credentials unusable.
4. Build the frontend, check the static-asset output, and run all checks plus
   the browser test. Review the lockfile and compatibility date together.
5. Review `wrangler.production.toml`: fixed DO binding, `new_sqlite_classes` migration,
   no paid-service bindings. Apply the initial migration once using the normal
   Wrangler deployment workflow. Do not rename or recreate the production
   object to work around a quota or schema issue.
6. When deployment is authorized, run `make deploy-worker deploy-web` from the
   repository root. Verify anonymous access, passkey registration/login, edits, history,
   duplicate retries, custom-origin guest access, and rejection of passkey
   requests from unapproved origins against the deployed endpoint.
7. Exercise idle **hibernation and wake**, then a real redeploy/reconnect. Check
   identity attachments, challenges, persistent quotas, room head/floor, alarm
   scheduling, and recovery. A local reconnect test alone does not establish
   production hibernation behavior.
8. Observe aggregate resource use and cleanup across daily rollover. Never use
   production Free quotas for exhaustive stress tests. Stop admission if actual
   costs exceed tested bounds; do not raise budgets to conceal a discrepancy.

Free-plan hard limits are the zero-overage backstop. Application quotas provide
controlled degradation for admitted work, not availability under unlimited
hostile traffic: rejected HTTP requests and incoming frames still cost platform
resources. Local calibration is not proof of production billing or availability.

Failed WebSocket handshakes can be diagnosed with an HTTP GET to the same `/`
or `/ws` URL with `?apron_connection_status=1`. The response exposes `Retry-After`
through CORS and disables caching. It checks live connection capacity and the
cached daily SQL budget without reserving SQL work or opening a socket; it is
advisory, and the real upgrade still enforces every admission gate. The native
per-IP attempt limiter also applies to these probes.

When the daily SQL guard stops work, a `daily_budget_exhausted` log records the
reserved counters and limits once per object instance/day. These are conservative
reservations, not Cloudflare's measured usage. Compare them with account analytics
before tuning operation costs. Daily reservations survive redeploys and reset at
UTC midnight; resetting the object or its counters would discard that protection.

Idle cleanup runs use indexed existence checks before reserving a deletion batch.
If no records are eligible, they only advance the cleanup deadline. Within an
object instance, a known adequate future alarm is reused without SQL bookkeeping;
earlier deadlines, fired alarms, cleanup runs, and hibernation wakes are rechecked.

<!-- TODO: Calibrate foreground SQL reservations against representative reconnect,
auth, and history workloads. On 2026-09-21 the app stopped at 59,976 reserved
foreground writes after 93 admissions, while account analytics reported about
13,165 actual writes. Preserve crash/rollback accounting and maintenance headroom
when reducing over-reservation; aggregate analytics alone cannot justify refunds. -->
