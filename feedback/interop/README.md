# Interop harness (2026-11-15)

These are throwaway scripts from the cross-implementation run. Findings are in [../friction-interop.md](../friction-interop.md), and the summary is in [IMPLEMENTATION_FEEDBACK.md](../../IMPLEMENTATION_FEEDBACK.md#interop).

- `run.cjs`: browser scenarios. Playwright Chromium drives the apron-web dev server against each server, with a CDP virtual authenticator. It uses `lib.cjs`.
- `cross.cjs`: protocol cross-checks. Each server's pages run in Chromium, and the codes are redeemed over WebSocket at the same or the other server.
- `fakeidp/main.go`: aprond with an `external` extension that serves a fake identity provider form.
- `cf-start.sh`, `cf-tls-start.sh`: wrangler dev configurations for apron-server-cloudflare, over loopback http and local https.
- `tlsproxy.cjs`: an https front for the Vite dev server.

Paths in the shell scripts are from the session that ran them. The durable test lives in apron-server-go: `tests/interop/passkey-page.spec.ts`.
