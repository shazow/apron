# Plan: conformance drivers

Status: proposal, local and not committed. Written for
[PLAN_LOOSE.md](PLAN_LOOSE.md)'s `external`; most of it applies to any plan.
Each safety condition in [EVALUATIONS.md](EVALUATIONS.md) becomes a test.

## Summary

shazow/apron ships **drivers**: programs that play the other side of the
protocol, so that an implementer can check their own server or client
without writing tests from scratch.

- **Server driver:** plays a client against a running server. It extends
  today's `tests/conformance/conform.py`.
- **Client driver:** plays a server, and the sign-in portal behind it,
  against a client. It runs normal and hostile scenarios, and reports what
  the client sent.
- **Portal drivers:** small adapters that get a server driver through a real
  server's sign-in page: a virtual passkey, a test wallet, a test inbox.

Each driver prints one line for each test, with a stable test ID and the
rule that it checks, and writes a JSON report for CI. A failure names the
rule in PROTOCOL.md and the cell in EVALUATIONS.md.

## Server driver

```text
uv run tests/conformance/conform.py wss://chat.example/ws
uv run tests/conformance/conform.py wss://chat.example/ws --scheme external --portal tests/conformance/portals/passkey.py
uv run tests/conformance/conform.py wss://chat.example/ws --scheme email --inbox imap://test@…
```

- It runs the core checks, as today, then one **profile** for each scheme in
  `server.auth`, or those named with `--scheme`.
- Tests that need no sign-in always run. Many safety tests are of this kind:
  the metadata, the checks that the authorization endpoint makes before any
  sign-in UI, error codes on the connection, and the WebAuthn begin step.
- Tests after the sign-in step need a portal driver (below). Without one,
  they are SKIP, with the reason.
- It creates accounts and signs in, so it runs against a test server.

## Client driver

```text
uv run tests/conformance/conform_client.py --listen 127.0.0.1:8765 --adapter "node my-client/test-adapter.js"
uv run tests/conformance/conform_client.py --listen 127.0.0.1:8765 --interactive
```

The client driver is an Apron server and a sign-in portal in one process.
Its portal approves at once: a GET to its authorization endpoint redirects
straight back with a code. Each scenario configures the driver, lets the
client sign in, and checks the frames and HTTP requests that the client
sends.

Two ways to drive a client:

- **Adapter (automatic):** the client's author writes a small program that
  takes commands on stdin and acts on the client: connect to a URL, sign in
  with a scheme, type a code, and report when the client stops. The client
  must let the adapter replace "open this URL in a browser", so that the
  driver can return the redirect. OAuth libraries such as AppAuth already
  have this hook.
- **Interactive (semi-automatic):** no adapter. The driver prints what to
  do, such as "Sign in to 127.0.0.1:8765 with external now", and the person
  uses the client's real UI. The driver's portal shows an Approve button,
  then redirects. The driver still checks everything that the client sends.

A test passes when the client sends the right frames, and fails when it
sends something it must not, such as a code after a wrong `iss`. A refusal
is the absence of a frame, so the driver waits a short, fixed time, and the
adapter can end the wait early by reporting that the client stopped.

Hostile scenarios need two servers with different origins. The driver
listens on two ports, which are different origins and different `resource`
values. WebAuthn RP ID scenarios use names under `localhost`, such as
`a.localhost` and `b.localhost`, which browsers send to the loopback address.

The scenarios use the format of `tests/fixtures/wire`, with one new step
type for the portal's HTTP exchange. So a client can also run them inside
its own test suite with the existing fixture runners, as apron-web and
apron-server-go do today.

## Portal drivers

A portal driver takes an authorization URL and returns the redirect URL. It
is a script that the operator picks, or writes for their own portal.

| Driver | For | How |
|---|---|---|
| `passkey.py` | a portal with passkeys, such as server.apron.chat or Pocket ID | Playwright with Chromium's virtual authenticator, which registers and uses a passkey without hardware |
| `wallet.py` | a SIWE portal | an injected wallet with a fixed test key |
| `oidc.py` | a portal that sends the user on to an OpenID Connect provider | chains the provider's own driver |
| `manual` | anything | prints the URL; the person signs in and pastes the redirect URL back |

For email, `--inbox` gives the driver a test mailbox to read codes and links
from.

## Results

- **PASS**, **FAIL** (a MUST), **WARN** (a SHOULD), and **SKIP** (with the
  reason), as today.
- **MANUAL:** a rule that a machine cannot check, such as "the portal shows
  the redirect's host". The driver prints it as a checklist item.
- `--json report.json` writes each result with its test ID, the PROTOCOL.md
  anchor, and the EVALUATIONS.md attacker.

## Test IDs

`<scheme>.<area>.<name>`, where the area is an attacker from EVALUATIONS.md
(`A1` to `A5`) or a plain area such as `shape`. "Needs" says what a test
requires beyond a connection.

### Core sign-in

