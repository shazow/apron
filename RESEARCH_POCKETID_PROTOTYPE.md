# Research: Apron sign-in through Pocket ID, run end to end

Date: 2026-11-15. Everything below was run locally in this sandbox. Nothing was pushed, and no branch was modified.

- Pocket ID: built from source, `main` at e22f0b6 (`.version` 2.19.2, unreleased commits after v2.19.2).
- aprond: `apron-server-go` at `claude/charming-faraday-nrrajr` f2e44a8, built in a detached throwaway worktree.
- Browser: Playwright Chromium with a CDP virtual authenticator (ctap2, internal, resident key, UV).

The prototype directory is a session scratch directory (not kept; the mode B extension is in [feedback/pocketid/main.go](feedback/pocketid/main.go)) (written `$P` below).

## Conclusion

**Foreign-issuer mode works mechanically with Pocket ID, but in its "any client" form it is not safe with Pocket ID.**

Pocket ID binds `resource` to `aud`, sends `iss`, and allows CORS. aprond's `aud` check refused every token that was meant for another server, or that had no audience.

The "any client" form needs one shared public client whose callback pattern admits arbitrary redirect URIs (`*`).

- Pocket ID asks for consent once per client_id, and names only the shared client ("Apron apps"). It never names the redirect host or the Apron server.
- Once a user had consented and chosen "Stay signed in", a third-party page got a code with **zero clicks**. Redeemed at aprond, that code signed into the victim's Apron account (run `run-attack.log`).
- §4.12.3 forbids exactly this when aprond is its own authorization server: its page must show the redirect host and must confirm every time.
- The CIMD variant fixes the naming: Pocket ID shows the app's `client_name` and the host of its metadata document, and asks for consent per client.
  - The cost: every app must host an https metadata document, including native and terminal apps.
  - The operator must enable CIMD, set a URL allowlist, and allow CIMD clients per API.
  - The user still sees no Apron confirmation, and the Apron server is never named.

**Mode B (behind the portal) needed one Pocket ID step: one confidential client with one exact callback.**

- It needed no API resource and no wildcards.
- The extension is a 170-line file, with no server changes.
- aprond's own page named the requesting app, and confirmed on every sign-in.
- The same attack stopped at that page, which named the attacker's host (run `run-attack-b.log`).
- It also produced better accounts: `{"name":"Ada Lovelace","user_id":"ada"}`. Mode A gave `{"user_id":"user_1"}` with no name, because Pocket ID's access tokens carry no profile claims.

**The evidence supports removing the foreign-issuer option from §4.12.**

- Keep "the server is its own authorization server", and put providers behind the page (B).
- The option to remove consists of: `issuer` in begin, presenting a token with `scheme: "external"`, and the foreign half of §4.12.4.
- If it stays at all, the evidence supports restricting it to issuers that consent per client and name the client's host, such as CIMD-only. It should never rely on a shared public client with wildcard callbacks.
- In aprond, removal deletes 556 non-test lines and 349 test lines. Nothing in mode B depends on them.

## 1. Setup (what was run)

### Pocket ID
- **Release binaries were not reachable.** github.com HTTP returned 403 from the session proxy, which serves git reads only. The binary was built from source instead:
  - Go 1.27.3, downloaded through `GOTOOLCHAIN=auto` from proxy.golang.org.
  - `corepack pnpm install --frozen-lockfile && corepack pnpm build` for the frontend, which builds into `backend/frontend/dist`.
  - `go build ./cmd`, producing `$P/pocket-id` (116 MB).
- aprond requires an `https` issuer (`NewForeign` refuses `http`). Pocket ID therefore served TLS itself, with a local CA (`$P/tls/`).
- Launch script: `$P/run-pocketid.sh`.
  - `APP_URL=https://localhost:1411`, `TLS_CERT_FILE`/`TLS_KEY_FILE`, `ENCRYPTION_KEY`, `STATIC_API_KEY` (for scripted admin calls), and `DISABLE_RATE_LIMITING`.
  - `OUTBOUND_ALLOWED_HOSTS_CLIENT_METADATA=loopback` lets CIMD fetch a document from 127.0.0.1; this is only needed locally.
  - `SSL_CERT_FILE` points at a bundle that includes the local CA.
