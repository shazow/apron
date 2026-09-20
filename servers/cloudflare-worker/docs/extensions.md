# Public demo authentication and policy

The demo speaks Apron protocol **2**, advertising `history` and `edit`. History
availability uses the base protocol's `latest_log_id` and nullable
`history_log_id`, without extension negotiation. See
[history and recovery](../../../PROTOCOL.md#51-history) and the
[retention implementation specification](../SPEC.md#9-rolling-history-and-base-protocol-availability).

The separate authentication adapter is advertised as
`extensions: ["webauthn.demo.v1"]`. Server announcements are complete replacements.

The implementation follows the current repository protocol. Relative to the
specification's reference blob `d24de5ec177d0c042d7237a7783ccdc8bffec3d5`, it also
supports same-room reply references (including references across threads) and
editing existing thread titles/summaries. Reply targets must exist when a save
is accepted; subsequent expiration does not invalidate the reply snapshot.

## `webauthn.demo.v1`

WebAuthn uses two `auth` requests, each with a request ID. An authenticated guest
may begin an upgrade while retaining guest rights. A registered identity cannot
switch identities without reconnecting. A new credential creates a new identity:
it does **not** transfer ownership of messages from the guest identity.

```json
{"method":"auth","id":"a1","params":{"scheme":"webauthn","action":"register","step":"begin"}}
{"id":"a1","result":{"challenge_id":"opaque","public_key":{"challenge":"base64url","rp":{"id":"chat.example","name":"Apron demo"},"user":{"id":"base64url","name":"generated","displayName":"generated"},"pubKeyCredParams":[{"type":"public-key","alg":-7}],"authenticatorSelection":{"residentKey":"required","userVerification":"required"},"attestation":"none"}}}
{"method":"auth","id":"a2","params":{"scheme":"webauthn","action":"register","step":"finish","challenge_id":"opaque","credential":{"id":"base64url","rawId":"base64url","type":"public-key","response":{"clientDataJSON":"base64url","attestationObject":"base64url"},"clientExtensionResults":{}}}}
```

These credential fields illustrate the serialized browser response; an empty
or fabricated credential is never authentication. Binary browser fields use
unpadded base64url. The client converts creation/request options to browser
WebAuthn types and serializes the resulting credential for verification.

Login uses `action: "login"` in both steps and discoverable credentials (no
credential directory is sent). A login response includes authenticator data,
signature, client data, and user handle when supplied by the authenticator.
Only a verified finish returns `result.you`, followed by the room announcement
and all thread metadata. Begin does not establish authenticated live delivery.

One challenge per connection lasts at most 120 seconds and is consumed by a
finish attempt. It binds connection, action, RP ID, and exact browser origin.
Beginning again replaces it; it never extends the initial 30-second anonymous
authentication deadline. User presence and verification are required. There is
no bearer session/resume extension: each new connection authenticates again.

Anonymous identities last for a socket, including hibernation. Repeated anonymous
authentication on that socket preserves the identity. Reconnecting creates a
new guest identity, so guest ownership and deduplication cannot span reconnects.
Registered identities remain stable after verified login. Successful mutations
with IDs are deduplicated per identity for 24 hours; clients must not retry
older operations indefinitely. Matching retries do not consume posting quota,
but do consume frame and lookup resources.

## Demo policy metadata

`server.params.demo` describes retention and selected payload/posting policies.
The demo's 16 KiB frame policy is an explicit exception to the base protocol's
advisory 256 KiB recommendation. Payload lengths count UTF-8 bytes. Errors use
the base protocol codes; `retry_after` includes an integer `data.ms`. Permanent
identity/thread ceilings return `denied`, not a fabricated replenishment time.

Anonymous posting allowances are shared across a normalized IP; native IPv6
addresses share a /64 bucket. Registered users also share the aggregate IP
limit. NAT users can therefore limit one another. Passkeys do not provide
one-person-one-account or prevent Sybil attacks.
