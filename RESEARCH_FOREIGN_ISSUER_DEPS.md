# Can libraries shrink the cost of foreign-issuer mode?

Research date: 2026-11-16. Spec: `apron` PROTOCOL.md §4.12 at 72a6e2b (branch `claude/charming-faraday-nrrajr`, after dee3bde).
Go: `apron-server-go` at 44aef05. Cloudflare: `apron-server-cloudflare` at e1d1500.
All prototypes are in detached worktrees under `scratchpad/deps-proto/`. No branches were created or moved, and nothing was pushed.

Evidence files are in `scratchpad/deps-proto/evidence/`:
- `go-test-additions.patch`: the three new Go tests and the fake-issuer settings they use.
- `go-variantA-full.patch`: Go variant A (go-oidc + go-jose + x/oauth2).
- `go-variantB-full.patch`: Go variant B (go-jose + x/oauth2 only).
- `go-orig-test-race.txt` and `go-proto-test-race.txt`: full `go test -race ./...` results.
- `cf-bundle-sizes.txt`, `cf-proto-tests.txt`, `cf-foreign-issuer*.ts`: Cloudflare bundle sizes, test output, and prototype sources.

The `scratchpad/` prefix means `/tmp/claude-0/-home-user/20bcd46f-cefb-56b4-8905-7ffb49d5fe85/scratchpad/`.

Line counting method, used for every number below:
- **raw** is `wc -l`.
- **code** excludes blank lines and `//` comment lines. `foreign.go` has a lot of comments, so code lines are the fairer measure.

---

## Part 1: Go

### 1.1 What exists today (hand-written)

| File | Role | raw | code |
|---|---|---:|---:|
| `internal/auth/external/foreign.go` | discovery, begin, redeem, userinfo, claim checks, JWKS cache, HTTP fetch | 397 | 317 |
| `internal/auth/external/jwt.go` | JWK→key (RSA/EC/OKP), compact JWS parse, `typ` check, signature verify (RS/PS/ES/EdDSA) | 182 | 161 |
| **Foreign-issuer core (replaceable surface)** | | **579** | **478** |
| `apron/external.go` (`ExternalIssuer` type and doc), `apron/server.go:766-774`, `aproncmd/aprond.go` flags | wiring (not replaceable) | ~30 code | |
| `internal/auth/external/jwt_test.go` | unit test of `jwt.go` | 79 | 68 |
| `apron/external_foreign_test.go` | fake issuer and end-to-end tests | 406 | 339 |

Code lines per function in the original `foreign.go`:

| Part | code | Could a library replace it? |
|---|---:|---|
| `discover` (RFC 8414 then OIDC, userinfo merge, cache, stale fallback) | 48 | No (see 1.2) |
| `keysFor` (JWKS cache, kid miss, 1/min throttle) | 39 | Yes (go-oidc `RemoteKeySet`) |
| `check` (claims: iss/sub/exp/nbf/aud/cnf) | 39 | Partly (go-jose `jwt.Claims`) |
| `Auth` (begin, dispatch) | 33 | No (protocol) |
| `redeem` (token request) | 27 | Mostly (x/oauth2) |
| `userinfo` | 21 | Barely (go-oidc `UserInfo`) |
| `signIn`, `lookup`, `NewForeign`, types, consts, imports | ~80 | No |
| `fetch` (1 MiB cap, JSON) | 15 | Still needed by discovery |
| `audienceIncludes` | 11 | Yes (go-jose `jwt.Audience`) |
| `jwt.go` (all) | 161 | Yes (go-jose) |

The replaceable ceiling is about 290 code lines out of 478: `jwt.go`, `keysFor`, `audienceIncludes`, most of `redeem` and part of `check`. The other ~190 lines are protocol logic, or things no library does.

**Dependency policy:** nothing in `DEVELOPMENT.md`, `README.md` or `SERVER.md` is written about third-party dependencies. The only related rule is "Extract shared libraries only when there is another consumer", which is about internal code.
- `go.mod` has 12 direct and 16 indirect requirements.
- `go list -m all` lists 49 modules, and `go mod graph` has 123 edges.
- `cmd/aprond` links 93 non-std packages.
- `github.com/golang-jwt/jwt/v5` is already an indirect dependency, through go-webauthn. go-jose is not.
- The repo's own JOSE code (`jwt.go`) is evidence of a habit of hand-rolling, not of a written rule.

