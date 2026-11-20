# Notes: external sign-in, passkeys, and redirects

Local working notes; not committed. v10 (embed streaming) shipped on
2026-10-30, with the §4.10 RP ID check. The current direction is
[PLAN_OAUTH.md](PLAN_OAUTH.md); this file keeps the earlier thinking.

## Goal

One passkey per account that works from any client: web.apron.chat, a
self-hosted apron-web, native apps (SideTable), TUIs. Flow from the chat with
vrypan: client -> popup to the server's sign-in page -> passkey -> back to the
client with a token.

## Why passkeys are coupled to the frontend

- A passkey belongs to an RP ID (a domain). Browsers only let pages on that
  domain use it.
- §4.10 today makes the RP ID the web client's domain (web.apron.chat), so
  other clients cannot use it.
- A generic web client that holds passkeys for many servers shares one RP ID
  across them: the browser lists them together, and a server can learn
  another server's credential ID and user handle.
- Native macOS: `ASAuthorizationPlatformPublicKeyCredentialProvider` can use
  RP ID `web.apron.chat` only with the `webcredentials:web.apron.chat`
  entitlement AND that domain's `apple-app-site-association` listing the app.
  Fine for first-party apps; impossible for third-party ones. (The browser
  passkey entitlement is for web browsers only.) Verify which origin Apple
  reports in clientDataJSON for native assertions; Android reports
  `android:apk-key-hash:…`.

## Direction: the server owns the passkey, clients use `external`

- The server's sign-in page runs the passkey ceremony with RP ID = the
  server's domain. Any client reaches it through `external` (§4.11):
  web popup, `ASWebAuthenticationSession` on macOS, or a code to type.
- Already in v9 `external`: page `url` from the proposal, redirect to
  `return_url` with `#token=…&state=…&server=…`, a confirm interstitial that
  shows the host, a code to type without `return_url`, and a long-lived
  bearer token on approval. vrypan's "simpler version" needs no new wire.
- Optional fast path for first-party clients: WebAuthn related origins
  (`/.well-known/webauthn`, about 5 domains; Chromium and Safari, check
  Firefox) and native associated domains, to use the server's RP ID without a
  browser hop.

## Redirect target (the open debate)

- `apron:` must not carry tokens: with two clients installed (SideTable and
  Stupid), the OS picks which one gets it. A.4 already forbids token links in
  the `apron:` form. `apron:` is right for places (like `magnet:`), wrong for
  credentials, which must return to the client that started the sign-in.
- Loopback (`http://127.0.0.1:<port>`) is safe against shazow's
  `?redirect=maliciousurl` attack: the token lands on the victim's own
  machine. RFC 8252 allows loopback on any port, and client-specific schemes.
- Remaining risk: another local app catches the redirect. PKCE (RFC 7636)
  makes a caught token useless.
