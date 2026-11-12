# Sign-in scenarios to cover

Scenarios that protocol v10 and today's deployments (server.apron.chat,
web.apron.chat) do not handle smoothly. Letters refer to
[OPTIONS.md](OPTIONS.md). "Server work" means the protocol already covers the
scenario, and only an implementation is missing.

## Scenarios

1. **Native app on macOS, existing passkey.** Ada made her account on
   web.apron.chat with a passkey. She installs SideTable on her Mac and signs
   in to server.apron.chat with the same passkey, without pasting a token.
   Needs: server work (E: an `external` passkey page on server.apron.chat).

2. **Native app without a sign-in session.** Ada uses a Linux client that
   opens the system browser for sign-in, and the token comes back through
   `apron:`. Needs: protocol change 1 (G: PKCE, and `apron:` return URLs).

3. **Two Apron apps on one device.** Ada has SideTable and another Apron app
   installed, and both claim `apron:`. She signs in with the other app, and
   SideTable must not be able to use the token if it receives it. Needs:
   protocol change 1 (G).

4. **Web frontend that the operator does not know.** Bob hosts apron-web at
   foo.example.com. Ada opens it, connects to server.apron.chat, and signs in
   with her passkey in a popup, without the operator adding foo.example.com to
   a list. Needs: protocol change 2 (H: `return_origin`). Today: only a code to
   type (D), after server work.

5. **Terminal client.** Ada runs an Apron terminal client over SSH. She signs
   in with her passkey in a browser on her phone, and types the code it shows.
   Needs: server work (D).

6. **Server behind Pocket ID.** Carol runs chat.carol.dev, which signs users in
   only through her Pocket ID. Ada signs in from web.apron.chat and from
   SideTable, and both show "Sign in with Pocket ID". Needs: server work (F)
   and protocol change 4 (J: the label).

7. **Server without its own sign-in page.** Dan runs a small server and does
   not want to build a passkey page. His server uses the page that
   web.apron.chat hosts, and still checks the passkeys itself. Needs: protocol
   change 3 (I: `ext:handoff` page methods).

8. **Declined sign-in.** Ada starts a sign-in in SideTable, then taps "Don't
   allow" on the page. SideTable shows "Sign-in declined" and does not keep
   waiting. Needs: `error=access_denied` in the redirect, part of protocol
   changes 1 and 2.

## Must stay safe

Each change must keep these. Most already hold; the notes say where one
needs a new rule or server work.

- **Mailed link.** Mallory makes a proposal and sends Ada its page link. Ada
  signs in on the page, and Mallory does not get her account.
- **Wrong recipient.** A token meant for SideTable reaches another app or
  site, which cannot sign in with it.
- **Relaying server.** A server that Ada reaches through web.apron.chat
  cannot use her server.apron.chat passkey to sign in there as her (the §4.10
  RP ID check, in v10).
- **Signed in as someone else.** Mallory gets SideTable to accept a token for
  Mallory's account, so that Ada's messages go to an account that Mallory
  reads. Guarded by `state`, which the client checks against its own
  proposal. A leaked proposal ID is the gap: Mallory could approve Ada's
  proposal with her own account. Guarded by the ID being secret, single use,
  and short lived, and by the client showing who it signed in as.
- **Replayed or guessed token.** Someone uses a token twice, or guesses a
  short code. Guarded by tokens being single use and expiring within
  minutes, short codes working only on the proposing connection, and a few
  failed attempts cancelling the proposal (§4.11.1).
- **Open redirect.** Mallory proposes with `return_url: https://evil.example/`
  on the server's page. Guarded by the server accepting only `https` origins
  that it trusts, and, with change 2, a `return_origin` that equals the
  proposing connection's `Origin`.
- **Framed confirmation page.** evil.example loads the sign-in page in a
  hidden frame and tricks Ada into clicking "Allow". Guarded by the page
  refusing to be framed (`Content-Security-Policy: frame-ancestors 'none'`).
  Every sign-in page needs this, and no rule says so today.
- **Forged popup message.** With change 2, another window posts a fake
  result to foo.example.com, to sign it in to Mallory's account. Guarded by
  the client accepting only a message from the popup that it opened, from the
  page's origin, with its own `state`.
- **Mix-up between servers.** SideTable talks to server.apron.chat and to
  Mallory's server, and redeems a token from one at the other. Not guarded
  today: §4.11.2 tells clients to ignore `server` (REVIEW.md, problem 1). The
  fix is for the client to check `server` against the server that it
  proposed to; with OAuth, `iss` and `resource` (PLAN_OAUTH.md).
- **A client turns out bad.** Ada signs in to foo.example.com, which later
  misuses her token. A client that Ada chose holds a full token by design, so
  the guard is that she can see and revoke it: the long-lived token names its
  client (its `agent` or origin), and `/invite-device list` shows it.
- **Removed user keeps access.** Carol removes Ada from Pocket ID, and Ada's
  Apron tokens keep working. Guarded by the server revoking her tokens on
  Pocket ID's backchannel logout, or by re-checking her with the provider.
  This is server work in option F, not a protocol rule.