### 1.2 Library evaluation (from module source in GOMODCACHE, not from memory)

The weight columns show what the library adds to *this* module (`go get` + `go mod tidy` + a blank import in `internal/auth/external`):
- **Δ modules**: `go list -m all`
- **Δ graph**: `go mod graph` edges
- **Δ linked pkgs**: non-std packages in `go list -deps ./cmd/aprond`

The capability columns:
- **RFC 8414 discovery**: whether the library can discover `/.well-known/oauth-authorization-server`.
- **RFC 9068 `typ`**: whether it checks `at+jwt`.
- **kid-miss refresh**: whether it refetches the JWKS when a token names an unknown kid.

| Library (version, date) | License | Releases in last 12 mo | Module source size | Δ modules | Δ graph | Δ linked pkgs | RFC 8414 discovery | RFC 9068 `typ` | kid-miss refresh |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| `coreos/go-oidc/v3` v3.21.0 (2026-09-01) | Apache-2.0 | 5 | 276 KB | +4 (with go-jose, x/oauth2, cloud metadata*) | +9 | +6 | **No.** `NewProvider` fetches only `issuer + /.well-known/openid-configuration` (oidc.go:301). `ProviderConfig` takes endpoints you give it. | **No** (no `at+jwt` anywhere). `IDTokenVerifier` is for ID tokens: `aud` == one ClientID, 5-min nbf leeway, no exp leeway. | **Yes, but unthrottled.** `RemoteKeySet.verify` refetches on *any* failed verification, whether the kid is unknown or the signature is bad (jwks.go:155-189). Concurrent fetches are deduplicated by an in-flight guard. There is no rate limit and no size cap (`io.ReadAll`). Fetches use the constructor's ctx, not the request's. |
| `go-jose/go-jose/v4` v4.1.9 (2026-11-05) | Apache-2.0 | 6 | 1.3 MB | +1 | +2 | +4 | n/a | No (headers are exposed via `ExtraHeaders`, so the check is 3 lines). It rejects `crit` and checks an alg allowlist at parse. | n/a (JWK/JWKS types only, with `JSONWebKeySet.Key(kid)`) |
| `golang.org/x/oauth2` v0.38.0 (2026-11-06) | BSD-3 | 5 | 908 KB | +2 (incl. cloud metadata*) | +3 | +2 | No | n/a | n/a. Has PKCE `VerifierOption`, and `SetAuthURLParam("resource",…)` works on `Exchange`. 1 MiB response cap. |
| `lestrrat-go/jwx/v3` v3.4.0 (2026-10-23) | MIT | 6 | 3.7 MB | **+17** | **+64** | **+41** | No | No built-in `typ` validator (`grep at+jwt` gives 0 hits) | `jwk.Cache` (httprc) refreshes on an interval with background goroutines. A kid miss needs a manual `Cache.Refresh`. |
| `zitadel/oidc/v3` v3.52.0 (2026-11-10) | Apache-2.0 | 46 | 1.9 MB | **+29/+30** | **+80/+88** | **+41/+44** | Defines the constant, but only for its *server* (`op`). `client.Discover` fetches one URL (OIDC by default, overridable), with no fallback. | No | `client/rs` is introspection-only (needs client credentials). The JWT access-token verifier lives in the server package `op`, which pulls in chi, otel, gorilla/securecookie and others. |

\* `cloud.google.com/go/compute/metadata` appears in the module graph through x/oauth2's go.mod, but no package from it is compiled into `aprond`.

None of the five libraries checks the RFC 9068 `typ`, and none does RFC 8414 discovery with an OIDC fallback (`grep -rn "at+jwt"` and `"oauth-authorization-server"` over the sources). That glue stays whatever library is used. jwx and zitadel cost 4–7× the dependency weight of go-oidc + go-jose + x/oauth2 and replace no more code, so they were not prototyped.

### 1.3 Prototypes

**Variant A: go-oidc `RemoteKeySet` + go-jose + x/oauth2** (`deps-proto/go`, `evidence/go-variantA-full.patch`)
- `jwt.go` deleted.
- Signature check: `jose.ParseSigned(token, allowlist)`, then the `typ` check, then `RemoteKeySet.VerifySignature`.
- Claims: `jwt.Claims` + `ValidateWithLeeway(Expected{Issuer, Time}, 1m)` + `Audience.Contains`.
- Token exchange: `oauth2.Config.Exchange` with `AuthStyleInParams`, `VerifierOption` and `resource`.
- Userinfo: go-oidc `ProviderConfig{UserInfoURL}.NewProvider().UserInfo()`.
- To keep the one-minute JWKS throttle, the key set gets an `http.Client` whose `RoundTripper` lets one request through per minute (17 lines).