- **WebAuthn worked over https with a self-signed CA.** Chromium was launched with plain `chromium.launch()` and a context with `ignoreHTTPSErrors: true`. `isSecureContext` was true, and passkey create and get both worked. Helper: `$P/pw-lib.cjs`, which saves virtual credentials per user in `creds-<who>.json`.
- Users:
  - The admin was created through `/signup/setup` with a passkey (`setup-admin.cjs`). The welcome screen offers feature toggles, and "APIs" and "Client ID metadata documents" were turned on there.
  - User `ada` was created through `POST /api/admin/users`. A one-time code link (`/lc/<code>`) signed her in, and she added a passkey (`setup-user.cjs`).

### aprond
- Mode A, shared public client: `aprond --addr 127.0.0.1:{8081,8082} --store memory --external.issuer https://localhost:1411 --external.client-id <Apron apps id> --external.scope "openid profile"`, with `SSL_CERT_FILE` pointing at the bundle.
- Mode A, CIMD: the same on port 8083, without `--external.client-id`.
- Mode B: `aprond-pocketid --addr 127.0.0.1:8091 --store memory --pocketid.issuer https://localhost:1411 --pocketid.client-id <id> --pocketid.client-secret <secret> --pocketid.base-url http://127.0.0.1:8091`.
- Origins are `http://127.0.0.1:<port>`, following the §4.12.1 rule for `ws://` on loopback. Clients sent that value as `resource`.
- Mode B extension source: `$P/apron-server-go/examples/pocketid/main.go`. The worktree is detached and throwaway; remove it with `git -C /home/user/apron-server-go worktree remove --force $P/apron-server-go`.

### Client
- `$P/drive-a.cjs` is one client for both modes. It uses Node's WebSocket to connect to `/ws`, and does the following:
  1. Begins `external`.
  2. Adds PKCE, `state`, `redirect_uri` and `resource` (the origin) to the begin `url`, adding its own `client_id` only when `url` has none.
  3. Drives the browser through every screen, taking a screenshot of each.
  4. Captures the redirect: on a loopback http server, on an https "web app" at `https://127.0.0.1:8443/cb`, or as a `com.example.app:/signed-in` navigation.
  5. Checks `state` and `iss`.
  6. Redeems on the WebSocket, or at Pocket ID's token endpoint, and then presents the token.
- `$P/apron-ws.cjs` is the WebSocket client. `present.cjs`, `attack.cjs`, `attack-b.cjs` and `matrix.sh` are the other scripts.

## 2. Mode A: foreign issuer

### Pocket ID configuration (exact)
Shared public client:
1. Turn on the **APIs** feature (welcome screen or Configuration).
   - **Observed:** this toggle only affects the admin UI. With `enabledFeatures=["cimd"]`, `/authorize` with `resource` still worked.
2. **Create an API**: name "Apron chat (8081)", resource `http://127.0.0.1:8081`. A second API, "Apron chat (8082)", was created for the reuse test.
3. **Create the OIDC client** "Apron apps": public, PKCE, callback URLs `["*"]`. Screenshot: `shots/CFG-A-client-apron-apps.png`.
4. **Grant the client user-delegated access** on each API (`PUT /api/admin/apis/{id}/clients/{cid} {"userDelegatedAccess":true}`). Screenshot: `shots/CFG-A-api-8081.png`.
5. On aprond: set `--external.issuer`, `--external.client-id`, and `--external.scope`.

In total: 4 Pocket ID steps, plus 3 aprond flags. Steps 2 and 4 repeat for every Apron server that uses this Pocket ID.

CIMD variant:
1. Turn on APIs.
2. Turn on CIMD.
3. Set the CIMD URL allowlist. `https://*/**` matches any https host on the default port; this test needed `https://*:*/**` because it used port 8443.
4. Create the API.
5. On the API, enable "Allow CIMD clients" (`PUT /api/admin/apis/{id}/cimd-access {"enabled":true}`).

