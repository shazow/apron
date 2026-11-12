# Prior art: third-party clients signing in to a server

How other systems let a client that the server's operator does not know sign
in, grouped by which of our plans they resemble. Compare
[PLAN_MINIMAL.md](PLAN_MINIMAL.md) and [PLAN_ENDGAME.md](PLAN_ENDGAME.md). The
endgame plan now merges the earlier PKCE plan ("Plan 2" below) and the
bound-token plan ("Plan 3" below).

Items marked *(memory)* are from background knowledge and were not checked
for this note. The others were checked against the sources at the end.

## Like Plan 1: redirects to known places, and codes for the rest

| system | what it does | lesson for us |
|---|---|---|
| Matrix, legacy SSO (`m.login.sso`, `m.login.token`) | The client sends the user to the homeserver's SSO URL with a `redirectUrl`. The homeserver signs the user in, often through an OIDC provider, and redirects back with a short-lived login token, which the client exchanges with `m.login.token`. Synapse keeps a `client_whitelist`; for other URLs it shows a confirmation page first. MSC2608 recommends a lifetime of about five seconds. | The closest match to v9 `external`, including an identity provider behind the homeserver (option F). Synapse chose a confirmation page over refusing unknown clients, which is the consent model that `return_origin` relies on. |
| Mastodon, out-of-band code | A client registers itself with each instance at runtime (`POST /api/v1/apps`), with no operator involved. With `redirect_uri: urn:ietf:wg:oauth:2.0:oob`, the instance shows the code instead of redirecting, and the user pastes it into the client. | The code path works at scale between strangers. Self-registration is another way to avoid operator lists. |
| Google out-of-band flow *(memory)* | Google offered the same pasted code, and retired it in 2022, citing phishing. | A code that the client redeems on any connection can be phished. Ours is bound to the proposing connection, which narrows this. |
| `gcloud auth login --no-launch-browser` *(memory)* | Prints a URL; the user signs in elsewhere and pastes back a code. | The terminal-client case (scenario 5). |

## Like Plan 2: OAuth-shaped, with PKCE and app redirects

| system | what it does | lesson for us |
|---|---|---|
| OAuth for native apps (RFC 8252) with PKCE (RFC 7636); AppAuth libraries | Native apps open the system browser or a sign-in session, and receive the code on a loopback port, a private-use scheme, or a claimed `https` link. PKCE binds the code to the app that asked. | The standard Plan 2 is modelled on. RFC 8252 already favors loopback for desktop apps, as the endgame plan does. |
| AT Protocol (Bluesky) OAuth | `client_id` is the URL of the client's metadata document, so no registration is needed. PKCE and DPoP are required. A native app's custom scheme must be its `client_id` host in reverse order: `app.example.com` gives `com.example.app:/callback`. Native apps may instead use an `https` callback on the `client_id`'s origin. | Strangers coordinate through a URL the client controls. Tying the scheme to a domain that the client proves it owns answers "which app owns this scheme", which our "scheme contains a `.`" rule does not. |
| Matrix next-generation auth (MSC3861, Matrix Authentication Service) | Matrix is replacing its legacy SSO with OAuth 2.0: clients register dynamically (RFC 7591, MSC2966), use PKCE, use the authorization code flow on the same device, and use the device authorization grant (RFC 8628) for QR login on another device (MSC4108). Element X was the first client; matrix.org moved to it in April 2025. | The closest ecosystem moved from a Plan 1 shape to a Plan 2 shape, and judged full OAuth worth it. It also needed dynamic registration and a cross-device grant on top. |
| Mastodon 4.3 | Added PKCE (`S256` only) and several redirect URIs per app. Community discussion favors Client ID Metadata Documents over dynamic registration, which creates many registrations. | PKCE is now expected even by servers that started without it. |
| Popup sign-in on the web *(memory)* | Google Identity Services' popup mode and Sign in with Apple's JS popup return the result to the opener with `postMessage`. The `web_message` response mode is an OAuth draft for the same thing. | The endgame plan's posted code follows an established pattern, and share its opener and popup-blocker issues. |

## Like Plan 3: bound to the requesting connection