**Variant B: go-jose + x/oauth2 only** (`deps-proto/go-eval`, `evidence/go-variantB-full.patch`)
- Same as A, but `keysFor` stays hand-written (33 code lines).
- `keysFor` uses `jose.JSONWebKey` to parse each key, skips keys it cannot use, and keeps the RSA ≥2048 floor (a 4-line `weakRSA`).
- Userinfo stays hand-written.

#### Lines (non-test) for the foreign-issuer core (`foreign.go` + `jwt.go`)

| | raw | code | Δ code | Direct deps added | Δ `go list -m all` | Δ linked pkgs | `aprond` binary (`-s -w -trimpath`) |
|---|---:|---:|---:|---|---:|---:|---:|
| Original | 579 | 478 | | none | | | 20,287,751 B |
| Variant A | 380 | 289 | **−189 (−40%)** | go-oidc v3.21.0, go-jose v4.1.9, x/oauth2 v0.38.0 | +4 | +7 (93→100) | 20,594,951 B (**+307 KB, +1.5%**) |
| Variant B | 394 | 305 | **−173 (−36%)** | go-jose v4.1.9, x/oauth2 v0.38.0 | +3 | +6 (93→99) | 20,574,471 B (+287 KB, +1.4%) |

Where the remaining code lines go in A: `discover` 52, `Auth` 33, `check` 31, `userinfo` 24, `redeem` 20, `signIn` 18, `fetch` 15, throttle 17, `verifyAccessToken` 12, other ~67. The diff of A against the original is +214/−300 lines over 7 files, including tests, go.mod and go.sum.

#### Tests

Existing tests:
- `apron/external_foreign_test.go`: its 3 tests pass **unmodified** in A and B. The only change to that file is new fake-issuer settings for the added tests, listed below.
- `jwt_test.go` had to be **rewritten** (79 → 75 lines), because it tests the internals that were deleted. The weak-RSA case was dropped in A (the feature is gone). All `typ`, none/HS256 and wrong-key cases were kept, and they pass.

Results:
- `make check` (`go vet ./...`) passes for A and B.
- `go test -race ./...` on A and on B: every package that passes on the original also passes. The only failure is the new rotation test, which the original fails too (`evidence/go-orig-test-race.txt`, `go-proto-test-race.txt` for A, `go-variantB-test-race.txt` for B).

The existing fake issuer serves both metadata documents and one static key, so the existing tests cannot tell an OIDC-only or rotation-blind library apart. Three tests were added (`apron/external_foreign_proto_test.go`):

| New test | Original | A without throttle glue | A (with glue) | B |
|---|---|---|---|---|
| Discovery: RFC 8414 document only, and OIDC document only | pass | pass | pass | pass |
| Key rotation: a token with a new kid within 60 s of the last JWKS fetch | **fail** (by design: one fetch a minute) | pass | **fail** (same as original) | **fail** (same as original) |
| 5 forged tokens with an unknown kid → JWKS requests to the issuer | pass (**0** requests) | **fail (5 requests)** | pass | pass |

Two library behaviours were confirmed empirically during the prototype:
- **x/oauth2's default `AuthStyleAutoDetect` breaks redemption.** It first sends `client_id` by HTTP Basic, the issuer burns the single-use code, and the retry in the form fails. With the default, `TestExternalForeignIssuer` fails with "The sign-in code is invalid, used, or expired". `AuthStyleInParams` is required.
- **go-oidc `Provider.UserInfo` takes the HTTP client from the *call's* ctx, not the provider's.** The first run fell back to `http.DefaultClient` (TLS "unknown authority"), and the two userinfo tests failed until `oidc.ClientContext` was applied to the call ctx.

#### Behaviour parity: library, glue, or dropped

