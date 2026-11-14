# `ext:auth_external`: choosing how to sign in

Status: proposal for EXTENSIONS.md, not implemented. It builds on §4.12 as
drafted on [shazow/apron#115](https://github.com/shazow/apron/pull/115)
(loose OAuth with a begin request; see [PLAN_LOOSE.md](PLAN_LOOSE.md)). It
replaces the earlier draft, which only labelled a single portal.

Why an extension and not core: a client that does not know it still signs
in. It shows one "Sign in" button, begins without a choice, and gets the
server's default. Core defines the begin request and `params`, so a choice
made through the extension reaches every client.

The section below is written to drop into EXTENSIONS.md.

---

## `ext:auth_external`

Lists the ways that a server's external sign-in can go
([§4.12](PROTOCOL.md#412-external-sign-in)), such as "Pocket ID" and
"GitHub", and lets a client say which one the user chose, or what the user
typed to find their account, when it begins.

```jsonc
// <- the server offers two ways
{
  "method": "server", "params": {
    "apron": 10, "auth": ["external", "token"], "capabilities": ["ext:auth_external"],
    "ext": {"auth_external": {"options": [
      {"id": "pocket", "label": "Pocket ID"},
      {"id": "github", "label": "GitHub"}
    ]}}
  }
}
// -> begin with the user's choice
{"method": "auth", "id": "c1", "params": {"scheme": "external", "ext": {"auth_external": {"prefer": "github"}}}}
// <- the choice shows in params, which every client adds to the URL
{
  "id": "c1", "result": {"external": {
    "authorization_endpoint": "https://chat.example/oauth/authorize",
    "params": {"provider": "github"}
  }}
}
```

```ts
class AuthExternal {            // server.ext.auth_external
  options?: Option[];           // in the server's order
}

class Option {
  id: string;                   // opaque, at most 64 bytes
  label: string;                // plain text, at most 64 characters
}

class AuthExternalBegin {       // auth params.ext.auth_external, on begin
  prefer?: string;              // the id of the option that the user chose
  login_hint?: string;          // what the user typed to find their account
}
```

- The server sends `options` only while `server.auth` lists `external`.
- Each `server` frame replaces the options
  ([§3.1](PROTOCOL.md#31-server-frame)).
- Clients show one choice for each option, in order, with `label` as plain
  text, such as "Sign in with Pocket ID". With one option, they show one
  labelled button.
- `prefer` is the `id` of an option. A server that does not know the `id`
  answers begin as without it.
- `login_hint` is what the user typed to find their account, such as an
  email address or an AT Protocol handle. Clients send it only as the user
  typed it, never guessed or remembered from another server.
- The server MAY use `login_hint` to choose the way, such as a company's own
  sign-in for its email domain, and MAY pass it on in `params`.
- The server answers begin as [§4.12.1](PROTOCOL.md#4121-begin) says. A
  choice changes only the result's fields, such as `params` or
  `authorization_endpoint`.
- Without the extension, clients show one "Sign in" button, and begin without
  `ext`.

Not included, on purpose:

- **No icons.** Every client would load each icon from another origin, which
  leaks readers' addresses, and an icon is the easiest way to imitate a
  sign-in that the server does not use.
- **No per-option details in the `server` frame.** Begin returns them, so a
  server can answer by request.

---

## Scenarios

Each is a way behind the portal; clients see only `external`.

| Option | Begin's result | The portal |
|---|---|---|
| Pocket ID, as the issuer | `issuer: "https://id.example"`, its `authorization_endpoint`, `client_id: "apron"` | Pocket ID itself |
| GitHub, through Keycloak | the Keycloak issuer, and `params: {"kc_idp_hint": "github"}` | Keycloak sends the user straight on to GitHub |
| A company's sign-in, chosen by `login_hint: "ada@corp.example"` | that company's issuer | the company's sign-in |
| Bluesky, with `login_hint: "alice.bsky.social"` | the server's own endpoint, and `params: {"provider": "atproto", "login_hint": "alice.bsky.social"}` | the server's portal, acting as an AT Protocol OAuth client ([PLAN_LOOSE.md](PLAN_LOOSE.md), "Scenarios behind the portal") |
| SIWE | the server's own endpoint, and `params: {"provider": "siwe"}` | the server's portal, which asks the user's wallet to sign |

## Security considerations

- `label` is the server's claim. A server could label its own page
  "Google". That gives it nothing new: the client already trusts the server,
  and the browser shows the real page's domain.
- `login_hint` reaches the server before the user signs in. It is something
  the user typed for this server, so it tells the server no more than the
  sign-in page would.
- A choice cannot weaken the guards of §4.12: clients still send `resource`
  for their own server, and check `iss` against begin's issuer.

## Open questions

1. Should `login_hint` move into core begin later? Its meaning is standard in
   OpenID Connect, and a server that ignores it loses nothing.
2. Should an option carry a kind, such as `"oidc"` or `"wallet"`, so that
   clients can show a field for a handle or an email address before begin?