In total: 5 Pocket ID steps, plus aprond without `--external.client-id`. Each app must also serve an https metadata document with `token_endpoint_auth_method: "none"` and its redirect_uris.

### Callback URL patterns (`pattern-accept.txt`, `match-matrix.txt`)

What Pocket ID accepts when the client is saved:

| Accepted | Refused |
|---|---|
| `*`, `https://*`, `https://**`, `https://*/**`, `https://*.*/**`, `*://*/**` | `*:/signed-in`, `*:/**` (a wildcard scheme without `//`) |
| `com.example.app:/signed-in`, `com.example.app:/*` | `javascript:alert(1)` |
| `http://127.0.0.1/cb`, `http://127.0.0.1:*/cb`, `http://127.0.0.1/**` | |

What each pattern matches at `/authorize` (yes = continued to sign-in; no = Pocket ID's error page):

| pattern | https://app.example/cb | https://evil.example/steal | com.example.app:/signed-in | com.other.app:/x | http://127.0.0.1:54321/cb | http://localhost:54321/cb | http://[::1]:54321/cb | http://evil.example/cb |
|---|---|---|---|---|---|---|---|---|
| `*` | yes | yes | yes | yes | yes | yes | yes | yes |
| `https://*` (and `https://**`, `https://*/**`, `https://*.*/**`) | yes | yes | no | no | no | no | no | no |
| `*://*/**` | yes | yes | yes | yes | yes | yes | yes | yes |
| `com.example.app:/signed-in` (and `com.example.app:/*`) | no | no | yes | no | no | no | no | no |
| `http://127.0.0.1/cb` (and `:*/cb`, `/**`) | no | no | no | no | yes | no | no | no |
| list `https://*/**`, `http://127.0.0.1/**`, `http://localhost/**`, `http://[::1]/**`, `com.example.app:/signed-in` | yes | yes | yes | no | yes | yes | yes | no |

What the matrix shows:

- **Loopback ports.** Any port matches a port-less loopback pattern, as RFC 8252 requires.
- **No pattern for "any private-use scheme".** Pocket ID cannot express §4.12.3's "any scheme with a `.`". The only patterns that admit an unlisted app scheme are `*` and `*://*/**`. Both also admit plain `http://evil.example`, which `ALLOW_INSECURE_CALLBACK_URLS` allows by default ("until v3").
- **Errors go to the redirect URI.** Under `*`, Pocket ID redirects errors to any URI, for example `303 https://evil.example/steal?error=invalid_request…`. This is the open-redirector behaviour that §4.12.3 forbids for Apron's own page.
- **Error redirects rewrite custom schemes.** `com.example.app:/signed-in` came back as `com.example.app://signed-in/?error=…` (`custom-error-redirect.txt`). The success redirect kept the exact URI.

### Sign-ins (all with user `ada`; logs `$P/run-*.log`)

| run | redirect_uri | client_id | redeemed by | result |
|---|---|---|---|---|
| A1 | `http://127.0.0.1:<random>/cb` | shared public | aprond (WebSocket `code`) | `{"you":{"user_id":"user_1"},"token":…}` signed in |
| A2 | `https://127.0.0.1:8443/cb` (another origin) | shared public | client at Pocket ID's token endpoint, then `{scheme:"external",token}` | signed in (same account `user_1`) |
| A3 | `com.example.app:/signed-in` | shared public | aprond | signed in; redirect arrived as `com.example.app:/signed-in?code=…&iss=…&state=…` |
| A4 | loopback | CIMD `https://127.0.0.1:8443/sidekick/client.json` (redirect_uris `["http://127.0.0.1/cb"]`) | client, then token | signed in (`:8083`) |
| A5 | `com.example.app:/signed-in` | CIMD `…/sidekick-ios/client.json` | aprond | signed in (`:8083`) |

Every authorization response carried `iss=https://localhost:1411`, which equals begin's `issuer`.

### Access token claims (A2, with `resource=http://127.0.0.1:8081`)
```
header: {"alg":"RS256","kid":"wYM7s2wcioE","typ":"at+jwt"}
claims: {"aud":["http://127.0.0.1:8081","https://localhost:1411"],
         "client_id":"0ccb7935-3b00-4951-b947-f2c6f6c955b8","exp":1794778766,"iat":1794775166,
         "iss":"https://localhost:1411","jti":"…","scope":"openid profile","scp":["openid","profile"],
         "sid":"pCAPUMaRtNqNCUpX","sub":"65bb71ef-9bbb-4067-a30c-89633128ce78"}
token response: token_type "bearer", expires_in 3599, plus id_token and refresh_token
```
- **Audience.** `aud` is the API plus Pocket ID itself (from the identity scope). The token is therefore also accepted at Pocket ID's userinfo endpoint.
- **No profile claims.** There is no `name` and no `preferred_username`. aprond therefore created `user_1` with no name.
- **CIMD tokens** have the same shape, with `"client_id":"https://127.0.0.1:8443/sidekick/client.json"` and `aud` `http://127.0.0.1:8083`.

### Negative cases

| case | what happened |
|---|---|
| N1a: no `resource`, client redeems | token `aud:["<client_id>","https://localhost:1411"]`; aprond `:8081` → `denied` ("…not for this server") |
| N1b: no `resource`, aprond redeems (it sends `resource=origin` at the token endpoint) | Pocket ID returned a token anyway, audienced to the client; aprond → `denied` |
| N1c: no `resource` at authorize, `resource=http://127.0.0.1:8081` at token endpoint | 200; `aud` still the client ID: **Pocket ID ignores `resource` at the token endpoint** (neither binds nor errors) |
| N2: `resource=http://127.0.0.1:9999` (not registered) | Pocket ID redirected to the client's redirect_uri with `error=invalid_request`, "The 'resource' or 'scope' parameter is invalid." **Not `invalid_target`.** The device endpoint does answer `invalid_target` for the same resource. |
| N3: `resource=…:8082`, code redeemed by aprond `:8081` | denied (token aud 8082) |
| N3c: `resource=…:8082` at authorize, `resource=…:8081` at token endpoint | 200, aud stays 8082; aprond 8081 → `denied` |
| Reuse: A2's token (aud 8081) presented to aprond `:8082` | `denied` (the client was allowed both APIs, so only aprond's `aud` check stopped it) |
| Client not granted the API | `invalid_request` redirect (same as N2) |