| system | what it does | lesson for us |
|---|---|---|
| Discord QR login (remote auth gateway; undocumented, reverse-engineered) | The client that wants to sign in opens a WebSocket to `remote-auth-gateway.discord.gg`, exchanges keys, and shows a QR code. A signed-in phone scans and approves, and the gateway sends a ticket down the waiting socket, which the client exchanges for a token. | Approval delivered over a held connection, as in the endgame plan. The key exchange means even the gateway's message is useless to anyone else. QR-login phishing is a known abuse, the same class as our mailed link. |
| Telegram and WhatsApp Web QR login *(memory)* | The new client holds its connection, shows a QR code, and receives the session on that connection once a signed-in phone approves. | The same pattern; widely used, and first-party only. |
| `tailscale up` *(memory)* | The node prints a URL and waits on its control connection; when the user approves in a browser, the control server signs the waiting node in. | Binding to the waiting party, with no token for the client to carry. |
| OAuth device authorization grant (RFC 8628) | The device polls with a secret `device_code` until the user approves elsewhere. | Between binding and PKCE: the requester proves itself with a secret it holds, and needs no redirect. Matrix uses it for cross-device login. |

Several of these push the result to the waiting connection instead of handing
the client a token to present. For Apron, that would mean an approval signing
in the proposing connection directly, with the redirect or message only
telling the client to close the window. It would remove token handling from
clients, and needs a server-initiated sign-in, which §3.2.2 does not have
today.

## Like a shared provider or a page on another party's site

| system | what it does | lesson for us |
|---|---|---|
| Mozilla Persona (BrowserID) *(memory)* | A neutral fallback identity provider, `login.persona.org`, signed users in for sites and email domains without their own support. Mozilla shut it down in 2016. | A neutral service needs an owner for the long term. Its shutdown stranded the sites that depended on it. This is the main risk of auth.apron.chat and of option I. |
| Matrix Authentication Service | One authentication service per homeserver, not a shared one. | The ecosystem closest to ours chose per-server, which is what F and Pocket ID give. |
| Synapse with an OIDC provider; Pocket ID and similar self-hosted providers | The homeserver delegates sign-in to a provider that its operator runs or chooses; clients see only the homeserver's SSO. | Option F, deployed widely. |
| "Sign in with Google" and "Sign in with Apple" | Large central providers that sites trust to vouch for users. | The shape of a neutral provider, at a scale and with an owner that a community project does not have. |

## Like option C: one passkey RP ID across blessed clients

| system | what it does | lesson for us |
|---|---|---|
| WebAuthn related origins (`/.well-known/webauthn`) *(memory)* | Lets a short list of origins use one RP ID; Chrome and Safari support it. Meant for one owner's several domains. | Fits clients that the operator runs or blesses, not strangers. |
| Apple associated domains, Android Digital Asset Links | Let a native app use a domain's passkeys when the domain lists the app. | The same: an operator's own apps. |

## OAuth for open protocols

Protocols whose clients and servers do not know each other, and that use
OAuth 2.1 itself. [PLAN_OAUTH.md](PLAN_OAUTH.md) aligns with these.

