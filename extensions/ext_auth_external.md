# `ext:auth_external`

Lists the ways that a server's external sign-in
([§4.12](../PROTOCOL.md#412-external-sign-in)) can go, such as "GitHub" and
"Google", and lets a client send the user's choice with the begin.

```jsonc
// <- the server offers three ways
{
  "method": "server", "params": {
    "apron": 10, "auth": ["external", "token"],
    "labels": {"external": "Acme login"},
    "capabilities": ["ext:auth_external"],
    "ext": {"auth_external": {"options": [
      {"id": "sso", "label": "Acme SSO"},
      {"id": "github", "label": "GitHub"},
      {"id": "google", "label": "Google"}
    ]}}
  }
}
// -> the user chose GitHub
{"method": "auth", "id": "c1", "params": {"scheme": "external", "ext": {"auth_external": {"prefer": "github"}}}}
// <- the choice is in url's query, which clients keep (§4.12.1)
{"id": "c1", "result": {"external": {"url": "https://chat.example/oauth/authorize?provider=github"}}}
```

```ts
class AuthExternal {            // server.ext.auth_external
  options: Option[];            // two or more, in the server's order
}

class Option {
  id: string;                   // opaque, at most 64 bytes
  label: string;                // a label (§3.2), such as "GitHub"
}

class AuthExternalBegin {       // auth params.ext.auth_external, on an external begin
  prefer?: string;              // the id of the option that the user chose
}
```

- The server sends `options` only when it offers two or more ways.
- A server with one way gives that way a label in `labels.external`
  ([§3.2](../PROTOCOL.md#32-authentication)), and does not send `options`.
- Clients show one choice for each option, in order, instead of the one
  `external` choice.
- Clients MAY show `labels.external` as a heading for the options.
- A begin with `prefer` returns `external` for the chosen way
  ([§4.12.1](../PROTOCOL.md#4121-begin)).
- A choice changes only `url`, and `issuer` for another authorization server.
- A server that does not know the `id` in `prefer` answers the begin as if
  `prefer` were absent.
- A begin without `prefer` leads to the sign-in that `labels.external` refers
  to, such as a page that lists the ways.
- Without the extension, clients show one `external` choice, with its label,
  and begin without `ext`.
