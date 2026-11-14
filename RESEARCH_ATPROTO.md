# Research: AT Protocol's authentication, and what Apron should borrow

Status: research notes, local and not committed, 2026-11-14. Input to
[PLAN_LOOSE.md](PLAN_LOOSE.md) and [EVALUATIONS.md](EVALUATIONS.md). Uses
their vocabulary (W1, W3, N1, N3, T; A1 to A7; R1 to R5; F1 to F9).
Recommendations here are B1 to B12 ("borrow"), and open questions Q1 to
Q6, so that they do not clash with EVALUATIONS.md's R numbers.

Sources were read on 2026-11-14 from the
[atproto-website](https://github.com/bluesky-social/atproto-website) repository
(specs, last commit 2026-11-13), the
[proposals](https://github.com/bluesky-social/proposals) repository (last
merge 2026-11-12), and the [atproto](https://github.com/bluesky-social/atproto)
and [indigo](https://github.com/bluesky-social/indigo) source trees (main, 2026-11-14).
Links point at `main`; they can drift.

## Summary

AT Protocol's authentication is built for a network where every party is a
stranger: thousands of PDSes and authorization servers, any number of
clients, app views, and users who move between hosts. Each of its hard
requirements answers that: client ID metadata documents (no registration),
mandatory DPoP with server nonces (tokens leave for arbitrary servers and
live up to two years), mandatory PAR (client authentication before the
consent screen), and the identity-first flow with its `sub` check (the
authorization server is chosen by the user's DID, so the client must prove
the server is authoritative for that DID).

Apron's context is narrower. One server is the authority for its own
accounts. Its issuer is the server itself, or one issuer the operator names.
So the trust anchor is the server's address, and the existing `resource`,
`aud`, and `iss` checks do the job that DID resolution does in AT Protocol.
Most of AT Protocol's machinery has no problem to solve in Apron.

What Apron should take:

- **One rule, now.** AT Protocol and the client ID metadata draft both say
  that a client's self-declared name and logo must not be shown on the
  consent screen in place of a host that was verified. PLAN_LOOSE currently
  lets the portal show "the client's name from a client ID metadata document"
  instead of the redirect's host, and does not require the redirect to be one
  that the document lists. That is a phishing gap (A2). The fix is two
  bullets ([B1](#b1)).
- **Guidance, now, no wire change.** The "Sign in with Bluesky behind the
  portal" scenario, including the one check that, if skipped, lets any PDS
  sign in as anyone: verify the DID in `sub` against the authorization
  server by resolution. Key such accounts by DID alone, never by issuer and
  DID, because the issuer changes when the user migrates ([B2](#b2),
  [scenario](#at-protocol-behind-the-portal)).
- **Not service auth as an `external` token.** It is feasible: a client with
  an AT Protocol session can get a 60-second JWT for `did:web:chat.example`
  from its PDS, and the Apron server can verify it against the DID document.
  But the JWT does not say which app minted it, and any app that holds the
  broad `transition:generic` scope or an app password can mint one for any
  audience. So every AT Protocol app the user ever trusted could open a new
  Apron session silently. That fails A7, which the portal's confirmation
  exists to hold. Bluesky itself fences its own DMs (`chat.bsky.*`) out of
  that broad grant for this reason. Revisit when AT Protocol's typed
  delegation tokens with client attestation (proposal 0016, two days old)
  settle ([B6](#b6), [section](#service-auth-as-an-external-token)).

Everything else is either already in PLAN_LOOSE in Apron's own form (PKCE
`S256`, mandatory `state`, `iss`, consent before every redirect for public
clients) or a "don't borrow" for a stated reason.

## Recommendations

Ranked. Each is marked **enshrine now**, **note for later**, or **don't
borrow**.

<a id="b1"></a>
### B1. Enshrine now: a client's name only beside a verified host

**Where:** PLAN_LOOSE.md, "A server that is its own issuer"; EVALUATIONS.md R3.

PLAN_LOOSE today:

> It shows the server, and the host or scheme of `redirect_uri`, or the
> client's name from a client ID metadata document.

Replace with:

- The page shows the server, and the host of `redirect_uri`, or its scheme
  for an app scheme.
- A server MAY fetch a client ID metadata document when `client_id` is an
  `https` URL. It then accepts only a `redirect_uri` that the document lists.
- The page MAY show the document's `client_name` beside the host of
  `client_id`, never in place of a host.

And in EVALUATIONS.md R3, replace "Client ID metadata documents show the real
client." with "A client ID metadata document shows a host that the client
controls; its name is the client's claim."

**Why it is worth it.** Under open registration, a phishing client can send
`client_id=https://good.example/client.json` (a real document of a good
client) with its own `redirect_uri`. A page that shows "Good App" from the
document and does not check the redirect against it sends the user's code to
the attacker; PKCE does not help, since the attacker started the flow. AT
Protocol's spec says not to show `client_name`, `client_uri`, or `logo_uri`
for clients that the server does not trust, and to show the full `client_id`
URL by default ([OAuth spec, Security Considerations](https://atproto.com/specs/oauth#security-considerations));
the IETF draft says to show the `client_id` host and warns that
`client_name` and `logo_uri` can impersonate
([draft-ietf-oauth-client-id-metadata-document-03](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
§10.6, §10.10). The change removes an option rather than adding one, and
costs a server nothing unless it fetches documents.

<a id="b2"></a>
### B2. Enshrine now (EVALUATIONS.md, no wire change): the AT Protocol scenario

Add the [AT Protocol behind the portal](#at-protocol-behind-the-portal)
write-up to EVALUATIONS.md: one row in the "Behind the portal" table, two
findings, and one remaining risk. The two operator rules that matter:

- The portal verifies that the DID in the token response's `sub` is hosted
  by the authorization server that issued it, by resolving the DID, before
  it trusts `sub`.
- The portal keys AT Protocol identities by DID alone.

This is guidance for portals, which Apron does not specify. It belongs with
the other "Behind the portal" guidance because the failure is total: a
portal that skips the check lets any self-hosted PDS sign in as any account.

<a id="b3"></a>
### B3. Note for later: `login_hint` semantics in `ext:auth_external`

When the extension is drafted, give `login_hint` AT Protocol's semantics
(which match OpenID Connect's): it is a hint to the portal, and never an
identity. AT Protocol passes the user's handle or DID as `login_hint`, the
authorization server should only allow that account, and the client still
verifies `sub` ([OAuth spec, Identity Authentication and Authorization Interface](https://atproto.com/specs/oauth#identity-authentication)).
For Apron, a client that knows the user's handle (`@ada.example.com`) can
skip the portal's "enter your handle" page. The portal resolves it and passes
it on. No core change.

### B4. Note for later: protected resource metadata at the server's origin

AT Protocol, MCP, and other open ecosystems find the authorization server
from the resource with RFC 9728
(`/.well-known/oauth-protected-resource`, `authorization_servers`). An Apron
server MAY publish it, so that OAuth libraries discover the issuer from the
server's origin without the WebSocket. Not now: the begin request already
gives library clients the issuer, and a second source of the same data is a
second thing to keep consistent.

### B5. Note for later: app schemes in reverse order of the `client_id` host

AT Protocol requires a native client's custom scheme to be its `client_id`
host reversed (`https://app.example.com/…` gives `com.example.app:/callback`)
([OAuth spec, Request Fields](https://atproto.com/specs/oauth#request-fields)),
following RFC 8252 §7.1. PRIOR_ART.md already records it. It means something
only when `client_id` is a fetched document (B1), and the OS still lets any
app claim any scheme, so PKCE remains the guard against A3. Worth one MAY
bullet if Apron servers start fetching documents.

<a id="b6"></a>
### B6. Don't borrow now: AT Protocol service JWTs as an `external` token

See [the section below](#service-auth-as-an-external-token). In short: fails
A7, the JWT does not identify the app, the broad scopes most AT Protocol apps
hold can mint it for any audience, and verifiers must add DID resolution,
`ES256K`, and replay tracking. **Revisit when** AT Protocol ships a typed
token that requires a scope the user grants for this purpose, plus a client
attestation (proposal 0016's delegation token and client attestation are the
first such design), and someone asks for "join from my AT Protocol app with
no browser". It would then be an `ext:` native shortcut, not core.

### B7. Don't borrow: mandatory PAR

AT Protocol requires PAR so that confidential clients authenticate before the
consent screen (which can then offer silent sign-in), so large requests fit,
and so parameters stay off the front channel
([proposal 0004, Framework](https://github.com/bluesky-social/proposals/tree/main/0004-oauth#framework)).
Its own spec says the requirement "may be relaxed if it is found to be too
onerous" ([OAuth spec, PAR](https://atproto.com/specs/oauth#pushed-authorization-requests-par)).
In Apron, every client of a server-as-issuer is public, requests are small,
and nothing secret rides in the URL (PKCE sends only the challenge). PAR
would end the simple path (build the URL by hand). The Apron portal uses PAR
itself when it is an AT Protocol client; that needs no Apron wire.

### B8. Don't borrow: mandatory DPoP with server nonces

Consistent with the decision of 2026-11-14 (PLAN_LOOSE, "Forward
compatibility"). AT Protocol's context differs on each point that justified
the mandate: its access tokens go to the user's PDS, the store of all their
data; confidential sessions last up to two years in the reference server;
clients are arbitrary third parties with no relationship to the server; and
the PDS cannot always revoke access tokens (entryway). Apron's tokens are
spent only at the server that issued them, which can rotate and revoke them
at once. Two AT Protocol details fit Apron's reserved design if binding ever
ships: a fresh key per session, not per device; and a nonce that a server MAY
share across clients and rotate at least every 5 minutes. Apron's
per-connection nonce in the `server` frame is cheaper still, so keep it.

### B9. Don't borrow: confidential clients, `private_key_jwt`, and lifetimes by client type

AT Protocol lets clients with a published key (`jwks`) get longer sessions
and silent sign-in, and lets them revoke all their sessions by removing a key
([OAuth spec, Confidential Client Authentication](https://atproto.com/specs/oauth#confidential-client-authentication);
[client security essay](https://github.com/bluesky-social/atproto/discussions/3950)).
This answers a problem Apron's open clients do not have: an authorization
server that must decide how far to trust thousands of unknown clients, and
clients that need a kill switch across many servers. Apron already makes
lifetime server policy (§3.2.1), and rotation with reuse detection is the
baseline. A server that wants AT Protocol's shape can apply it as policy:
short sessions for unknown clients, longer for clients it lists.

### B10. Don't borrow: a stable account ID on the wire

AT Protocol separates the permanent DID from the changeable handle because
identities move between hosts and many services refer to them. Apron has one
authority per account. The server already identifies accounts internally
(PLAN_LOOSE: "by the issuer and the token's `sub`"), and the wire handles a
changed `user_id` with `user` and `old` (§3.3.3). A second identifier on the
wire would duplicate that. The lesson stays inside the portal (B2): key AT
Protocol identities by DID.

### B11. Don't borrow: app passwords, account migration

App passwords are AT Protocol's legacy third-party credential, which OAuth
replaces for new projects ([xrpc spec, App Passwords](https://atproto.com/specs/xrpc#app-passwords);
[OAuth blog post, 2024-09-25](https://atproto.com/blog/oauth-atproto)). No removal
date is published as of 2026-11-14; commercial schedulers still use them
(secondary source). Apron's `token` plus a command that issues more tokens
(§4.10) is already the analogue for bots. Migration solves moving an
identity between hosts, which Apron does not do.

### B12. Already in PLAN_LOOSE: keep

AT Protocol's profile and PLAN_LOOSE agree on: PKCE with `S256` only;
`state` required and checked; `iss` in the authorization response
(RFC 9207); single-use codes; consent before every redirect for clients that
cannot authenticate, also when signed in ([proposal 0004](https://github.com/bluesky-social/proposals/tree/main/0004-oauth#framework):
"the AS should always require user consent for unauthenticated clients");
loopback redirects with any port for development; CORS on the token endpoint
and metadata. A reused code revoking its tokens is an OAuth 2.1 SHOULD that
the loose profile inherits, so it needs no Apron text.

## Open questions

Numbered Q1 to Q6.

1. B1: should the page show `client_name` at all, or only hosts? AT Protocol
   shows names only for clients the server lists as trusted.
2. Should the AT Protocol portal keep the user's refresh token, to notice an
   account that is deleted or taken down at its PDS? (Same as PLAN_LOOSE
   question 1.) The simplest answer is no: request only `atproto` and
   discard the tokens.
3. When an Apron account came from an AT Protocol handle, and the handle
   changes, does the server rename `user_id` (with `old`), or keep it? And if
   the handle later points to a different DID, §3.3.3's "don't reuse a
   `user_id`" means the new DID gets another `user_id`.
4. Is the portal a public or a confidential AT Protocol client? Public is
   simpler (no key in client metadata). Confidential allows the PDS to skip
   its own consent screen on later sign-ins.
5. If service auth is revisited (B6): what NSID does Apron own for `lxm`
   (`chat.apron.*` follows from apron.chat), and what service fragment
   (`#apron_chat`)? AT Protocol's `did:web` forbids ports except on
   `localhost`, so a server on a non-default port cannot be an audience.
6. Should `ext:auth_external`'s list of options be able to say "AT
   Protocol", so that clients can show "Sign in with Bluesky" before the
   portal opens, as `label` does for one portal?

## Research areas

### 1. AT Protocol OAuth

The profile is OAuth 2.1 plus PKCE, PAR, DPoP, client ID metadata documents,
RFC 9207 `iss`, and RFC 8414 / RFC 9728 metadata. Source:
[OAuth spec](https://atproto.com/specs/oauth) (authoritative);
[proposal 0004](https://github.com/bluesky-social/proposals/tree/main/0004-oauth)
(historical rationale); [OAuth patterns guide](https://atproto.com/guides/oauth-patterns).

| Choice | What | Why (their context) |
|---|---|---|
| Client ID metadata documents | `client_id` is an `https` URL of a JSON document (redirect URIs, scopes, `jwks`). The authorization server fetches it, with SSRF protections, during PAR and later. No `client_secret`, no registration. | Dynamic registration (RFC 7591) makes clients keep state per server, loses credentials, and lets anyone register a look-alike. A URL ties the client to DNS, which users read as trust. |
| Relation to the IETF draft | AT Protocol was the first large deployment of [`draft-ietf-oauth-client-id-metadata-document`](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/) (Parecki, Smith). Now a WG document, revision -03 of 2026-11-02, not yet in last call. AT Protocol adds: no port in `client_id`, `dpop_bound_access_tokens: true` required, reverse-domain schemes. | Alignment is a stated goal of the spec. |
| Loopback development clients | `client_id` `http://localhost` (no port, empty path), redirect URIs and scopes in its query string; the server builds a virtual document, always public, named by the server ("Development client"). Optional, also in production. | Developers cannot publish metadata, and SSRF rules block local hosts. |
| PKCE | Mandatory, `S256` only. Servers prevent reuse of a `code_challenge` for about 24 hours (reference: 1 day). | OAuth 2.1. |
| PAR | Mandatory for every client (`require_pushed_authorization_requests: true`). | Client authentication before the UI, large requests, parameters off the front channel. Marked "may be relaxed". |
| DPoP | Mandatory, from PAR on, for the authorization server and the PDS. Server nonces mandatory, rotated at most every 5 minutes (reference: 3), may be shared by all clients. Fresh key per session. `ES256` required. | Bind tokens to the device. The client security essay calls this DPoP's main value. |
| Confidential clients | `private_key_jwt` (RFC 7523) with `ES256`; keys in `jwks` or `jwks_uri`. Sessions bound to the key; removing it from the document revokes them, so servers re-fetch documents. | A kill switch across many authorization servers; trust for longer sessions. The reference server did not yet enforce the binding as of mid-2025 ([blog](https://atproto.com/blog/oauth-improvements)). |
| Client assertion backend | Proposal: a small backend signs a client assertion bound (`cnf.jkt`) to the browser's DPoP key, so a browser app becomes confidential without proxying tokens ([proposal 0010](https://github.com/bluesky-social/proposals/tree/main/0010-client-assertion-backend), June 2025). | Confidential benefits without a token-mediating backend. |
| Lifetimes | Spec: access tokens under 30 minutes (15 if not revocable; 5 recommended). Public clients: session and refresh token at most 2 weeks. Confidential: session unlimited, refresh token 180 days. Reference server: 2 weeks / 2 weeks public; 2 years / 3 months confidential ([`oauth-constants.ts`](https://github.com/bluesky-social/atproto/blob/main/packages/oauth/oauth-provider/src/oauth-constants.ts)). Refresh tokens single-use. | Public clients cannot be revoked as a class, and cannot prove who receives a token. |
| Identity-first flow | Handle → DID (DNS TXT `_atproto` or `/.well-known/atproto-did`, verified both ways) → DID document → PDS → `/.well-known/oauth-protected-resource` → authorization server → RFC 8414 metadata, with `issuer` equal to the origin. A user may instead start from a server name. Caches under 10 minutes for auth. | The authorization server is per user, and users migrate. |
| `sub` verification | The token response carries the DID in `sub`. The client checks it equals the DID it resolved, or (server-first) resolves it and checks that the DID's PDS points to this issuer. The reference client does this on every token response, with no cache, and revokes the tokens on mismatch ([`oauth-server-agent.ts`](https://github.com/bluesky-social/atproto/blob/main/packages/oauth/oauth-client/src/oauth-server-agent.ts)). | "Otherwise a malicious server could authenticate arbitrary accounts." OpenID Connect cannot express this, so AT Protocol does not use it. |
| Scopes | `atproto` (required; alone = authentication only). Transitional: `transition:generic` (app-password level: all records, blobs, any service call except `chat.bsky.*`), `transition:chat.bsky`, `transition:email`. Granular: `repo:`, `rpc:<lxm>?aud=<did#svc>`, `blob:`, `identity:`, `account:`, and `include:` for permission sets published as lexicons ([permission spec](https://atproto.com/specs/permission)). Servers always return the granted `scope`. | Transitional scopes eased migration from app passwords; granular ones are the target. |
| Entryway | One authorization server for many PDSes (bsky.social for Bluesky's hosted PDSes). PDS metadata names it. Revoking a session stops refresh at once, but access tokens live up to 15 minutes ([blog](https://atproto.com/blog/oauth-improvements)). | Scale: one login service for millions of accounts on many hosts. |
| Consent | The authorization interface shows the full `client_id` URL; names and logos only for trusted clients. Silent sign-in only for confidential clients with prior consent. | Anyone can publish any metadata. |

**Uncertain or recent:** granular scopes and permission sets are new
(2025–2026); the CIMD draft is still changing; FedCM for open networks is
being explored ([blog, March 2026](https://atproto.com/blog/working-to-decentralize-fedcm)).
The IETF ATP working group (chartered 2026) covers repositories, sync, URIs,
and identity resolution, not OAuth ([blog](https://atproto.com/blog/kicking-off-the-atp-working-group)).

### 2. Inter-service auth

Source: [xrpc spec, Inter-Service Authentication](https://atproto.com/specs/xrpc#inter-service-authentication-jwt);
[proposals 0013](https://github.com/bluesky-social/proposals/tree/main/0013-service-auth-refs)
and [0014](https://github.com/bluesky-social/proposals/tree/main/0014-service-auth-revised)
(2026); [`getServiceAuth.json`](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/getServiceAuth.json),
[PDS handler](https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/api/com/atproto/server/getServiceAuth.ts),
[TS verifier](https://github.com/bluesky-social/atproto/blob/main/packages/xrpc-server/src/auth.ts),
[Go verifier](https://github.com/bluesky-social/indigo/blob/main/atproto/auth/jwt.go).

- **The token.** A JWT signed with the account's `#atproto` signing key,
  which the PDS holds. Header: `alg` (`ES256` or `ES256K`), `typ: JWT`,
  optional `kid` (default `#atproto`). Body: `iss` = user DID, `aud` = service
  DID plus service fragment (`did:web:api.example.com#svc`; bare DIDs
  deprecated), `lxm` = the XRPC method (becoming required), `iat`, `exp`,
  `jti`.
- **Minting.** The PDS mints it when it proxies a request (`atproto-proxy`
  header), or on request through `com.atproto.server.getServiceAuth?aud=…&lxm=…&exp=…`.
  Default lifetime 60 seconds; at most 1 hour with `lxm`, at most 1 minute
  without. The PDS refuses account-management methods. `chat.bsky.*` needs
  full access or a "privileged" app password. An OAuth session needs a
  covering `rpc:` permission; `transition:generic` covers every method
  outside `chat.bsky.*`, also `lxm=*`, for any `aud`
  ([`scope-permissions-transition.ts`](https://github.com/bluesky-social/atproto/blob/main/packages/oauth/oauth-scopes/src/scope-permissions-transition.ts),
  [`pipethrough.ts`](https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/pipethrough.ts)).
- **Verification.** The service checks `exp`, `aud` equal to its own DID and
  fragment, `lxm` equal to the method, rejects `typ` of `at+jwt`,
  `refresh+jwt`, or `dpop+jwt`, resolves `iss` to its DID document, takes the
  `#atproto` key, verifies the signature, and on failure re-resolves once
  without cache (a rotated key). It accepts only key IDs it expects.
- **Replay.** `jti` "should be used" against replay, but both reference
  verifiers skip it (the Go one has a TODO). Within its lifetime the JWT is a
  bearer token.
- **Revocation and rotation.** No revocation: short lifetimes instead. Key
  rotation is a DID document update (a PLC operation, or the `did:web`
  host's file); verifiers re-resolve on failure.
- **What it does not carry.** No `client_id` and no scope. The service
  learns that the user's PDS vouched for the request, not which app asked.
- **Uses.** App views, labelers, feed generators, Bluesky's DM service
  (the `chat.bsky.*` methods, proxied by the PDS), and account migration (the
  new PDS accepts a service JWT for `com.atproto.server.createAccount` as
  proof of the DID).
- **Recent and uncertain.** Proposal 0014 (2026) moved `aud` to DID plus
  fragment and `iss` key selection to `kid`; the reference PDS still sends
  bare DIDs when proxying by default, behind a flag. Proposal 0016 ("Spaces",
  merged into the proposals repository 2026-11-12, "likely to change") adds a
  separate class of token for private data: a delegation token
  (`typ: atproto-space-delegation+jwt`, single use, 60 seconds, needs a
  `space:` scope) and a client attestation (a `private_key_jwt`-shaped JWT
  that names the app) ([proposal 0016](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data)).
  It lists group chats among its use cases.

### 3. Identity

Source: [DID spec](https://atproto.com/specs/did), [handle spec](https://atproto.com/specs/handle),
[account spec](https://atproto.com/specs/account).

| | AT Protocol | Apron |
|---|---|---|
| Stable ID | DID: `did:plc` (a directory of signed operations, with rotation keys) or `did:web` (hostname only; no path; no port except `localhost`). Permanent, global. | None on the wire. The server keys accounts internally; PLAN_LOOSE: "by the issuer and the token's `sub`". |
| Name | Handle: a DNS name, verified both ways (the DID document claims it, and DNS TXT or HTTPS resolves it to the DID). Changeable. Shown lowercase, never truncated; `handle.invalid` when it fails. | `user_id`: required, changeable with `user`/`old` (§3.3.3), not reused (SHOULD NOT). `name` is free text. |
| Authority | The DID document names the PDS, which names the authorization server. | The server, by its address. |
| Moving | Migration: a new PDS, a DID document update, a new signing key; the DID stays. | Not applicable. |

**Comparison.** PLAN_LOOSE's "issuer and `sub`" is right for OpenID Connect,
where `sub` is only unique per issuer. AT Protocol's `sub` is a DID, globally
unique, and its issuer changes on migration. An Apron server that keyed an AT
Protocol identity by (authorization server, DID) would treat a migrated user
as a stranger, and could hand their old account to no one or create a
duplicate. Behind the portal this is the portal's business (B2), so
PLAN_LOOSE's rule for foreign issuers stays as is.

### 4. Other ideas

- **Strangers trusting each other without coordination.** AT Protocol uses
  four public, fetchable documents: client metadata (clients), DID documents
  (users and services), protected resource metadata (resource to
  authorization server), and authorization server metadata. Every check is a
  resolution, cached briefly, with SSRF-hardened fetches. Apron's U1 is met
  differently: open registration with `resource` binding, and the server's
  address as the anchor. Apron needs none of the resolution steps unless it
  accepts DIDs.
- **App passwords.** Broad, unscoped credentials with a fixed format
  (`xxxx-xxxx-xxxx-xxxx`) so that clients can catch a main password; the DM
  toggle was added later. Their privilege level survives as
  `transition:generic`. The lesson for Apron: a credential that any third
  party can hold with broad power is hard to narrow later. Apron's bearer
  tokens are per server and revocable, so this is already contained.
- **Type separation of JWTs.** `at+jwt`, `refresh+jwt`, `dpop+jwt`,
  `atproto-space-delegation+jwt`, `atproto-client-attestation+jwt`: each
  verifier rejects the others. If Apron ever issues JWTs, give each kind its
  own `typ`.
- **Revocation latency with a shared authorization server.** The entryway's
  15-minute window is the same trade-off as PLAN_LOOSE question 1 with a
  foreign issuer.

## Service auth as an `external` token

### Feasibility

It works with today's PDS, with no change on the AT Protocol side.

```text
1. The client derives the audience from the server's address:
   wss://chat.example/ws  ->  aud = did:web:chat.example#apron_chat
2. GET https://<user's PDS>/xrpc/com.atproto.server.getServiceAuth
       ?aud=did:web:chat.example%23apron_chat&lxm=chat.apron.auth.signIn
   Authorization: DPoP <access token>; DPoP: <proof>
   -> {"token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NksifQ.…"}
```

The PDS checks only the syntax of `aud`; it does not resolve it. So the Apron
server needs no published DID document for this, though it should publish
one at `https://chat.example/.well-known/did.json` for proxying and for
anyone who looks.

```jsonc
// JWT body, as minted by the PDS
{"iss": "did:plc:ewvi7nxzyoun6zhxrhs64oiz", "aud": "did:web:chat.example#apron_chat",
 "lxm": "chat.apron.auth.signIn", "iat": 1794672000, "exp": 1794672060, "jti": "9f2c…"}
```

```jsonc
// -> the existing external token form
{"method": "auth", "id": "c1", "params": {"scheme": "external",
  "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NksifQ.eyJpc3MiOiJkaWQ6cGxjOmV3dmk3…"}}
// <-
{"id": "c1", "result": {"you": {"user_id": "ada.example.com", "name": "Ada"}, "token": "st_…"}}
```

Discovery would go in `ext:auth_external`'s list of options, as a flag only:
the client never takes the audience from the server.

### What the server must do

1. Tell a service JWT from an issuer token: `iss` is a `did:plc:` or
   `did:web:` DID, not an `https` issuer.
2. Reject `typ` `at+jwt`, `refresh+jwt`, `dpop+jwt`.
3. Check `aud` equals its own DID and fragment exactly; `lxm` equals its
   method; `exp` is in the future and at most a few minutes after `iat`.
4. Keep each `jti` until its `exp`, and reject a repeat.
5. Resolve `iss`: `https://plc.directory/<did>` for `did:plc` (or a
   replica), `https://<host>/.well-known/did.json` for `did:web`, with an
   SSRF-hardened client and a short cache; take the `#atproto` `Multikey`.
6. Verify `ES256` (P-256) or `ES256K` (secp256k1); on failure, re-resolve
   once without cache.
7. Map the DID to an account; for a new one, verify the handle both ways
   before suggesting it as `user_id`.
8. Issue an Apron `token`.

Libraries cover steps 2–6: `@atproto/xrpc-server` `verifyJwt` and
`@atproto/identity` (TypeScript), indigo `atproto/auth` and
`atproto/identity` (Go).

### Risks

| Attacker | Outcome |
|---|---|
| A1, a malicious server | Holds, if the client derives `aud` from the address it connects to, as it does `resource`. A client that took `aud` from the server could be led to mint a token for another server. |
| A2, a malicious client | **Fails the spirit.** The JWT does not name the app. Any app with `transition:generic` (most AT Protocol apps today) or an app password can mint it, with no screen that mentions the Apron server. The user's consent was "manage my Bluesky account", given to some other app, perhaps years ago. |
| A6, a copied token | A bearer for up to 60 seconds (1 hour if the client asks). `jti` tracking stops reuse; the reference verifiers do not do it. |
| A7, code in a client | **Fails.** Code running in any AT Protocol client the user signed in to can mint new Apron sessions without the user's action. The portal's confirmation, Apron's guard for A7 (R5), never runs. |
| Other | The server's trust anchor becomes the user's PDS: any PDS operator can sign in as their own users (true of the portal path too). `did:web` cannot carry a port. Sign-in depends on `plc.directory` being reachable. |

Bluesky's own DM service is the closest precedent, and it shows the gap: it
accepts service JWTs, but `chat.bsky.*` is the one namespace that
`transition:generic` and ordinary app passwords cannot mint, because DMs are
private. An Apron server cannot get that fence for its own NSID; only a
granular `rpc:` scope or a future typed token can.

### Recommendation

Don't borrow now (B6). Revisit as an `ext:` native shortcut when AT Protocol
offers a token that (a) only a scope granted for this purpose can mint, and
(b) comes with a client attestation, so the Apron server can show and limit
which app is asking. Proposal 0016's delegation token and client attestation
are that shape for Spaces; watch whether a general form appears.

## AT Protocol behind the portal

Suitable for EVALUATIONS.md, "Behind the portal". The Apron server's portal
is an AT Protocol OAuth client. Apron clients see a plain `external` sign-in.

### Setup (operator, not wire)

- Client metadata at `https://chat.example/oauth/atproto-client.json`:
  `client_id` that URL, `application_type: web`, `grant_types:
  ["authorization_code"]`, `response_types: ["code"]`, `scope: "atproto"`,
  `redirect_uris: ["https://chat.example/oauth/atproto/callback"]`,
  `dpop_bound_access_tokens: true`, `token_endpoint_auth_method: none` (or
  `private_key_jwt` with `jwks`, Q4).
- A library: `@atproto/oauth-client-node`, indigo `atproto/auth/oauth`, or
  the Python cookbook's manual implementation.

### Steps

1. The Apron client sends the begin request, builds the portal URL with
   PKCE, `state`, and `resource`, and opens it.
2. The portal asks for a handle, or a hosting provider. A `login_hint` from
   the extension pre-fills it (B3).
3. The portal resolves handle → DID (both ways) → DID document → PDS →
   protected resource metadata → authorization server metadata, and checks
   `issuer`.
4. The portal sends PAR with a fresh DPoP key, PKCE, `state`, `scope=atproto`,
   and `login_hint`, handling `use_dpop_nonce`. It keeps the pending request
   bound to the browser session (a cookie), and to the pending Apron request.
5. The browser goes to the authorization server, which signs the user in by
   its own method and shows consent with the portal's `client_id`.
6. The callback carries `code`, `state`, `iss`. The portal checks both
   against its pending request.
7. The portal redeems the code with DPoP and PKCE, and gets `sub` (a DID)
   and `scope`. It rejects a response without `atproto` in `scope`.
8. **The portal verifies `sub`:** equal to the DID from step 3, or, if the
   user started from a server, the DID's PDS points to this issuer. Without
   this, any PDS can claim any DID.
9. The portal discards the AT Protocol tokens (or revokes them). It maps the
   DID to an Apron account by DID alone; a new account takes the verified
   handle as a suggested `user_id`, and `name` and avatar from the public
   profile record, which needs no scope.
10. The portal confirms ("Sign in to chat.example in web.example as
    @ada.example.com?") and redirects with an Apron code, `state`, and `iss`.
11. The client redeems the code on the connection, and gets an Apron `token`.

### Client kinds

All of W1, W3, N1, N3, and T, as for any `external` portal: the AT Protocol
steps run inside the portal's browser context, between web origins. T uses
the device grant or loopback on the Apron side, and the AT Protocol steps
run in the phone's or desktop's browser.

| Method behind the portal | Same browser | Sign-in session | Custom Tab | System browser | Another device |
|---|---|---|---|---|---|
| AT Protocol (Sign in with Bluesky), by the portal | ✅ | ✅ | ✅ | ✅ | ✅ |

Caveats: the user must know their handle or hosting provider; the hosting
provider's sign-in may ask for an email code, which is typed into its page
and works in every context; the user sees two consent screens (the PDS's,
then the portal's).

### What can go wrong

| Attacker | Guard |
|---|---|
| A1, a malicious Apron server | Apron's `resource`, `aud`, `iss` as for any portal. Its own portal learns the user's DID and public profile. If it asks for more than `atproto`, the PDS's consent screen shows the scopes; the user must refuse. |
| A1′, a malicious PDS or authorization server | Claims a DID it does not host. Guard: step 8. |
| A2, a malicious Apron client | The portal's confirmation, which shows the redirect's host (B1). Unchanged by AT Protocol. |
| A3, another app | PKCE on the Apron layer. The AT Protocol layer uses an `https` callback on the portal; nothing for an app to claim. |
| A4, login CSRF | Apron's `state`; the portal binds AT Protocol's `state` to the browser session that started it (step 4), so an attacker's callback cannot sign the victim in to the attacker's account. |
| A5, guessing | Handles and DIDs are public, so nothing to enumerate on the AT Protocol side. A portal that says "no account here" reveals membership; that is policy. |
| A6, a copied token | Nothing to copy from the AT Protocol side once tokens are discarded; DPoP-bound if kept. Apron's rotation as the baseline. |
| A7, code in the client | It can start a sign-in, and the PDS may skip its consent for a returning confidential client, but the portal's confirmation before the redirect still runs. |

Findings to add:

- **F10.** AT Protocol's `sub` is trustworthy only after the DID's PDS is
  shown to point to the issuer. A portal that skips step 8 lets any PDS sign
  in as any account. Guidance: B2.
- **F11.** Keying by (issuer, `sub`) breaks when an AT Protocol user
  migrates to another PDS. Guidance: key by DID alone.

Remaining risk:

- **R6.** A portal that requests broader AT Protocol scopes than `atproto`
  holds write access to its users' accounts elsewhere. Request only
  `atproto`, and keep no tokens.

## AT Protocol and SIWE as scenarios

Both are identities that an Apron server can accept behind its portal, and
both have a tempting native path that Apron should keep closed.

| | AT Protocol | SIWE ([EIP-4361](https://eips.ethereum.org/EIPS/eip-4361), Final) |
|---|---|---|
| Stable ID | DID | Address, with chain (CAIP-10, `eip155:1:0x…`) |
| Changeable name | Handle, verified both ways through DNS | ENS name, optional; resolution is a MAY, forward and reverse |
| Who holds the key | The PDS (custodial); the user signs in to the PDS | The user's wallet |
| Proof | An OAuth redirect; the DID checked against the issuer | A signed message with `domain`, `uri`, `nonce`, `chain-id`, times |
| Binding to the relying party | `client_id` and redirect; service JWT `aud` | The wallet MUST check `domain` against the request's origin |
| Contract or remote verification | DID resolution (PLC directory, `did:web`) | ERC-1271 for contract wallets: a chain call, from the stated `chain-id` |
| Delegation | Scopes; service JWTs | None in EIP-4361; ReCaps ([ERC-5573](https://eips.ethereum.org/EIPS/eip-5573)) add capabilities |
| Key rotation | DID document update; the DID stays | A new address is a new identity, unless a contract wallet |
| Where it works | Any browser context | An extension or WalletConnect; sign-in sessions and Custom Tabs unverified (EVALUATIONS.md, footnote 3) |
| Native path | Service JWT on `auth`: fails A7, no app identity (B6) | A signature over a nonce on the connection: a native client has no origin for the wallet to check, so the `domain` binding is lost (A1) |

What they share for Apron: the portal does the protocol-specific work
(resolution, signature checks, chain or directory calls); the Apron account
keys on the stable ID (DID; chain plus address); the name layer (handle;
ENS) is only a suggested `user_id` after it is verified; and the native
shortcut loses the guard that the browser gives (consent with a host for AT
Protocol, the origin check for SIWE). Where they differ: AT Protocol's
custodial keys make the PDS the authority, so a hostile PDS is the main risk
(F10); SIWE's self-held keys make the wallet's origin check the guard, which
only a browser context provides.

## Sources

AT Protocol specifications:
[OAuth](https://atproto.com/specs/oauth),
[HTTP API (XRPC), inter-service auth](https://atproto.com/specs/xrpc#inter-service-authentication-jwt),
[Permissions](https://atproto.com/specs/permission),
[DID](https://atproto.com/specs/did),
[Handle](https://atproto.com/specs/handle),
[Accounts](https://atproto.com/specs/account),
[Cryptography](https://atproto.com/specs/cryptography).

AT Protocol guides and posts:
[OAuth patterns](https://atproto.com/guides/oauth-patterns),
[OAuth Improvements (2025-06-12)](https://atproto.com/blog/oauth-improvements),
[OAuth for AT Protocol (2024)](https://atproto.com/blog/oauth-atproto),
[OAuth client security in the Atmosphere (discussion 3950)](https://github.com/bluesky-social/atproto/discussions/3950),
[Working to Decentralize FedCM (2026-03-09)](https://atproto.com/blog/working-to-decentralize-fedcm),
[ATP working group (2026-04-02)](https://atproto.com/blog/kicking-off-the-atp-working-group).

Proposals:
[0004 OAuth](https://github.com/bluesky-social/proposals/tree/main/0004-oauth),
[0010 client assertion backend](https://github.com/bluesky-social/proposals/tree/main/0010-client-assertion-backend),
[0011 auth scopes](https://github.com/bluesky-social/proposals/tree/main/0011-auth-scopes),
[0013 service references](https://github.com/bluesky-social/proposals/tree/main/0013-service-auth-refs),
[0014 service auth audience revised](https://github.com/bluesky-social/proposals/tree/main/0014-service-auth-revised)
([discussion 4708](https://github.com/bluesky-social/atproto/discussions/4708)),
[0016 Spaces](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data).

Source code:
[`getServiceAuth` lexicon](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/server/getServiceAuth.json),
[PDS `getServiceAuth`](https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/api/com/atproto/server/getServiceAuth.ts),
[PDS privileged and protected methods](https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/pipethrough.ts),
[transitional scope permissions](https://github.com/bluesky-social/atproto/blob/main/packages/oauth/oauth-scopes/src/scope-permissions-transition.ts),
[service JWT create and verify (TS)](https://github.com/bluesky-social/atproto/blob/main/packages/xrpc-server/src/auth.ts),
[service JWT verify (Go)](https://github.com/bluesky-social/indigo/blob/main/atproto/auth/jwt.go),
[OAuth client `verifyIssuer`](https://github.com/bluesky-social/atproto/blob/main/packages/oauth/oauth-client/src/oauth-server-agent.ts),
[OAuth provider constants](https://github.com/bluesky-social/atproto/blob/main/packages/oauth/oauth-provider/src/oauth-constants.ts),
[`@atproto/did` `did:web` rules](https://github.com/bluesky-social/atproto/blob/main/packages/did/src/atproto.ts).

IETF and others:
[draft-ietf-oauth-client-id-metadata-document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/),
[OAuth 2.1](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/),
[RFC 9126 PAR](https://datatracker.ietf.org/doc/html/rfc9126),
[RFC 9449 DPoP](https://datatracker.ietf.org/doc/html/rfc9449),
[RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523),
[RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414),
[RFC 9728](https://www.rfc-editor.org/info/rfc9728/),
[RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207),
[RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252),
[EIP-4361 SIWE](https://eips.ethereum.org/EIPS/eip-4361),
[ERC-1271](https://eips.ethereum.org/EIPS/eip-1271),
[ERC-5573 ReCaps](https://eips.ethereum.org/EIPS/eip-5573).
App password status (secondary, not official):
[OpenTweet, September 2026](https://opentweet.io/answers/bluesky-password-scheduling-tool).