| system | what it does | lesson for us |
|---|---|---|
| IETF, OAuth profile for open public clients (`draft-ietf-mailmaint-oauth-public`, revision 06, September 2026) | OAuth for IMAP, SMTP, POP, JMAP, CalDAV, and CardDAV, where "the only interoperable way" today is a password. Native public clients only; open dynamic registration with metadata marked unverified; authorization code with PKCE and `iss` checks; redirects to loopback IP addresses on any port or reverse-domain schemes with a `.`; no embedded web views; resource indicators; registered scopes such as `urn:ietf:params:oauth:scope:mail`; refresh rotation. Non-HTTP protocols carry bearer tokens over SASL OAUTHBEARER, and a failed attempt returns the `openid-configuration` URL. | The closest match: an open protocol, mostly not HTTP, with strangers on both sides. Our earlier redirect rules matched it independently. |
| MCP authorization (2025-11-25) | MCP servers are resource servers and publish protected resource metadata (RFC 9728). Clients register by, in order: a pre-registered ID, a client ID metadata document, dynamic registration, or asking the user. PKCE is required, and clients refuse to sign in when the metadata does not list `S256`. Clients send `resource` (RFC 8707) in every request, and servers accept only tokens issued for themselves, and never pass a token on. | The client-registration order, the `resource` rules, and the token checks, already proven at scale. MCP leaves non-HTTP transports to "established security best practices". |
| OAuth Client ID Metadata Document (`draft-ietf-oauth-client-id-metadata-document`) | A client's `client_id` is the `https` URL of a JSON document with its metadata, so no registration is needed. An OAuth working group document since October 2025, revised in March 2026; supported by Pocket ID, MCP, and AT Protocol. | The way for an unknown client to identify itself. Its own security section notes that a loopback redirect lets any app claim any client's metadata. |
| Cloudflare `workers-oauth-provider` 1.x | An OAuth 2.1 authorization server library for Workers: PKCE, opt-in client ID metadata documents, dynamic registration, issuer identification, tokens bound to a list of resources, and step-up authorization. The authorization server and the resource server can be separate Workers. | What server.apron.chat would use to become its own authorization server. |
| SASL OAUTHBEARER (RFC 7628) | Carries an OAuth bearer token in a non-HTTP protocol's authentication step, with the host and port, and returns discovery information when it fails. | The model for presenting a token in Apron's `auth`. |

## Takeaways

- Matrix is the nearest case, and it went from Plan 1's shape to Plan 2's:
  OAuth with PKCE, client registration, and a device grant. That shows the
  endpoint works, and how much it costs.
- Plan 3's binding is proven by Discord, Telegram, WhatsApp, and Tailscale,
  but only between a service and its own apps. Applying it to third-party
  clients over an open protocol is new.
- AT Protocol's rule, a scheme that is the reverse of a domain the client
  proves it owns, would strengthen the endgame plan's app schemes.
- Codes to paste are an accepted fallback (Mastodon, `gcloud`), and binding
  them to a connection answers the phishing problem that made Google retire
  its version.
- Persona is the warning for a neutral provider: per-server authentication,
  as Matrix and Pocket ID deployments do, avoids it.
- The IETF's open-clients profile for mail is the closest prior art to
  Apron, and MCP the most widely deployed. Both use OAuth 2.1 itself, with
  PKCE, resource indicators, and registration without coordination.

## Sources

- Synapse SSO handling and client whitelist: [sso.py](https://git.sudo.is/matrix/synapse/src/branch/develop/synapse/handlers/sso.py), [PR 13844](https://github.com/matrix-org/synapse/pull/13844); short-lived login token: [MSC2608](https://github.com/matrix-org/matrix-spec-proposals/pull/2608)
- Matrix next-generation auth: [Better auth](https://matrix.org/blog/2023/09/better-auth/), [Matrix Authentication Service](https://matrix.org/blog/2025/04/matrix-auth-service/), [matrix.org running MAS](https://matrix.org/blog/2025/04/morg-now-running-mas/), [MAS authorization docs](https://matrix-org.github.io/matrix-authentication-service/topics/authorization.html), [MSC4108](https://github.blesdmm.dns-dynamic.net/matrix-org/matrix-spec-proposals/blob/element-hq/oidc-qr-login/proposals/4108-oidc-qr-login.md)
- AT Protocol OAuth: [spec](https://atproto.com/specs/auth), [developer guide](https://atproto.com/guides/oauth), [client guide](https://docs.bsky.app/docs/advanced-guides/oauth-client), [notes on clients and metadata](https://desertthunder.github.io/garden/engineering/atproto/oauth/clients/)
- Mastodon OAuth: [OAuth spec](https://docs.joinmastodon.org/spec/oauth), [OAuth methods](https://docs.joinmastodon.org/methods/oauth), [apps](https://docs.joinmastodon.org/methods/apps), [standards discussion](https://activitypub.space/topic/68/oauth-2.0-standards-support-in-mastodon)
- Discord remote auth: [userdoccers](https://discord-userdoccers-114.pages.dev/remote-authentication/desktop), [discord_remote_auth](https://www.github.com/teaishealthy/discord_remote_auth), [QR-login scams](https://discord-antiscam.github.io/scam-docs/scams/qr-code-logging)
