# `ext:handoff` or a neutral auth.apron.chat

Status: comparison, for deciding what to build first. The decision since:
[PLAN_OAUTH.md](PLAN_OAUTH.md), where each server has its own authorization
server (its own, or one such as Pocket ID), and no shared auth.apron.chat.
Companion to
[EXT_HANDOFF.md](EXT_HANDOFF.md).

## Question

Is `ext:handoff` about as much work as a neutral sign-in service at
auth.apron.chat, which servers choose to trust? If so, the neutral service
might be the better thing to build, since it could also bridge other sign-ins
(atproto OAuth, Google, GitHub).

## Short answer

No. For the first goal, SideTable signing in to server.apron.chat with the
user's existing passkey, `ext:handoff` is clearly less work:

- No new service, no new database, no signing keys.
- The passkeys that users already have keep working. A neutral service
  cannot use them, so every user would register a new passkey there and link
  it to their account.
- The neutral service needs everything in part 1 of `ext:handoff` anyway,
  because the server still hands the client a token, and the client still
  redeems it.

The neutral service replaces only part 2 (the page methods and the
web.apron.chat route), and it replaces them with more: an OpenID Connect
(OIDC) client in each server, account linking, and the service itself. It
pays off later, when many independent servers want one shared sign-in, or
when you want to bridge other identity providers. It can then sit behind the
same part 1.

## The designs

**H: `ext:handoff`.** The server's `external` page is web.apron.chat. The
page signs in to the server with the user's passkey, over an ordinary Apron
connection, and approves the client's proposal with the page methods. The
server checks the passkey itself. See EXT_HANDOFF.md.

**N: a neutral auth.apron.chat.** auth.apron.chat is an identity provider.
Users sign in there, with a passkey or another provider, and it vouches for
them to servers that trust it, with a signed token (an OIDC ID token). Each
server maps the provider's user to a local account. Two ways to wire it:

- **N1, server in the middle.** The server's `external` page is
  auth.apron.chat's sign-in page. After the user signs in, auth.apron.chat
  redirects to a callback on the server, the server exchanges the code for an
  ID token, and then redirects to the client with a temporary token, as in
  part 1. This is the usual "Sign in with X" pattern.
- **N2, client in the middle.** The client signs in at auth.apron.chat
  itself, with a standard OAuth library, and gets an ID token for the server.
  It presents the ID token in `auth`, and the server checks it. No proposals
  on the server.

## What each design needs

| piece | H: handoff | N1: server in the middle | N2: client in the middle |
|---|---|---|---|
| New service to run | none | auth.apron.chat | auth.apron.chat |
| Its passkeys, users, sign-in page, consent screen | none (web.apron.chat route, reusing its passkey code) | new | new |
| Its signing keys, rotation, and public key endpoint (JWKS) | none | new | new |
| Server: proposals, `return_url` rules, PKCE, temporary token, redeeming it (part 1) | new | new (same) | none |
| Server: page methods and origin check (part 2) | new, small | none | none |
| Server: OIDC client (callback, code exchange, token checks, key fetching) | none | new | token checks and key fetching only |
| Server: map the provider's users to accounts, and a linking flow | none | new | new |
| Server: rules for new accounts from the provider | none | new | new |
| Client (SideTable) | part 1: propose, browser session, redeem | same as H | an OAuth client against auth.apron.chat, then a new `auth` form |
| PROTOCOL.md or extension text | part 1 fields; part 2 methods | part 1 fields; a list of providers in the `server` frame | a new scheme or token form for ID tokens; a list of providers |
| Existing passkeys | keep working | users register again and link | users register again and link |

N2 has the least server work of the three if you count only the server:
checking a signed token is small, and there are no proposals. But it moves
the work into a new service and into every client, it needs a new `auth`
form on the wire, and it still needs account linking and a passkey
migration.

## Existing passkeys

Today's passkeys belong to RP ID `apron.chat`, and their public keys are in
server.apron.chat's storage. auth.apron.chat is under `apron.chat`, so the
browser would offer those passkeys on its page, but auth.apron.chat cannot
check them: it has no public keys. A neutral service that read
server.apron.chat's credential store would not be neutral.

So with N, each user:

1. signs in to server.apron.chat as today, on web.apron.chat.
2. registers a new passkey at auth.apron.chat.
3. links that identity to their server account, through a new linking flow.

Until they do, SideTable cannot sign them in. With H, nothing changes for
them.

## Trust, privacy, and availability

| | H | N |
|---|---|---|
| Who checks the passkey | the server | auth.apron.chat |
| Who can mint sign-ins for a server's users | the server | the server, and every provider it trusts |
| Who sees each sign-in | the server | the server and auth.apron.chat |
| Linking a user across servers | no shared identity | one identity across every trusting server, unless the provider gives each server a different user ID |
| If it is down | sign-in for native clients through web.apron.chat stops; the server's own page or `/invite-device` still work | sign-in through it stops on every server that trusts it |
| Abuse | the server's own sign-up rules | a public sign-up service, with its own spam and abuse handling |

This is vrypan's objection in table form: with N, a server trusts someone
else to vouch for its users.

## What N gives you that H does not

- One sign-in across many independent servers, which a user sets up once.
- A place to bridge other identity providers (atproto OAuth, Google, GitHub)
  once, for every server that trusts it.
- Standard OIDC on the client side (N2), so native clients can use an
  off-the-shelf library.

H gives a server none of these. A server that wants them today can already
put any of them behind its own `external` page, which §4.11 allows.

## Recommendation

1. Build H now: part 1 in server.apron.chat and SideTable, part 2 in
   server.apron.chat and a web.apron.chat route. It is the smallest change
   that reuses what exists, and it changes nothing for current users.
2. Treat part 1 as the lasting interface. It is the same in H and N1, and
   it is a candidate for §4.11.
3. Build N later only if a second independent server wants shared sign-in,
   or if bridging another identity provider becomes a goal. Add it as N1:
   the server's `external` page points at auth.apron.chat, the server becomes
   an OIDC client, and clients change nothing.

Part 2 is the only piece that N1 replaces, and it is the smallest piece of
H, so building H first wastes little.

## Open questions

- If N comes later, should it give each server a different user ID, so that
  servers cannot link one user across servers?
- Would auth.apron.chat take sign-ups from anyone, or only from users of the
  servers that trust it?
- With N, what happens to a server's accounts if the provider shuts down or
  loses its keys?