| Requirement | Variant A | Variant B |
|---|---|---|
| RFC 8414 discovery, then OIDC fallback, then merging `userinfo_endpoint` from the OIDC document; https checks; 1 h cache; keeping stale metadata while the issuer is down | glue (hand-written, unchanged, 52 lines) | glue (same) |
| Begin URL + scope + `issuer` | protocol code | protocol code |
| Token request: public client, PKCE, `resource`, form encoding | library (x/oauth2), with `AuthStyleInParams` required | library |
| Unreachable → `retry_after`, other failures → `denied` | glue (`errors.As(*url.Error)`) | glue |
| Reject a `token_type` other than Bearer | glue | glue |
| Compact JWS parse, alg allowlist (no none/HMAC), alg/key match, reject `crit` | library (go-jose) | library |
| `typ` = `at+jwt` / `application/at+jwt`, case-insensitive | **glue** (no library does it; 3 lines) | glue |
| `"Ed25519"` alg name (RFC 9864 fully-specified) | **dropped** (go-jose v4.1.9 knows only `EdDSA`) | dropped |
| JWKS fetch, cache, refetch on kid miss | library (go-oidc) | glue (33 lines, using go-jose JWK parsing) |
| At most one JWKS fetch a minute | glue (17-line throttling `RoundTripper`) | glue (built into `keysFor`) |
| Skip JWKS entries this server can't use | library (go-oidc) | glue |
| `use` must be `sig`; RSA ≥ 2048 bits | **dropped** | glue (4 lines) |
| 1 MiB cap on issuer responses | token: x/oauth2 caps 1 MiB. **JWKS and userinfo: uncapped** (go-oidc uses `io.ReadAll`) | token: x/oauth2 cap; JWKS and userinfo: own cap |
| JWKS fetch cancelled with the request | **lost** (go-oidc uses its constructor's ctx; the client timeout still applies) | kept |
| `iss`, `exp`/`nbf` with 1 min leeway, `aud` as a string or array | library (`jwt.Claims`, `jwt.Audience`) | library |
| `exp` required, `sub` required | glue (go-jose skips a missing `exp`) | glue |
| `iat` in the future (beyond 1 min) rejected | **added** by go-jose (not in the original) | added |
| Reject `cnf` | glue | glue |
| Userinfo: GET with Bearer, `sub` must match | library (go-oidc) + glue for `sub`; **+3 lines** compared with hand-written | hand-written (unchanged) |

### 1.4 Go verdict (evidence)

- The best case removes about 190 of 478 code lines (40%). The cost is 3 new direct modules (+7 linked packages, +300 KB binary) and three non-obvious library traps found while prototyping (auth-style probing, client in ctx, an unthrottled refetch that needs glue).
- Variant B gets 36% with 2 modules. It keeps every behaviour except the `"Ed25519"` alg name, which go-jose v4.1.9 does not know (A drops it too). Both variants also add a rejection of an `iat` in the future (go-jose `ErrIssuedInTheFuture`, jwt/validation.go:120-123), which the original does not check.
- The ~290 lines that remain are protocol code and glue no library offers: RFC 8414 + OIDC discovery merge, RFC 9068 `typ`, `cnf`, Bearer-only, error mapping, userinfo `sub` matching, stale-metadata fallback, throttling.
- Libraries mainly replace `jwt.go`, the self-contained, unit-tested JOSE part, which is the part least likely to change with the spec.

---

## Part 2: Cloudflare (foreign-issuer mode is not implemented)

### 2.1 Where it would plug in

The integration work is the same whichever library is used.

| Where | What changes | Estimate (code lines) | Basis |
|---|---|---:|---|
| `src/config.ts` (+ `worker-configuration.d.ts`, wrangler vars) | `EXTERNAL_ISSUER` (https, no query) and `EXTERNAL_SCOPE`. Mutually exclusive with `EXTERNAL_SIGN_IN` (its own authorization server). Does not need `PASSKEY_PAGE`. | 15–25 | `EXTERNAL_SIGN_IN` parsing (config.ts:548-549) |
| `src/index.ts` `handleExternal` (today 29 lines) | Begin returns `{url: authorization_endpoint + scope, issuer}`. `code` leads to redeem, check and sign-in. `token` leads to check and sign-in (today the `token` param is refused: "Sign in with this server's tokens through the token scheme"). An addition on a signed-in connection. Mapping `retry`/`denied` errors. | 40–60 | Go `Auth` + `signIn` = 51 code lines |
| Account and identity storage (`src/store.ts`) | **New.** Today every account is reached only through `credentials` (passkeys): table at store.ts:2035, referenced in 26 places across creation, prune and removal. External identities need a table `issuer#sub → user_id`, a schema migration, lookup and creation, removal on idle prune and account deletion, and their SQL row budgets. | 60–120 | analogous `credentials` handling |
| Sign-in completion | `completePasskeySignIn` (45 lines) and `redeemPasskeyCode` are passkey-specific (credential, sign count). They need a variant that issues the bearer `token` for an external identity, with `user_id` and name from userinfo for a new account. | 30–50 | |
| Edge-rule generator (`scripts/budget.mjs:127,455-460`, `docs/edge-admission.md`, `docs/edge-rules.generated.json`) | In foreign mode the server serves no `/oauth/authorize`, `/oauth/token` or `/.well-known/oauth-authorization-server`, so the generator must not open them. Nothing new to admit: redemption happens over the WebSocket. | 5–15 + regenerated JSON | |
| Budget (`src/budget.ts`) | Outbound fetches (below), counted like push's outbound requests (`MAX_PUSHES_PER_MESSAGE`). Existing `authAttemptsPerIpMinute` bounds attempts. | 5–15 | |
| Docs (`docs/configuration.md` row, `docs/guide.md` section) | | 30–60 prose | Go's SERVER.md "Another authorization server" section |
| Integration tests (fake issuer through a fetch mock) | | 250–400 | Go `external_foreign_test.go` is 406 lines; CF `sign-in-pages.integration.test.ts` is 502 |

The integration subtotal, excluding the issuer client itself: about 155–285 code lines of source, plus docs and 250–400 test lines. **No library touches any of this.**

### 2.2 The issuer client: three prototypes measured (`deps-proto/cf`)

All three expose the same interface (`discover`, `redeem`, `check`, `userinfo`; the jose one only `check`) and run against one test file with a fake issuer behind a `fetch` function (`test/foreign-issuer.test.ts`, 136 code lines). Copies are in `evidence/cf-*`.

| Variant | File | raw | code (no blank or comment lines) | Bundle (`wrangler deploy --dry-run`, `wrangler.production.toml`, exported from `src/index.ts` so it is reachable) | Δ vs. baseline |
|---|---|---:|---:|---|---|
| Baseline (e1d1500) | | | | 1597.87 KiB / gzip 360.86 KiB | |
| Hand-written (fetch + WebCrypto) | `src/foreign-issuer-handwritten.ts` | 173 | **148** (+~5 for `ForeignError`, which it imports from the oauth4webapi file) | 1605.98 KiB / gzip 363.17 KiB | **+8.1 KiB / +2.3 KiB gzip** |
| oauth4webapi 3.8.8 | `src/foreign-issuer.ts` | 117 | **91** | 1654.97 KiB / gzip 373.60 KiB | **+57.1 KiB / +12.7 KiB gzip** |
| jose 6.2.17, `check` only | `src/foreign-issuer-jose.ts` | 32 | 22 (estimate ~100 with hand-written discovery, redeem and userinfo) | 1634.15 KiB / gzip 370.56 KiB | +36.3 KiB / +9.7 KiB gzip |
| oauth4webapi + jose together | | | | 1691.31 KiB / gzip 382.74 KiB | +93.4 KiB / +21.9 KiB gzip |

Test results (`evidence/cf-proto-tests.txt`): **13/13 pass** in vitest-pool-workers (workerd). `tsc --noEmit` and `npm run typecheck` (with `budget:check`) are clean. Each variant was tested for:
- discovery from both documents, RFC 8414 only, and OIDC only, with userinfo merged;
- a redeem that sends PKCE + `resource` + `client_id`;
- a bad code → `denied`, and a `DPoP` `token_type` → `denied`;
- an ID-token `typ`, no `typ`, another `aud`, another `iss`, expired, `cnf`, and a foreign key are refused, while `application/AT+JWT` is accepted;
- RS256, PS256 and EdDSA (on the hand-written and oauth4webapi variants);
- userinfo `sub` mismatch → no name;
- 5 forged unknown-kid tokens → **0 JWKS fetches** for all three variants.

Whether Pocket ID's (or other providers') access tokens carry `jti` was not verified. If they don't, `validateJwtAccessToken` refuses them and the check falls back to jose (`jwtVerify`, ~100 lines total with hand-written discovery, redeem and userinfo).