The other §4.12 requirements also hold:

- CORS: `OPTIONS /api/oidc/token` answers `access-control-allow-origin: *`.
- Device grant: `/api/oidc/device/authorize` accepts `resource` for a granted API, and answers `invalid_target` for an unknown one.

### Attack: silent code to a third party (`attack.cjs`, `run-attack.log`)

1. Ada signs in once through an ordinary app, chooses **Stay signed in**, and consents to "Apron apps".
2. A page that the attacker controls navigates the same browser to begin's URL, with the shared `client_id`, `redirect_uri=https://127.0.0.1:8443/attacker`, the attacker's own PKCE, and `resource=http://127.0.0.1:8081`.

Result:
```
attacker navigation chain: ["https://127.0.0.1:8443/attacker?code=pocket_id_ac_5-hc…"]
attacker received: {"code":"pocket_id_ac_…","iss":"https://localhost:1411","state":"…"}
attacker redeems at aprond -> {"result":{"you":{"user_id":"user_1"},"token":"YqrbjBc3…"}}
```
The attacker received the code with no screen and no click, and redeemed it into Ada's account.

- **Forced reauthentication only adds a passkey prompt.** With the client set to `requiresReauthentication: true` (`run-attack-reauth.log`), the screen reads "Confirm it's you. Apron apps asks you to confirm with your passkey before continuing." It still does not name the redirect host, so the user cannot tell the attacker's request from a real one.
- **The restrictive pattern list does not help.** `https://*/**` and the other https patterns admit `https://evil.example` too (matrix above).
- **CIMD limits it.** A CIMD client can only use the redirect_uris that its own document lists. An attacker's own document is a new client, which gets its own consent naming the attacker's host.

