# Passkeys in native apps

**Can a native app, such as one for macOS, iOS, Android, or Linux, sign in
with a server's passkeys?** Yes. An app that the RP ID's domain trusts runs
the ceremony itself. Any other app signs in on the server's passkey page, if
the server offers one, and gets a code back
([§4.10.1](../PROTOCOL.md#4101-passkey-page)).

## How it works

1. **The app checks whether the RP ID's domain trusts it.** A platform lets an
   app use passkeys for a domain only when the domain lists the app. In
   practice, that app is the server operator's own app.
   - Apple: Associated Domains (`webcredentials:`).
   - Android: Digital Asset Links (`assetlinks.json`).
   - Linux and other desktops without a platform passkey API: no app is
     trusted. Don't talk to a security key directly, such as with libfido2.
     An app that does can claim any RP ID and origin, so passkeys lose their
     phishing protection.
2. **A trusted app runs the ceremony** with `public_key`, after it checks that
   the RP ID belongs to the server
   ([§4.10](../PROTOCOL.md#410-webauthn-authentication)). The app connects with
   an `Origin` header: the origin that its platform writes in the credential's
   client data. Without that header, the server can leave out `public_key`.
   The server accepts the finish's `token` only on a connection with the same
   `Origin`. So the app sends that header on each later connection that signs
   in with the token. If the begin result has `external` and no `public_key`,
   or the platform refuses the RP ID, the app continues at step 3
   ([§4.10.1](../PROTOCOL.md#4101-passkey-page)). A cancel by the user is not a
   refusal, so the app doesn't start step 3 by itself. After a login that ends
   without a credential, though, it can offer step 3 if the begin result has
   `external`: the page may find a passkey that the platform could not, such
   as one for an RP ID that the server used before.
   - Apple: `ASAuthorizationPlatformPublicKeyCredentialProvider`. A cancel is
     `ASAuthorizationError.canceled`. The origin is `https://` plus the RP ID,
     such as `https://chat.example`. The result has no JSON form, so the app
     builds `credential` as `toJSON()` would return it.
   - Android: Credential Manager (`androidx.credentials`). The origin is
     `android:apk-key-hash:` plus the base64url SHA-256 hash of the app's
     signing certificate, such as `android:apk-key-hash:sYUC8p5I…`. Credential
     Manager takes `public_key` as JSON, so the app removes `prf` and
     `largeBlob` from it first.
3. **Any other app chooses a `redirect_uri`.** The page asks the user to allow
   an `https` `redirect_uri` once for their account, and any other
   `redirect_uri` at each sign-in
   ([§4.12.3](../PROTOCOL.md#4123-authorization-server)).
   - Apple: an `https` address on a domain that lists the app (from iOS 17.4
     and macOS 14.4), or else a scheme with a `.`, such as
     `com.example.app:/signed-in`.
   - Android: an `https` App Link, or else a scheme with a `.`.
   - Linux and other desktops: a loopback address, such as
     `http://127.0.0.1:53682/signed-in`. The app listens there until the code
     arrives. An app without a browser on the same machine uses `token` or
     `email` instead.
4. **The app sends a `client_id` of its own,** such as its app ID
   ([§4.12.2](../PROTOCOL.md#4122-signing-in)). If the app has a client ID
   metadata document that lists its `redirect_uri`, the app sends the
   document's `https` URL instead.
5. **The app opens `external.url`** in a sign-in session or the system
   browser, never in an embedded web view
   ([§4.12.2](../PROTOCOL.md#4122-signing-in)). The app adds its authorization
   parameters to any query in `url` ([§4.12.1](../PROTOCOL.md#4121-begin)). It
   keeps that query exactly as the server sent it. Decoding the query and
   encoding it again can change it: a `+` that stands for a space can become
   `%2B`, which stands for a plus sign.
   - Apple: `ASWebAuthenticationSession`.
   - Android: an Auth Tab (`AuthTabIntent`), or else a Custom Tab.
   - Linux and other desktops: the system browser, such as with `xdg-open`.
6. **The app finishes `webauthn`** after it checks that `state` is its own
   ([§4.12.2](../PROTOCOL.md#4122-signing-in)). The finish carries the action
   of the begin, `code`, `code_verifier`, `redirect_uri`, and `client_id`
   ([§4.10.1](../PROTOCOL.md#4101-passkey-page)). A server can close the
   begin's connection while the user is on the page, because that connection
   has not signed in. So the app finishes on a new connection, unless the code
   is for an addition (step 7). If the result has a bearer `token`, the app
   keeps it in the platform's secure storage. The app signs in with it on later
   connections ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)).
   - Apple: the Keychain.
   - Android: encrypted with an Android Keystore key.
   - Linux and other desktops: a secret store, such as Secret Service.
7. **An app that creates accounts** begins `register` instead of `login`. A
   server that lists `webauthn` in `signup` creates the account from the
   registration ([§3.2](../PROTOCOL.md#32-authentication)). On a server that
   lists `guest` but not `webauthn` in `signup`, the app signs in as a guest
   first. The passkey is then an addition to the guest's account
   ([§4.10](../PROTOCOL.md#410-webauthn-authentication)). On the passkey page,
   the code of an addition finishes only on a connection that is signed in to
   that account ([§4.10.1](../PROTOCOL.md#4101-passkey-page)). So the app
   finishes on the begin's connection, which it keeps open and keeps pinging
   ([§1](../PROTOCOL.md#1-transport--framing)). If the guest sign-in returned a
   `token`, the app can instead finish on a new connection that signs in with
   it.

## Servers

A server can help native apps in these ways:

- The server lists its operator's apps on the RP ID's domain:
  `webcredentials` in `apple-app-site-association`, and
  `delegate_permission/common.get_login_creds` in `assetlinks.json`.
- The server allows each listed app's origin (step 2) as a ceremony's origin,
  and as a connection's `Origin`.
- The server puts `external` in every begin result, also next to `public_key`
  ([§4.10.1](../PROTOCOL.md#4101-passkey-page)). An app whose platform refuses
  the RP ID then still has a way to sign in.
- The server does not tie the passkey page to the begin's connection. The page
  and its code then still work after that connection closes. The server can
  then close a connection that does not sign in soon.
- The server writes spaces in the query of `external.url` as `%20`, not `+`.
  Some clients decode the query and encode it again (step 5).
- The server lists `webauthn` in `signup` only if a registration on a new
  connection creates an account. A server that takes a registration only on a
  signed-in connection, such as a guest's, says so when it refuses one.
- The server puts the value that it refused in the refusal's `message`, such
  as an origin that it does not allow.

## Limits

- **A prompt before the page.** `ASWebAuthenticationSession` asks the user
  whether the app may sign in with the server's domain. An ephemeral session
  (`prefersEphemeralWebBrowserSession`) does not ask, but it shares no cookies
  with the browser.
- **Android origins in `Origin`.** An origin such as `android:apk-key-hash:…`
  is not a web origin. Some WebSocket libraries and proxies refuse it in an
  `Origin` header, unless the server allows it.
- **Passkey autofill.** In a sign-in session, some platform versions offer
  passkeys only from a button, not as autofill. A passkey page can start the
  ceremony from a button instead.
- **Platform details change.** Check each platform's current documentation,
  such as for the error when the domain does not list the app, and for an
  `https` `redirect_uri`.