So with oauth4webapi the issuer client is **about 57–62 fewer code lines (148 → 91, −39%) for +12.7 KiB gzip**. Against the whole feature (client + integration ≈ 300–430 code lines), that is about a 13–19% saving.

The hand-written TS version is a third the size of the Go one (148 vs. 478 code lines) because WebCrypto `importKey("jwk", …)` does the JWK-to-key conversion and ECDSA takes raw r‖s. Most of what `jwt.go` hand-rolls in Go does not exist in TS.

### 2.3 Library facts

| | oauth4webapi 3.8.8 | jose 6.2.17 |
|---|---|---|
| License, dependencies | MIT, `dependencies: {}` (verified) | MIT, `dependencies: {}` (verified) |
| Package size on disk | 340 KB (`build/index.js` is 99,856 B) | 536 KB |
| Releases in the last 12 months (npm `time`) | 6 | 19 |
| RFC 8414 discovery | Yes: `discoveryRequest(…, {algorithm: "oauth2"})`, with the well-known part before the path. Fallback to OIDC and the userinfo merge are glue (~15 lines). | No |
| Code grant + PKCE + `resource` | Yes. Used `genericTokenEndpointRequest` because `authorizationCodeGrantRequest` requires `callbackParameters` branded by `validateAuthResponse()` (index.js:1341), which a server that never saw the redirect doesn't have. `None()` gives a public client. Rejecting `token_type` other than Bearer is glue (it lowercases and accepts `dpop`). | No |
| RFC 9068 check | `validateJwtAccessToken`: `typ` normalized (case-insensitive, `application/` stripped), `iss`, `aud`, `exp`, alg/key match. **Takes an HTTP `Request`**, so the WebSocket's token is wrapped in `new Request(origin, {headers: {authorization: "Bearer …"}})`. **It requires `iat`, `jti` and `client_id`** (RFC 9068 §2.2, index.js:2335-2342), which the Go server does not require. A provider that omits `jti` (the Go fake issuer does) would be refused; tested. `cnf.jkt` triggers DPoP checks, so rejecting `cnf` stays glue. `expectedAudience` is a single string. | `jwtVerify(…, {typ: "at+jwt", issuer, audience, algorithms, clockTolerance, requiredClaims})`: the `typ` comparison is normalized the same way, and `aud` takes a string or an array. |
| JWKS cache | Module-level `WeakMap` keyed by the metadata object. Max age 300 s. Kid miss refetches only if the cache is ≥60 s old (index.js:1036, 1092). Cross-request persistence uses the `jwksCache` symbol. | `createRemoteJWKSet` with `cooldownDuration` (kid-miss throttle) and `cacheMaxAge`. Also exports a `jwksCache` symbol. |
| Userinfo | `userInfoRequest` + `processUserInfoResponse(…, expectedSubject)` throws on `sub` mismatch. It needs a `client` with a non-empty `client_id` even for userinfo; the first run failed until this was found. | No |