## 3. Mode B: behind the portal

### Pocket ID configuration (exact)
1. **Create the OIDC client** "Apron chat (8091)": confidential, PKCE, callback `http://127.0.0.1:8091/pocketid/callback` (exact). Copy the client ID and secret. Screenshot: `shots/CFG-B-client-apron-chat-8091.png`.
2. On aprond: set `--pocketid.issuer`, `--pocketid.client-id`, `--pocketid.client-secret`, and `--pocketid.base-url`.

That is 1 Pocket ID step. It needs no API, no wildcard, and no feature toggle.

### The extension
`examples/pocketid/main.go`: 170 lines, 134 without blank or comment lines.

- It is modelled on `examples/sso`.
- `Init` reads the provider's metadata through OIDC discovery and checks its `issuer`.
- `start` redirects to `authorization_endpoint` with:
  - the server's client_id and its one redirect URI;
  - `scope=openid profile`;
  - `state` = the sign-in ID;
  - PKCE, with the verifier derived as HMAC(key, sign-in ID), so it needs no storage.
- The callback checks `iss` (RFC 9207), redeems the code with client_secret_basic and the verifier, and calls `userinfo`.
- It then completes with `Subject = issuer + "#" + sub`, `Name`, and `UserID = preferred_username`.
- It needs no change to aprond. No tests were written; it was exercised end to end below.

### Sign-ins

| run | redirect_uri / client_id | screens (clicks) | result |
|---|---|---|---|
| B1 (first) | `com.example.app:/signed-in` / `com.example.app` | 1. aprond: "An app on this device (com.example.app) wants to sign in … has not verified this app. Only continue if you just started signing in on com.example.app" → Continue; 2. Pocket ID "Apron chat (8091) wants to sign you in" → passkey; 3. Stay signed in? → no; 4. Pocket ID consent "Continue to Apron chat (8091)"; 5. aprond "wants to create an account for you … Continue" | `{"you":{"name":"Ada Lovelace","user_id":"ada"},"token":…}` |
| B2 | loopback / `http://127.0.0.1/cli` | aprond "An app on this device…" → Continue; Pocket ID passkey; Stay signed in? → no; aprond "Allow An app on this device to use Ada Lovelace (@ada)'s account?" → Allow (Pocket ID consent remembered) | signed in, same account |
| B3 | `https://127.0.0.1:8443/cb` / `https://127.0.0.1:8443/` | aprond "127.0.0.1:8443 wants to sign in…" → Continue; passkey; Stay?; aprond "Allow 127.0.0.1:8443 to use Ada Lovelace (@ada)'s account?" → Allow | code received. The driver's token-endpoint step then failed, because it looked for Pocket ID metadata; this is a script bug, not tested further. Redeeming on the WebSocket was shown in B1 and B2. |
| Attack (`attack-b.cjs`) | as in mode A: Stay signed in, then an attacker page with `redirect_uri=https://127.0.0.1:8443/attacker` | stopped on aprond's page: "127.0.0.1:8443 wants to sign in to your account on 127.0.0.1:8091 … Only continue if you just started signing in on 127.0.0.1:8443" | **no code** (`attacker received: undefined`) |

## 4. Comparison