- link.apron.chat as the redirect: a central dependency (if it's down, every
  server's sign-in breaks), and it still has to route the token to a client.
  The code-to-type path covers TUIs and odd setups without it.
- Self-hosted apron-web on an origin the server doesn't trust: falls back to
  the code to type. Each server decides which web origins it trusts.

## Draft spec changes (not started)

1. §4.10: servers SHOULD use their own domain as the RP ID, and offer
   passkeys on their `external` page. The server stores each credential's RP
   ID and origin, and checks them at login.
2. §4.11.5, the `return_url` that a server accepts:
   - an `https` origin that it trusts (web clients).
   - an `http` loopback address on any port (native and terminal clients).
   - a client-specific scheme such as `sidetable:`, never `apron:`.
   - none: the page shows a code.
3. PKCE: a proposal MAY carry `code_challenge`; the approval then MUST carry
   the matching `code_verifier`. Clients that redirect to a loopback address
   or their own scheme SHOULD use it.
4. The page shows where the token goes: the host, or "an app on this device"
   for a loopback address or a scheme.
5. Optional pointer: a server MAY let more origins use its RP ID through the
   standard related-origins file.
6. §4.10: clients run a ceremony only when its RP ID is the server's host or
   a domain that the host is under. Landed in v10.

Also needed with the change: HISTORY entry, schema fields for
`code_challenge` / `code_verifier`, fixtures for loopback and PKCE, and §5.2
updates.

## Later: a neutral provider (auth.apron.chat)

- shazow's idea: servers choose external providers they trust to mint
  short-lived tokens, which the server upgrades to a session token. Could
  also bridge OIDC (such as atproto OAuth).
- Fits behind `external` with no wire change: the server's `url` points at
  the provider, and the server checks the provider's token server to server.
- vrypan's concern: one passkey across every server that trusts the
  provider. Convenient, but centralizes trust and lets servers link a user's
  accounts.
- The only wire part: offering more than one provider (a `provider` choice
  in the proposal, listed in the `server` frame, maybe via `ext:settings`).
  Hold until a second provider exists.

## Open questions

- Is a client-specific scheme acceptable without PKCE, or should PKCE be
  required for anything but an `https` origin?
- What should the interstitial say for a loopback address or a scheme it
  cannot identify?
- Should the server frame hint which sign-in methods its `external` page
  offers (passkey, OIDC, …), so clients can label the button?

## Review of the deployment (2026-10-31)

- apron-server-cloudflare production: `RP_ID = "apron.chat"`,
  `RP_ORIGINS = "https://web.apron.chat"`, `ALLOWED_ORIGINS = "*"`. Passkeys
  belong to `apron.chat`, which covers both web.apron.chat and
  server.apron.chat, not to web.apron.chat alone.
- apron-web `requestPasskey` (src/lib/protocol/webauthn.ts) passes the
  server's `public_key` to the browser unchanged, and users can connect to
  any server address.
- Relay attack: a malicious server M that a user reaches through
  web.apron.chat opens its own connection to server.apron.chat with a forged
  `Origin: https://web.apron.chat`, gets a login challenge (rp.id
  `apron.chat`), and hands it to the user as its own. The browser signs it
  with the user's apron.chat passkey and origin web.apron.chat, which is
  exactly what server.apron.chat expects. M signs in as the user and gets a
  resume token. Nothing on the server can tell, since a non-browser can set
  any `Origin`.
- Fix (client): run a ceremony only when its RP ID (`rp.id` for create,
  `rpId` for get, else the page's host) is the server's host or a domain that
  the host is under. Integrated in apron-web on another branch
  (apron-chat/apron-web#183 was not used). Specified in §4.10 in v10.
- Keep `RP_ID = "apron.chat"`: changing it orphans every passkey (stored
  credentials carry no RP ID). A sign-in page on server.apron.chat can reuse
  the same passkeys: add its origin to `RP_ORIGINS`.
- Other domains: related origins file at `https://apron.chat/.well-known/webauthn`
  (about 5 domains, plus each in `RP_ORIGINS`), associated domains on
  apron.chat for native apps, and `external` for everyone else.

## Draft: `ext:handoff` (EXTENSIONS.md style)

Name: `ext:handoff`, since the page hands the sign-in back to the app that
proposed it. Rejected: `ext:pkce` and `ext:consent` (each names only half),
`ext:oauth` (promises OAuth endpoints). PKCE could later move into §4.11.

Lets a sign-in page approve an `external` proposal (§4.11) for a native
client, and binds the approval to the client that proposed it with PKCE. A
server can then use a page that it trusts, such as one a web client hosts.

```jsonc
// -> proposal (verifier and challenge are RFC 7636's example pair)
{"method": "auth", "id": "c1", "params": {"scheme": "external", "return_url": "sidetable://signed-in",
  "state": "q8Rz…", "agent": "SideTable/1.2",
  "ext": {"handoff": {"challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"}}}}
// <-
{"id": "c1", "result": {"url": "https://web.apron.chat/sign-in?server=wss%3A%2F%2Fserver.apron.chat%2F&p=Qm7x…"}}
// -> approval, after the redirect
{"method": "auth", "id": "c2", "params": {"scheme": "external", "token": "xt_Hk41…",
  "ext": {"handoff": {"verifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"}}}}
```

```ts
class Handoff {          // auth params: ext.handoff
  challenge?: string;    // proposal: unpadded base64url of SHA-256(verifier)
  verifier?: string;     // approval: 43 to 128 characters of A-Z a-z 0-9 - . _ ~
}
```

PKCE:
- A client makes a new verifier for each proposal: 32 random bytes as
  unpadded base64url.
- The proposal carries `challenge`. Clients that redirect to a loopback
  address or their own scheme send it.
- An approval of a proposal with a `challenge` MUST carry the matching
  `verifier`. Otherwise it is `denied`, and the temporary token is used up.
- A server MAY refuse a proposal without `challenge` whose `return_url` is
  not `https`, as `invalid_params`.

The page:
- The proposal's `url` is a page that the server trusts, with `server` (the
  server's address) and `p` (the proposal) in its query.
- The page connects to `server`, which advertises `ext:handoff`.
- `ext:handoff_get {proposal}` returns `{agent?, destination, expires}`.
  It works before the page signs in. `destination` is the origin of an
  `https` `return_url`, the scheme (`sidetable:`), or `loopback`.
- `ext:handoff_approve {proposal}` returns `{redirect}`. It needs a
  connection signed in to an account (not a guest), uses up the proposal,
  and mints the temporary token (§4.11.2).
- `ext:handoff_deny {proposal}` returns `{redirect}` with
  `#error=access_denied&state=…&server=…`, and uses up the proposal.
- The server answers these methods only on connections from its page's
  origin.
- The page shows `agent` and `destination`, asks the user to confirm, and
  then navigates to `redirect`.

Without the extension: clients use `external` as §4.11 defines it, without
PKCE, and each server hosts its own page.
