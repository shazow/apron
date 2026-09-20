# Apron public demo Worker

A single SQLite Durable Object serves the permanent `general` room over
hibernating WebSockets. The backend supports anonymous access, discoverable
passkeys, complete-snapshot history, message replacement/deletion/restoration,
threads, and a rolling retention floor. It speaks protocol 2 with `history` and
`edit`; see [authentication and policy](docs/extensions.md) and [the implementation
specification](SPEC.md).

See the [configuration reference](docs/configuration.md) for all policy variables
and the [local cost report](docs/cost-report.md) for measured bounds and assumptions.

Use **Workers Free**, with SQLite Durable Objects. No paid plan or auxiliary
service is required. This repository does not deploy as part of installation
or tests. A paid plan's included allowance is not a spending cap.

## Local development

Use Node.js 24 and the repository's existing Nix/devenv environment. From the
repository root, `make install` installs each package from its lockfile.

Create `servers/cloudflare-worker/.dev.vars` with a random local-only secret:

```dotenv
IP_HMAC_SECRET="replace-with-at-least-32-random-characters"
```

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

Keep the IP HMAC secret stable through redeploys and daily rollover. Raw IP
addresses are never stored. Uncoordinated secret rotation would reset active
principal buckets: take admissions offline through all applicable windows
before rotating, or implement an overlapping-key migration first. Never place
production secrets in Wrangler variables, source control, fixtures, or logs.

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
3. Set the production RP ID to the site's hostname and exact HTTPS origins for
   both browser admission and RP verification. Do not include wildcard origins.
   RP changes can make previously registered credentials unusable.
4. Build the frontend, check the static-asset output, and run all checks plus
   the browser test. Review the lockfile and compatibility date together.
5. Supply `IP_HMAC_SECRET` with `npx wrangler secret put IP_HMAC_SECRET` from
   this package. Use a long random secret and keep a secure operator copy.
6. Review `wrangler.toml`: fixed DO binding, `new_sqlite_classes` migration,
   no paid-service bindings. Apply the initial migration once using the normal
   Wrangler deployment workflow. Do not rename or recreate the production
   object to work around a quota or schema issue.
7. When deployment is authorized, run `npx wrangler deploy`. Verify anonymous
   access, passkey registration/login, edits, history, duplicate retries, and
   rejected origins against the deployed endpoint.
8. Exercise idle **hibernation and wake**, then a real redeploy/reconnect. Check
   identity attachments, challenges, persistent quotas, room head/floor, alarm
   scheduling, and recovery. A local reconnect test alone does not establish
   production hibernation behavior.
9. Observe aggregate resource use and cleanup across daily rollover. Never use
   production Free quotas for exhaustive stress tests. Stop admission if actual
   costs exceed tested bounds; do not raise budgets to conceal a discrepancy.

Free-plan hard limits are the zero-overage backstop. Application quotas provide
controlled degradation for admitted work, not availability under unlimited
hostile traffic: rejected HTTP requests and incoming frames still cost platform
resources. Local calibration is not proof of production billing or availability.