| ID | Side | Checks | Needs |
|---|---|---|---|
| `auth.order.barrier` | server | requests after `auth` use its result (exists today) | — |
| `auth.shape.unsupported` | server | a defined scheme that is not offered is `unsupported` (exists today) | — |
| `auth.shape.unknown` | server | an unknown scheme is `invalid_params` | — |
| `auth.order.no-dedup` | server | `auth` runs again on a repeated `id` | — |

### `token`

| ID | Side | Checks | Needs |
|---|---|---|---|
| `token.shape.denied` | server | an invalid token is `denied` | — |
| `token.shape.latest` | client | saves the latest `token` from a result, and uses it next | adapter |
| `token.A1.per-server` | client | never sends one server's token to another | adapter, two ports |

### `webauthn`

| ID | Side | Checks | Needs |
|---|---|---|---|
| `webauthn.shape.begin` | server | a register begin requires discoverable credentials and user verification; a login begin has no `allowCredentials` | — |
| `webauthn.A4.one-ceremony` | server | a finish on another connection, or a second finish, is `denied` | passkey |
| `webauthn.A1.token-origin` | server | a token from a finish does not work from another origin | passkey |
| `webauthn.A1.rp-id` | client | does not run a ceremony whose RP ID is not the server's host or a domain above it | adapter or interactive, `*.localhost` |

### `email`

| ID | Side | Checks | Needs |
|---|---|---|---|
| `email.A5.no-enumeration` | server | a proposal returns `{}` for every address | — |
| `email.A5.attempts` | server | a few wrong codes cancel the proposal | inbox |
| `email.A4.state` | server | each link carries the proposal's `state` unchanged | inbox |
| `email.shape.code-with-state` | server | a short code works on another connection with the proposal's `state`, and not without it | inbox |
| `email.shape.addition` | server | an addition returns `you` | inbox |
| `email.A1.link-server` | client | drops a link whose `server` is not the server that it proposed to | adapter |
| `email.A1.code-names-server` | server | MANUAL: the email gives the server's address | — |

### `external`

Server, without sign-in:

| ID | Side | Checks |
|---|---|---|
| `external.shape.frame` | server | `server.external` is present; without `issuer`, `authorization_endpoint` is on the server's origin |
| `external.shape.metadata` | server | the issuer's metadata exists, its `issuer` is identical, it lists `S256`, and it says that it sends `iss` |
| `external.shape.cors` | server | the metadata and the token endpoint allow cross-origin requests |
| `external.A3.pkce-required` | server | a request without `code_challenge`, or with `plain`, is refused |
| `external.A1.resource` | server | a `resource` other than the server's origin is refused |
| `external.A2.redirect-uri` | server | `javascript:`, a scheme without a `.`, and non-loopback `http` are refused |
| `external.shape.invalid-params` | server | `external` without `code` or `token` is `invalid_params` |
| `external.A5.bad-code` | server | an unknown code is `denied` |

Server, after the portal:

| ID | Side | Checks |
|---|---|---|
| `external.shape.redirect` | server | the redirect carries `code`, `state`, and `iss` |
| `external.shape.redeem` | server | redeeming on the connection returns `you` and `token` |
| `external.shape.token-endpoint` | server | the token endpoint's access token works with `scheme: "token"` |
| `external.A3.verifier` | server | a wrong `code_verifier` is `denied` |
| `external.A3.single-use` | server | a second redemption is `denied` |
| `external.A3.redirect-bound` | server | a different `redirect_uri` is `denied` |
| `external.A4.addition` | server | on a signed-in connection, a code for a new identity adds it, and returns `you` |
| `external.A4.no-switch` | server | on a signed-in connection, a code for another account's identity is `denied` |
| `external.shape.declined` | server | a declined sign-in redirects with `error=access_denied` |
| `external.A2.consent` | server | MANUAL: the portal shows the server, and the redirect's host or scheme |

Server with a foreign issuer:

| ID | Side | Checks | Needs |
|---|---|---|---|
| `external.A1.aud` | server | a token from the issuer for another `resource` is `denied` | a second API at the issuer |
| `external.shape.proxy-redeem` | server | a code redeemed on the connection works | portal |

Client:

| ID | Side | Checks |
|---|---|---|
| `external.A3.pkce` | client | the authorization request uses `S256`, and the verifier has enough entropy |
| `external.A4.state` | client | `state` is present, and differs on each sign-in |
| `external.A1.resource` | client | `resource` is the origin that the client is connected to, also when the frame names a foreign issuer |
| `external.A1.iss` | client | does not redeem after a redirect with the wrong `iss` |
| `external.A4.wrong-state` | client | does not redeem after a redirect with another `state` |
| `external.shape.reconnect` | client | after the driver drops the connection mid-sign-in, the client reconnects and redeems |
| `external.shape.declined` | client | after `error=access_denied`, sends nothing, and reports that it stopped |
| `external.A2.webview` | client | MANUAL: the portal opens in the system browser or a sign-in session, not an embedded web view |

### Proof of possession

From [RESEARCH_DPOP_DBSC.md](RESEARCH_DPOP_DBSC.md). One test applies now;
the rest apply once servers bind tokens (PLAN_LOOSE.md, Forward
compatibility). The drivers then need a JOSE library, which `uv` scripts can
declare.

