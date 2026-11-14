# Plan: a remote passkey page for `webauthn`

Status: proposal, 2026-11-14. Scope: the `webauthn` scheme (§4.10) only.
It reuses the authorization flow of `external` as drafted in PROTOCOL.md
§4.12 on [shazow/apron#115](https://github.com/shazow/apron/pull/115)
([PLAN_LOOSE.md](PLAN_LOOSE.md)), but needs no `external` scheme.

## Problem

A user opens a client, sees "Sign in with a passkey", and presses it. If
the client cannot use the server's RP ID, nothing happens:

- A passkey works only on its RP ID's domain, on origins that the domain
  lists as related, and in apps that the domain vouches for (Apple's
  associated domains, Android's asset links). Only the domain's operator
  can add a client to those lists.
- So third-party web clients on other domains, third-party native apps,
  and terminal clients cannot run the ceremony.
- Sending them to `external` instead is no substitute. The portal behind
  it may offer other methods, or no passkey at all. The user asked for a
  passkey.

A client cannot always tell in advance. It learns the RP ID from begin. A
web client on another domain cannot reliably read whether the browser will
accept it as a related origin; a native Android app cannot read the
domain's asset links. Trying is cheap: a mismatched RP ID fails at once
(`SecurityError`), before any prompt.

## Approach

The `webauthn` begin result keeps `public_key`, for clients that can run
the ceremony themselves, and gains an optional `external`: the same object
as §4.12.1's begin result, pointing at a **passkey page** on the server's
own domain. A client that cannot use the RP ID opens that page, the user
signs in there with their passkey, and the page redirects back with a code.
The client finishes the `webauthn` exchange with the code instead of a
credential.

Either way, the user who pressed "passkey" gets a passkey prompt: in the
client, or after one trip to the browser.

## Wire

```ts
class AuthResult {              // §3.2, besides its other fields
  // "webauthn" scheme, begin step
  challenge_id?: string;
  public_key?: object;          // WebAuthn options, for a ceremony in the client
  external?: External;          // the passkey page, for a ceremony elsewhere (§4.12.1)
}

class Auth {                    // §3.2: a "webauthn" finish step takes either
  credential?: object;          //   the credential from a ceremony in the client, or
  code?: string;                //   a code from the passkey page,
  code_verifier?: string;       //   with these three, as in §4.12
  redirect_uri?: string;
  client_id?: string;
}
```

### Login

```jsonc
// <- the server need not list "external"
{"method": "server", "params": {"apron": 10, "auth": ["webauthn", "token"]}}

// -> the user pressed "Sign in with a passkey"
{"method": "auth", "id": "a1", "params": {"scheme": "webauthn", "action": "login", "step": "begin"}}
// <-
{"id": "a1", "result": {
  "challenge_id": "ch_1…",
  "public_key": {"rpId": "chat.example", "challenge": "…", "userVerification": "required"},
  "external": {"authorization_endpoint": "https://chat.example/passkey", "params": {"action": "login"}}
}}
```

A client that can use `chat.example` runs the ceremony and sends `finish`
with `credential`, as today. A client that cannot:

```text
1. opens  https://chat.example/passkey?response_type=code&client_id=com.example.myapp
            &redirect_uri=com.example.myapp:/signed-in&code_challenge=E9Mel…&code_challenge_method=S256
            &state=q8Rz…&resource=https://chat.example&action=login
2. the page shows one screen: "Sign in to chat.example from com.example.myapp. [Use passkey]"
   The button is the confirmation, and the click that the browser needs before the passkey prompt.
3. the page redirects to  com.example.myapp:/signed-in?code=Hk41x9…&state=q8Rz…&iss=https://chat.example
4. the client checks state and iss
```

```jsonc
// -> on any connection
{"method": "auth", "id": "a2", "params": {"scheme": "webauthn", "action": "login", "step": "finish",
  "code": "Hk41x9…", "code_verifier": "dBjftJ…",
  "redirect_uri": "com.example.myapp:/signed-in", "client_id": "com.example.myapp"}}
// <-
{"id": "a2", "result": {"you": {"user_id": "ada", "name": "Ada"}, "token": "st_…"}}
```

### Registering a new account

The same, with `action: "register"`. Begin's `name` (§3.2) travels in
`params`, so the page can label the passkey:

```jsonc
-> {"method": "auth", "id": "a1", "params": {"scheme": "webauthn", "action": "register", "step": "begin", "name": "Ada"}}
<- {"id": "a1", "result": {"challenge_id": "ch_2…", "public_key": {…},
     "external": {"authorization_endpoint": "https://chat.example/passkey", "params": {"action": "register", "name": "Ada"}}}}
```

The page creates the passkey. The server keeps the new credential with the
code, and creates the account when the code is redeemed, by server policy.

### Adding a passkey to an account

On a connection signed in as ada, begin records the account, and `params`
carries an opaque handle to that record. The page needs it to create the
passkey for ada (`user.id`, `user.name`) and to say so.

```jsonc
// -> on a connection signed in as ada
{"method": "auth", "id": "a1", "params": {"scheme": "webauthn", "action": "register", "step": "begin"}}
// <-
{"id": "a1", "result": {"challenge_id": "ch_3…", "public_key": {…},
  "external": {"authorization_endpoint": "https://chat.example/passkey",
               "params": {"action": "register", "request": "rq_7Kp…"}}}}
```

The page shows "Add a passkey to ada’s account on chat.example, from
com.example.myapp. [Create passkey]". The code is redeemable only on a
connection signed in as ada, and the result is `you`, as for a local
addition.

## Rules

Clients:

- Clients use `public_key` when they can use its RP ID, and pass the RP ID
  check of §4.10. Otherwise they use `external`, when present.
- A client MAY try `public_key` first, and go to `external` when the
  platform refuses the RP ID.
- For `external`, clients follow §4.12.2: PKCE `S256`, an unguessable
  `state`, `resource` as the server's origin, `params` as they are, the
  system browser or a sign-in session (a popup or a redirect for web
  clients), and the checks of `state` and `iss`.
- Clients finish with `code`, `code_verifier`, `redirect_uri`, and
  `client_id`, on any connection, with the same `action` as begin.
- Without `external`, a client that cannot use the RP ID tells the user
  that the server's passkeys work only in its own apps and website, and
  shows `server.welcome`.

Servers:

- `external` in a begin result is optional. A server that omits it keeps
  passkey sign-in to clients that can use its RP ID.
- The passkey page is on an origin that the server accepts for its RP ID.
  It acts as an authorization endpoint under §4.12.3, with these additions:
  - It refuses to be shown in a frame.
  - It requires user verification, as §4.10 does.
  - It shows the server, and the host of `redirect_uri` or its scheme,
    and, for an addition, the account. The button that starts the
    ceremony is the confirmation.
  - It redirects with `code`, `state`, and `iss`, or with
    `error=access_denied`.
- A code from the passkey page is bound to the action, to the passkey page
  (a code from another sign-in page does not finish `webauthn`), and, as in
  §4.12.3, to `client_id`, `redirect_uri`, the PKCE challenge, and
  `resource`. It is single use, and expires within minutes.
- A code is redeemable on any connection, except that an addition's code
  works only on a connection signed in to the account in its `request`.
- A `request` handle is unguessable, bound to its account, and expires with
  the codes. Servers keep no other state for the remote path.
- §4.10's binding of a `finish` token to the ceremony's origin applies to
  ceremonies in the client only. A token from a code is a bearer token
  (§3.2.1).
- A mismatched action, a used or expired code, or an addition's code on
  another account's connection is `denied`.

## State

| Path | What the server keeps |
|---|---|
| Ceremony in the client | The pending ceremony on the connection, as today |
| Remote login | The page's own challenge while it is open; then a code, as in §4.12.3 |
| Remote registration, new account | The code, and the new credential until the code is redeemed |
| Remote registration, addition | A `request` handle from begin, bound to the account, besides the code |

Begin still creates the local challenge when the client goes remote; the
next begin or a disconnect drops it (§4.10).

## Security considerations

1. **Who gets a passkey session widens.** In the client, a passkey cannot
   be used by a client on the wrong domain at all. Remotely, any client
   that the user approves on the page gets a session. The passkey still
   protects the sign-in, which runs on the real domain; the page's
   confirmation decides who receives it, as with `external`. A server that
   wants passkey sessions only for first-party clients omits `external`.
2. **Clickjacking.** The page's one button is both consent and the user
   activation for the passkey prompt, so the page refuses framing
   (`frame-ancestors 'none'`).
3. **Origin binding.** A token from a remote ceremony cannot be bound to the
   client's origin, since the ceremony's origin is the page. It relies on
   rotation with reuse detection (§5.2), like other bearer tokens.
4. **Codes that cross over.** Binding the action and the passkey page into
   the code stops a login code from finishing a registration, and a code
   from another sign-in method from finishing `webauthn`.
5. **Adding to the wrong account.** Without the account on the page, someone
   signed in as ada could lead a victim to create a passkey for ada's
   account; the victim would later sign in to ada's account. The `request`
   handle lets the page name the account, and limits the code to ada's
   connection.
6. **A hostile server** can point its begin at another server's passkey
   page. The client sends `resource` for the server that it is connected
   to, which that page refuses (§4.12.2). The RP ID check is not needed on
   this path: the ceremony runs on the real domain.
7. **User verification** is required on the page, as in the client.
8. **Stray passkeys.** A new account's passkey stays in the user's manager
   if the code is never redeemed. It is harmless; the user can delete it.
9. **Abuse.** Begin can create a `request` handle; rate limits apply as for
   begin today.

## Coverage

The `webauthn` row of [EVALUATIONS.md](EVALUATIONS.md#grid), with the remote
page:

| | W1 | W3 | N1 | N3 | T |
|---|---|---|---|---|---|
| before | ✅ | ✗ unless a related origin | ✅ with associated domains | ✗ | ✗ |
| with the passkey page | ✅ in the client | ✅ popup or redirect | ✅ in the client | ✅ sign-in session or Custom Tab | ⚠️ loopback, where a browser runs on the same machine |

Register, log in, and add work in each ✅ cell. Terminals over SSH have no
redirect target; a device grant for the passkey page is an open question.

## Implementation notes

- **server.apron.chat with `workers-oauth-provider`:** the passkey page is
  the authorization handler. It runs the existing WebAuthn checks, then
  calls `completeAuthorization()`, which issues the code and redirects. The
  `webauthn` finish with `code` redeems it through the library.
- **Without an OAuth library:** the page can be a small web client of the
  server itself: it opens a WebSocket, runs `webauthn` begin and finish,
  and approves the pending authorization with one internal HTTP request
  carrying its `token`. That request is private to the server.
- **Clients that already implement `external`** reuse the URL building,
  the redirect handling, and the checks. The new part is choosing local or
  remote, and sending `code` in `finish`.

## Draft for PROTOCOL.md

§3.2: add `external?: External` to the `webauthn` begin result, and `code`,
`code_verifier`, `redirect_uri`, `client_id` to the `webauthn` finish step.

§4.10, after the table of steps:

> - A begin result MAY carry `external`
>   ([§4.12.1](#4121-begin)), a passkey page on an origin that the server
>   accepts for its RP ID.
> - Clients that cannot use the RP ID of `public_key` use `external`, when
>   present, as [§4.12.2](#4122-signing-in) says, and finish with `code`,
>   `code_verifier`, `redirect_uri`, and `client_id` instead of
>   `credential`.
> - The passkey page acts as an authorization endpoint
>   ([§4.12.3](#4123-authorization-server)). It refuses to be shown in a
>   frame, and requires user verification. For an addition, it shows the
>   account.
> - A code from the passkey page finishes only `webauthn`, with the action
>   of its begin. A code for an addition works only on a connection signed
>   in to that account.
> - The token of a finish with `code` is not bound to an origin.

and change "Servers MUST bind such a token to the allowed origin of the
ceremony" to apply to a finish with `credential`.

§5.2:

> - A passkey page lets clients that cannot use the RP ID sign in with a
>   passkey ([§4.10](#410-webauthn-authentication)). The page's
>   confirmation then decides which client receives the session, as for
>   external sign-in. A server that wants passkey sessions only in its own
>   clients offers no passkey page.

## Open questions

1. Should the RP ID also be in the `server` frame, so that clients can
   choose their buttons before begin? It never changes for a server.
2. Should begin take a flag that the client will go remote, so that the
   server skips the local challenge?
3. Should servers be encouraged to offer the passkey page only to clients
   that they recognise, such as by client ID metadata documents on known
   hosts?
4. Terminals over SSH: a device grant for the passkey page, or leave them
   to `token` and `external`?
5. Is `request` the right name for the addition handle, or should it follow
   OAuth's `request_uri` (RFC 9126), which libraries already send?
