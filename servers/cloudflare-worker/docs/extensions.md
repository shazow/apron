# Public demo extensions (version 1)

The demo speaks Apron protocol **2**, advertising `history` and `edit`, plus
`extensions: ["history_floor.v1", "webauthn.demo.v1"]`. These extension names
are not capabilities. Server announcements are complete replacements.

The implementation follows the current repository protocol. Relative to the
specification's reference blob `d24de5ec177d0c042d7237a7783ccdc8bffec3d5`, it also
supports same-room reply references (including references across threads) and
editing existing thread titles/summaries. Reply targets must exist when a save
is accepted; subsequent expiration does not invalidate the reply snapshot.

## `history_floor.v1`

This extension explicitly restricts the base protocol's history completeness
and recovery guarantees to the **retained interval**. The permanent room ID is
`general`. Its historical committed `latest_id` never resets when history
expires. Every room announcement and successful history response includes a
positive decimal-string `history_floor`, initially `"1"`.

For floor F, all transitions below F are logically unavailable. F is a monotonic
coverage boundary, not a timestamp, an existing entry, or a recovery checkpoint.
An unused room has head `"0"` and F `"1"`. After all history expires, F may be
head + 1 while head remains nonzero. Newly allocated IDs are at least F.

```json
{"method":"room","params":{"room_id":"general","name":"General","latest_id":"1790000001000","history_floor":"1789913600001"}}
{"id":"h1","result":{"entries":[],"more":false,"history_floor":"1789913600001"}}
```

History uses the base protocol's inclusive numeric bounds and directional
selection. It queries only the intersection with the retained interval.
Entirely expired ranges return empty successful pages carrying F; they do not
invent first/last IDs. Resource rejection is an error, never an empty history
page. Each page captures entries and floor together. Thread history includes
transitions both into and out of the selected thread.

Expiration is based on nondecreasing internal **transition commit time**, not
message creation ID. Every transition contains a complete snapshot. A recent
edit or tombstone can keep an older message present after its creation
transition expires. Logical floor advancement precedes physical deletion; a
cleanup interruption cannot expose logically expired data.

Clients retain the greatest observed F, evicting snapshots by their greatest
applied **log ID**, not their message ID. A checkpoint C permits recovery only
if C + 1 >= F. Otherwise clear that scope's recovered state and rebuild from F.
C = F - 1 is a valid exact boundary. Room and thread checkpoints are separate;
a filtered page cannot establish room coverage.

Recovery fixes head H when live delivery begins, pages forward through H, then
drains buffered entries above H. Metadata re-announcements do not advance
checkpoints or silently replace H. Before applying a page, inspect its floor:
if it overtakes the next unprocessed position, discard the partial recovery and
restart with a fresh boundary. Ignore obsolete asynchronous requests using a
local generation. An increase within processed coverage only requires eviction.
Never apply an older snapshot over a newer one or resurrect entries below F.
Buffers are bounded to 1 MiB or 1,000 entries; overflow reconnects with backoff.

Healthy cleanup normally retains roughly 24–25 hours. Resource exhaustion may
delay cleanup. This is not a secure-erasure guarantee or a promise concerning
provider backups or client copies. Older clients can read available history,
but cannot claim retention-aware correctness and may keep expired cached data.

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
