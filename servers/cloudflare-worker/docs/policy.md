# Public demo authentication and policy

The demo speaks Apron protocol **2**, advertising `history` and `edit`. History
availability uses the base protocol's `latest_log_id` and nullable
`history_log_id`, without extension negotiation. See
[history and recovery](../../../PROTOCOL.md#51-history) and the
[retention implementation specification](../SPEC.md#9-rolling-history-and-base-protocol-availability).

WebAuthn uses the canonical [optional authentication scheme](../../../PROTOCOL.md#appendix-c--webauthn-authentication-optional),
advertised through `auth: ["webauthn", "anonymous"]`. Server announcements are
complete replacements.

The implementation follows the current repository protocol. Relative to the
specification's reference blob `d24de5ec177d0c042d7237a7783ccdc8bffec3d5`, it also
supports same-room reply references (including references across threads) and
editing existing thread titles/summaries. Reply targets must exist when a save
is accepted; subsequent expiration does not invalidate the reply snapshot.

## Authentication policy

An authenticated guest may begin registration while retaining guest rights.
A new credential creates a separate registered identity; it does not transfer
ownership of guest messages. A registered identity must reconnect before
switching identities.

The canonical begin/finish exchange, JSON credential encoding, and verification
rules are defined in protocol Appendix C. This demo limits challenges to 120
seconds and requires user presence and verification. A new begin replaces the
pending challenge without extending the initial 30-second authentication
deadline. A matching finish attempt consumes the challenge even on failure.
The demo issues no bearer token: each new connection authenticates again.
Signing out drops the connection and returns as a fresh guest.

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