Now:

| ID | Side | Checks |
|---|---|---|
| `external.A6.cnf` | server | an issuer token with `cnf` and no proof is `denied` |
| `external.A3.no-dpop-jkt` | client | the simple path's authorization URL has no `dpop_jkt` |
| `external.shape.token-type` | server | the token endpoint returns `"Bearer"` unless `server.dpop` is present |

Once bound tokens exist:

| ID | Side | Checks |
|---|---|---|
| `token.shape.unbound-default` | server | without `dpop`, the result has no `token_type` or `"Bearer"`, and the token works without a proof |
| `token.shape.bound` | server | with `dpop`, the result has `token_type: "DPoP"` |
| `token.A6.needs-proof` | server | a bound token without `dpop` is `denied` |
| `token.A6.wrong-key` | server | a proof by another key is `denied` |
| `token.A6.other-connection` | server | a proof with another connection's nonce is `denied`, with `data.dpop_nonce` |
| `token.A6.htu` | server | a proof for another address is `denied` |
| `token.A6.ath` | server | a proof whose `ath` does not match `token` is `denied` |
| `token.A6.jti` | server | a second proof with the same `jti` on one connection is `denied` |
| `token.shape.alg` | server | `alg: none`, HS256, and a `typ` other than `dpop+jwt` are `denied` |
| `external.shape.foreign-dpop` | server | redemption works with an issuer that requires DPoP, such as Keycloak with "Require DPoP bound tokens" |
| `token.shape.bearer-fallback` | client | after sending `dpop` to a server that returns no `token_type`, uses the token without a proof |
| `token.shape.nonce-retry` | client | after `denied` with `data.dpop_nonce`, retries once with that nonce, and not again |
| `token.A1.htu` | client | signs `htu` as the address that it connected to |
| `token.A6.no-pipeline` | client | sends no requests after an `auth` with a proof that has no nonce |
| `token.A6.non-extractable` | client | MANUAL or adapter: a web client's key is non-extractable |

## Design choices that make this work

Wire rules, for the plan that we pick:

1. **One result from every portal.** Each method behind the portal ends in
   the same redirect: `code`, `state`, and `iss`. So every test after the
   portal is the same, whatever the method. (PLAN_LOOSE.md has this; v10's
   `external` does not, with fragments, typed codes, and connection binding.)
2. **Checks before the human step.** The authorization endpoint SHOULD
   check its parameters before it shows any sign-in UI. Then most server
   safety tests need no portal driver.
3. **A fixed default issuer.** The issuer is the server's origin unless the
   frame names one, so the driver always knows where to look.
4. **Errors that tell causes apart where safety depends on it.** `denied`
   for a bad credential, `invalid_params` for a malformed request, and
   `unsupported` for an unoffered scheme, as today.

Client guidance:

5. **A replaceable "open this URL".** Clients SHOULD let a test harness
   replace the browser step. Without it, only interactive mode works.

Repository conventions:

6. **Stable test IDs in the spec's security text.** Each §5.2 guard keeps one
   ID, and EVALUATIONS.md uses the same IDs, so the grid, the rules, and the
   drivers stay in step.
7. **Few UI-only rules, each labelled.** Each one becomes a MANUAL item, not
   a silent gap.

## Packaging and CI

- Single-file `uv` scripts, like `conform.py`, so that `uv run` installs
  their dependencies. Portal drivers that use a browser depend on
  Playwright, and only they do.
- shazow/apron's CI runs the server driver against the minimal servers, as
  today, and the client driver against a small reference client.
- Implementations run the drivers in their own CI: apron-server-cloudflare
  and apron-server-go with the server driver and the passkey portal driver,
  apron-web with the client driver through an adapter.

## Phases

1. Server driver: core sign-in, `token`, and the `external` and `webauthn`
   tests that need no sign-in. The JSON report.
2. Portal drivers: `manual` and `passkey.py`. The `external` tests after the
   portal.
3. Client driver: the auto-approving portal, two ports, the adapter
   protocol, and the `external` and `token` client tests.
4. Interactive mode.
5. `email` with an inbox, `webauthn` client tests on `*.localhost`, and the
   foreign-issuer profile.

## Limits

- MANUAL rules stay manual: consent screens, the text of emails, and which
  browser a client uses.
- A server's WebAuthn checks are tested with a virtual authenticator, not
  with the platform authenticators that users have.
- Foreign-issuer tests depend on how the operator set up the issuer.
- A pass means that the tested rules hold. It does not cover a client's UI,
  or everything in PROTOCOL.md.

## Open questions

1. Where does the client driver live: in shazow/apron next to `conform.py`,
   or in a repository of its own?
2. Is the adapter protocol JSON lines over stdin and stdout, or a small HTTP
   API that the driver calls?
3. Should "Clients SHOULD let a harness replace the browser step" be a rule
   in PROTOCOL.md, or guidance in a separate implementer's guide?
4. Should §5.2's guard lines carry their test IDs in the text, or should a
   table in the repository map IDs to anchors?