### 2.4 Workers-specific concerns

- **Outbound fetches.** These are subrequests from the single Durable Object (`getByName(OBJECT_NAME)`).
  - A cold sign-in from a code costs at most **5**: RFC 8414 metadata, OIDC metadata, JWKS, token, userinfo (new account only).
  - A warm redemption costs 1, or 2 for a new account.
  - A warm token presentation costs **0**.
  - A kid-miss JWKS fetch happens at most once a minute in all three prototypes (tested). With oauth4webapi there is also a forced refetch every 5 min while tokens arrive.
  - The paid-plan per-invocation subrequest limit was not checked in this session. 5 is far below the free plan's documented 50 (not re-verified here).
- **Caching.** The DO hibernates (`ctx.acceptWebSocket`, index.ts:2629). Metadata and JWKS cached in memory are lost on eviction, so the first sign-in after a wake pays the cold cost again. Persisting them in DO SQLite would cost row writes against `resource_budgets`. The Cache API is a per-colo alternative not prototyped. Because there is one DO, an in-memory cache is shared by every connection while the object is awake.
- **CPU.** WebCrypto `jwtVerify` per token, measured in Node 22: RS256 **87 µs**, ES256 **165 µs**, EdDSA **191 µs** (`tools/bench/bench.mjs`; workerd freezes timers during execution, so it can't be measured there). Verifying on every connection's presentation (the "provider controls sessions" use) is negligible against the plan's `workerCpuMs: 30,000,000`/month.
- **Bundle.** The current bundle is 1.56 MiB raw / 361 KiB gzip. The repo has no bundle-size budget (searched `docs/`, `SPEC.md`, `src/budget.ts`, `scripts/`). +12.7 KiB gzip is +3.5%.

---

## Part 3: Which providers meet the spec today

The three requirements are:
1. **RFC 8707:** the `resource` parameter puts the server's origin in the access token's `aud`.
2. **RFC 9068:** JWT access tokens with `typ: at+jwt`.
3. **CIMD:** client ID metadata documents accepted at the authorization endpoint, with a consent screen per client that names the host.

Legend:
- ✅ verified with the cited source
- ⚠️ partial or behind a flag
- ❌ verified absent
- ❓ unverified

| Provider | RFC 8707 `resource` → `aud` | RFC 9068 `typ: at+jwt` | CIMD (+ per-client consent by host) | Meets all three? |
|---|---|---|---|---|
| **Pocket ID** | ✅* ≥2.13 per the brief. Only indirect support in a source: v2.14.0 "ignore trailing slash in resources" [1]; no note names RFC 8707 | ✅ v2.13.0 "make oauth access tokens RFC 9068 compliant" [1] | ✅ v2.13.0 "implement OAuth Client ID Metadata Document"; v2.14.0 "allow admins to auto grant APIs to CIMD clients" [1]. Consent display ❓ | **Yes (≥2.13)** |
| **Keycloak** | ⚠️ experimental, `--features=resource-indicators`; "issues the access token whose `aud` claim includes only the value of the `resource` parameter" [2]. Zuplo's table (verified 2026-07-24) still says "No" [3], probably for the default build. | ⚠️ opt-in per client since 26.2: Clients → Advanced → 'Use "at+jwt" as access token header type', default off, `JWT` otherwise [4] | ⚠️ experimental, `--features=cimd` + a client policy with the `client-id-metadata-document` executor [2]. A third party reports it needs 26.8 [5]. Consent by host ❓ | **Only with 2 experimental features + a per-client switch** |
| **Authentik** | ❌ "Not shipped. An implementation for the enterprise OAuth2 provider is in review" (Zuplo, 2026-07-24; goauthentik/authentik#8751) [3] | ❓ | ❓ No source found. agentgateway ships an Authentik adapter because Authentik "does not fully implement" MCP's assumptions [6] | **No** |
| **Zitadel** | ❌ (Zuplo, 2026-07-24) [3] | ❓ (JWT access tokens are an app option; `typ` not verified) | ❓ No source found; DCR "not implemented, tracking issue open since April 2025" [3] | **No** |
| **Okta** | ❓ (Okta docs describe a per-authorization-server default audience [7]; no `resource` support found) | ❓ (Okta's sample access-token header shows only `alg`, `kid` [8]) | ⚠️ CIMD documented for OIDC app integrations: the admin enters the CIMD URL in the app wizard [9][10]. Whether it resolves dynamically at the authorization endpoint ❓ | **Unverified; likely no** (CIMD looks admin-registered, `resource` not found) |
| **Microsoft Entra ID** | ❌ "Use `scope={resource}/.default` instead of `resource`"; v2 `aud` "is always the client ID of the API" [3][11] | ❌ `typ` "is always JWT" [11] | ❌ v2.0 discovery has no `client_id_metadata_document_supported` and no `registration_endpoint` (fetched live 2026-11-16; also [12]) | **No** |
| **Auth0** | ⚠️ "Resource Parameter Compatibility Profile": `resource` used when `audience` is absent; if both are sent, `audience` wins [3][13] | ✅ per-API "RFC 9068 token profile" with `typ` `at+jwt`; the default profile uses `JWT` [14] | ⚠️ manual pre-registration and dynamic registration (Early Access; the GA status of manual registration was not confirmed), behind a tenant toggle [13][15]. Consent by host ❓ | **Close, with tenant settings + an Early Access feature** |
| **Google** | ❌/❓ no `resource` in discovery (live fetch). Access tokens are commonly opaque (`ya29.`); not verified by a source here. | ❌/❓ (same) | ❌ no `client_id_metadata_document_supported` in the live discovery document (2026-11-16) | **No** |

The MCP authorization spec has driven providers toward these features:
- 2025-06-18 made RFC 8707 `resource` mandatory for MCP clients [16].
- 2025-11-25 adopted CIMD as the preferred registration (SEP-991) [17].
- 2026-07-28 deprecated DCR in favour of CIMD [3][18].

The CIMD implementations with dates found here postdate SEP-991: Pocket ID v2.13.0 (Aug 2026), Clerk (GA 2026-09-17), and Keycloak (26.8, per a third party). Auth0, Okta, Ping, WorkOS, Scalekit and Authlete were found shipping it, but their release dates were not checked. RFC 9068 `at+jwt` is the least driven by MCP (the MCP spec requires audience validation, not a token format). It is off by default in Keycloak and Auth0, and absent in Entra.

Sources:
[1] Pocket ID releases: https://github.com/pocket-id/pocket-id/releases
[2] Keycloak, "Integrating with MCP": https://www.keycloak.org/securing-apps/mcp-authz-server
[3] Zuplo MCP IdP compatibility (rows verified 2026-07-24/31): https://zuplo.com/learn/mcp/compatibility/identity-providers
[4] Keycloak 26.2.0 release notes: https://www.keycloak.org/2025/04/keycloak-2620-released
[5] Skycloak, Keycloak CIMD for MCP: https://skycloak.io/blog/keycloak-cimd-mcp-authorization/ and https://skycloak.io/blog/keycloak-cimd-claude-ai-public-client-jwt-grant/
[6] agentgateway Authentik provider: https://agentgateway.dev/docs/standalone/latest/integrations/auth/authentik/
[7] Okta, create an authorization server: https://help.okta.com/en-us/Content/Topics/Security/api-config-auth-server.htm
[8] Okta OIDC standards page: https://developer.okta.com/standards/OIDC
[9] Okta, About CIMD: https://help.okta.com/oie/en-us/Content/topics/apps/apps-cimd-about.htm
[10] Okta developer guide, app CIMD registration: https://developer.okta.com/docs/guides/app-cimd-registration/main/
[11] Microsoft Learn, access token claims reference: https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
[12] Particula, Entra and MCP client registration: https://particula.tech/blog/mcp-server-entra-id-oauth-client-registration
[13] Auth0 CIMD overview: https://auth0.com/docs/get-started/auth0-overview/create-applications/cimd-overview
[14] Auth0 access token profiles: https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles
[15] Auth0 blog, CIMD vs DCR: https://auth0.com/blog/cimd-vs-dcr-mcp-registration/
[16] MCP authorization 2025-06-18 (read: "MCP clients **MUST** implement Resource Indicators … RFC 8707"; servers MUST implement RFC 9728): https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
[17] Auth0 blog, MCP November 2025 spec update: https://auth0.com/blog/mcp-november-2025-specification-update/
[18] MCP authorization 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

No source was found for any provider showing that its consent screen names the CIMD client by the document's host (§4.12.3's last requirement). The CIMD draft recommends showing it, but this was not verified per provider.

---

## Summary: does this change the cost side?

| | Hand-written | With libraries | Saving | Price |
|---|---:|---:|---|---|
| Go issuer client (code lines) | 478 | 289 (A: go-oidc + go-jose + x/oauth2) / 305 (B: go-jose + x/oauth2) | −189 / −173 (36–40%) | +3/+2 direct modules, +7/+6 linked packages, +300 KB binary. Glue kept: discovery, `typ`, `cnf`, Bearer, errors, throttle. Library pitfalls: x/oauth2 auth-style probing burns the code; go-oidc's ctx-carried client and unthrottled refetch. |
| CF issuer client (code lines, measured prototypes) | 148 | 91 (oauth4webapi) | −57 (39%) | +57 KiB / +12.7 KiB gzip bundle. Stricter claims (`jti`, `iat`, `client_id` required). `Request` wrapping. Glue kept: discovery fallback, Bearer, `cnf`. |
| CF whole feature (estimate) | ~300–430 + 250–400 test | ~245–375 + same tests | ~13–19% | |

**The evidence:**
- Libraries cut the *JOSE/HTTP* part by about 40% in both languages.
- They do not touch most of the cost:
  - In Go, the remaining ~290 lines are protocol logic and glue no library offers.
  - In Cloudflare, most of the cost is integration (identity storage, sign-in completion, config, edge rules, docs, tests), which is library-independent and roughly 2× the issuer client.
  - The hand-written TS client is already small (148 lines) because WebCrypto does the key handling.
- The ongoing cost of the mode is driven more by Part 3. Today only Pocket ID meets all three requirements out of the box. Keycloak and Auth0 need experimental, early-access or opt-in switches. Entra, Google, Authentik and Zitadel cannot be used.