| | A: shared public client | A: CIMD | B: behind the portal |
|---|---|---|---|
| Pocket ID admin steps | 4: feature, API, public client with `*`, grant (API and grant repeat per Apron server) | 5: 2 features, allowlist, API, allow CIMD on the API | 1: confidential client with 1 callback |
| Per-app work | none | https metadata document per app (native and terminal apps need a website) | none |
| Pocket ID version | resource→aud: **v2.10.0** ("add OAuth APIs with scoped permissions", #1542; verified, as `resolveResource`/`GrantAudience(resource)` is absent at tag v2.9.0 and present at v2.10.0). RFC 9068 `at+jwt`: v2.13.0 (CHANGELOG). Tested on main (2.19.2+). | CIMD: **v2.13.0** (verified by code at tags); "auto grant APIs to CIMD clients": v2.14.0 (CHANGELOG) | any OIDC provider; nothing version-specific used |
| aprond requirement | issuer must be `https` | same | none beyond OIDC |
| Screens, first sign-in | 3: Pocket ID sign-in (passkey), Stay signed in?, consent | 3 (consent shows the app's own name and "Not registered by your administrator. It describes itself at <doc host>") | 5: aprond confirm, Pocket ID sign-in, Stay?, Pocket ID consent (once per server), aprond allow or create |
| Later sign-ins | 2, or **0** when signed in at Pocket ID | 2 or 0 for the same client; a new client gets consent | 4, or 2 when signed in at Pocket ID (aprond's confirmation and Allow, always) |
| Who the user sees as asking | "Apron apps" (shared name), never the app, its redirect host, or the Apron server | the app's `client_name` and metadata host; never the Apron server | aprond page: the redirect host or "An app on this device (scheme)", the Apron server, and the account |
| Who can get a token with aud = the Apron server | anyone who can navigate the user's browser, with the shared client_id and their own redirect_uri (any URI under `*`), silently after the first consent | a CIMD client the allowlist admits and the user consents to, by name and host | nobody but aprond (Pocket ID tokens are for aprond's client; Apron tokens come from aprond's page) |
| Open redirect | Pocket ID's error redirects go to any URI under `*` | limited to listed redirect URIs | Pocket ID: one fixed callback. aprond's page shows errors itself (§4.12.3) |
| New-account name and user_id | none (`user_1`): access token has no profile claims | same | from userinfo: "Ada Lovelace", `ada` |
| Code in aprond | foreign.go 331 + jwt.go 171 + apron/external.go 29 + server.go 16 + aprond.go 9 = **556** lines; tests 276 + 58 + 15 = **349**; SERVER.md +46 (commit d4c3b0e) | same | **170**-line extension, plus the server's own authorization server that exists anyway as the default mode (oauth.go 369 + page.go 139 + external.go 432) |

### Failure modes seen
- Callback patterns:
  - A wildcard scheme (`*:/**`) is refused, so "any app scheme" needs `*` or `*://*/**`.
  - An app scheme not in the list gets Pocket ID's error page.
- Error responses:
  - An unregistered resource gives `invalid_request`, not `invalid_target`, redirected to the client. PLAN_LOOSE's "Pocket ID rejects an unknown `resource` (`invalid_target`)" holds only for the device endpoint.
  - A client not granted the API gets the same error.
- Missing audience:
  - Pocket ID silently issues a client-audienced token when `resource` is missing at authorize, even if the redeemer sends `resource` to the token endpoint. aprond's `aud` check is the only guard, and it worked.
- Custom schemes: the error redirect rewrites `com.example.app:/signed-in` into `com.example.app://signed-in/`.
- CIMD:
  - The allowlist `https://*/**` does not match a URL with an explicit port (`MatchesAnyURLPattern`, probed directly: `cimd-allowlist-match.txt`).
  - An unmatched client_id gives "The requested OAuth 2.0 Client does not exist."
- `state` shorter than 8 characters → `invalid_state`.
- Code reading, not tested: aprond's `jwt.go` does not check `typ: at+jwt`. An ID token whose `aud` included the origin would pass. With Pocket ID that needs an admin-chosen client ID equal to the origin; CIMD client IDs that name an API are refused.

## 5. PLAN_MINIMAL with Pocket ID (v10 `external`, apron-server-go `main` ad9e421)

**Upstream, it is the same as B.**

- `main`'s `examples/sso` and the branch's differ by 18 added and 7 removed lines: `ExternalProposal` → `ExternalRequest`, `Cancel` on `access_denied`, and comments.
- A Pocket ID extension for `main` would be this 170-line file with the `start` signature changed.
- The Pocket ID configuration is the same single confidential client.

What differs is how the result reaches the client (`main:internal/auth/external/external.go`, 176 lines; SERVER.md on main):

- **Client.**
  1. It proposes `auth {scheme:"external", state, return_url?}` and gets `{url: /external/<proposal>}`.
  2. It opens that URL. aprond hands the page straight to the extension: no "who is asking" screen, and no Allow.
  3. After Pocket ID, aprond shows either:
     - "Signed in. Continue to <host>" with a link to `return_url#token=…&state=…&server=…`. On `main`, `return_url` must be on the connection's origin or `--public-url`'s, and its token works only on a connection from that origin.
     - Or "Your code. Type this code in the app where you started, and nowhere else."
  4. It approves with `auth {scheme:"external", token}`.
- **User.**
  - Pocket ID sign-in (with consent the first time).
  - Then either one click back to a same-origin web frontend, or reading a code and typing it into the app. That covers native apps, other origins, and terminals.
  - There is no Apron confirmation screen. The proposal's binding to its connection (or origin) is the protection instead of the redirect host plus PKCE.
- **Not covered** (PLAN_MINIMAL's own Coverage): a declined sign-in looks like a closed window, and OAuth libraries cannot be used.

## Screenshots (`$P/shots/`)

File names give the step number and the button that was just clicked ("after-X"). In B runs, step 1 (`…-1-pocketid-signin.png`) is actually aprond's page.

- **Setup:** `A00-pocketid-setup.png`, `A01-pocketid-features.png` (features chosen), `A02-add-passkey.png`, `A03-admin-account.png`, `U-ada-account.png`.
- **Admin configuration:** `CFG-A-api-8081.png`, `CFG-A-client-apron-apps.png`, `CFG-A-cimd-api-8083.png`, `CFG-B-client-apron-chat-8091.png`.
- **A, shared client:**
  - `A1-loopback-ws-1-pocketid-signin.png`: "Apron apps wants to sign you in".
  - `A1-loopback-ws-2-after-sign-in-with-passkey.png`: Stay signed in?
  - `A1-loopback-ws-3-after-don-t-stay-signed-in.png`: consent, "Continue to Apron apps", Profile only, no Apron server named.
  - `A2-*` and `A3-*`: second and third sign-ins, without the consent screen.
- **A, CIMD:** `A4-cimd-1-pocketid-signin.png` ("Sidekick wants to sign you in"), `A4-cimd-3-after-don-t-stay-signed-in.png` ("Not registered by your administrator. It describes itself at 127.0.0.1:8443", "Continue to 127.0.0.1:8443"), and `A5-cimd-custom-*`.
- **A, negative:** `N2-unregistered-*` (error delivered to the client's page).
- **B:**
  - `B1-custom-1-pocketid-signin.png`: aprond "Sign in to 127.0.0.1:8091 … An app on this device (com.example.app)".
  - `B1-custom-2-after-continue.png`: Pocket ID "Apron chat (8091)".
  - `B1-custom-4-after-don-t-stay-signed-in.png`: Pocket ID consent.
  - `B1-custom-5-after-continue-to-apron-chat-8091-.png`: aprond "wants to create an account".
  - `B2-loopback-4-…png` and `B3-web-tokenendpoint-4-…png`: aprond "Allow … to use Ada Lovelace (@ada)'s account?".
- **Attacks:** `ATTACK-silent-code.png` (attacker's page showing the code it received), `ATTACK-B-confirmation.png` (aprond's page naming 127.0.0.1:8443).

## Not done or not possible
- **Prebuilt release binary:** github.com downloads were blocked (403 from the proxy). Pocket ID was built from source instead.
- **apron-web:** not used. A Node client stood in for it.
- **A real external browser for custom schemes:** the custom-scheme redirect was captured as a navigation request in Chromium; no OS handler was involved.
- **v10 flow:** not implemented, only described from `main`'s code.
- **Device grant:** only checked at the device authorization endpoint (`resource` accepted, `invalid_target` for an unknown one), not completed.

All servers that were started (Pocket ID, aprond on :8081, :8082, :8083 and :8091, and the helper listeners) were stopped.
