# Edge admission and quota exhaustion

The account must remain on Workers Free. Its hard quotas, rather than application
counters, prevent Workers/SQLite DO overage charges. Paid-plan included usage is
not a spending cap. This policy reduces abuse and preserves capacity where
possible; distributed attacks can still exhaust a day's allowance.

## Applying the generated rules

Edit limits in `src/budget.ts`, then run `npm run budget:generate` and review
`edge-rules.generated.json`. The production hostname is read from the production
Wrangler custom domain. This file contains rule definitions grouped by phase;
it is not a payload for replacing an entire zone ruleset.

During an authorized deployment:

1. Verify the actual account's Workers Free plan, the zone's WAF capabilities,
   available rule slots, and existing rules/Skip actions. Keep HTTP DDoS protection
   enabled. Do not enable a paid feature to install these rules.
2. Add or update `apron_invalid_request` in the zone's custom-rule phase using
   the generated expression and Block action. It is scoped to the server hostname
   and rejects unsupported paths, non-GET requests, and missing/non-WebSocket
   Upgrade headers. Header comparison is case insensitive. Have Cloudflare validate
   the expression before saving. Place it before any applicable Skip rule.
3. Optionally create `apron_admission_off`, disabled, as an emergency Block rule.
   Enabling it prevents new requests from invoking the Worker. It does not close
   already upgraded sockets. Never replace unrelated rules with this file.
4. The optional rate rule is **disabled by design**. Free WAF rate rules cannot
   filter by hostname: it would count `/` and `/ws` on `apron.chat`,
   `web.apron.chat`, and every other hostname in the zone. Enable it only after
   explicitly accepting that impact and checking the available single rate-rule
   slot. Leave it disabled otherwise; the Worker admission limiter still applies.
5. Deploy the Worker via `make deploy-worker` or the package's `npm run deploy`.
   Both check generated-policy freshness and select `wrangler.production.toml`.
   These commands do not install WAF rules. A budget change affecting an enabled
   edge rate rule requires updating that rule from the regenerated definition.

Neither generation nor local tests inspect or mutate the live account. Changes
to rules require the normal dashboard or Rulesets API deployment process. Do not
enable blanket browser challenges on WebSocket handshakes: clients cannot complete
an interactive challenge there. Anonymous custom frontends remain supported.

## Verification

After applying rules, use a handful of requests, not a quota-exhaustion load test:

- Confirm a normal handshake on both `/` and `/ws` succeeds, including a custom
  browser origin and an originless client. The app's normal connection caps apply.
- Confirm plain HTTP GET, POST, and invalid paths on the server hostname are
  blocked at the edge; check the matching rule in Security Events.
- Confirm the web and documentation hosts are unaffected by the custom rules.
- Review aggregate Worker/DO metrics and active edge definitions against the
  generated policy. Local tests verify admission behavior, not live WAF billing.

## When capacity runs low

Enable the hostname-scoped emergency edge rule to stop new Worker invocations.
If only DO admission must stop, set `ADMISSION_OFF=true` and deploy: the entry
Worker rejects before invoking the DO, but those HTTP requests still consume
Worker quota. Existing sockets continue; their messages still consume DO request
units even when application handlers reject them. Application frame limits close
abusive sockets but cannot undo already received messages.

Preserve the DO and its data. Do not delete namespaces, rotate object names, or
upgrade billing to recover. Check account-wide usage, including other workloads,
and wait for the documented 00:00 UTC daily reset when a Free quota is exhausted.
Restore admission only after investigating the traffic and remaining capacity.

Rate limits at the edge and in the Worker are approximate, with enforcement
delays and location-local counters. Neither implements an exact global request
budget. Avoid a separate quota DO: each check would itself spend a DO request.

## References

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [DO pricing and Free exhaustion](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Worker rate-limiter locality and accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [WAF Free fields, windows, and limitations](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Rules language array functions](https://developers.cloudflare.com/ruleset-engine/rules-language/values/)

The deployment checklist should record the actual zone plan and installed rule
references alongside the Worker version. That makes future budget changes and
drift investigations easier without rediscovering the account's capabilities.
