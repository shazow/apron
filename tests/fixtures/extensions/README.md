# Protocol extension fixtures

These versioned fixtures describe the additive extensions used by the public
Cloudflare demo. They contain wire shapes and boundary cases that a client or
server adapter can replay without a browser or a live Durable Object. The
base protocol remains version 2; `history_floor.v1` and `webauthn.demo.v1` are
negotiated through the server announcement's `extensions` field.

The WebAuthn fixture uses deliberately synthetic credential bytes. It checks
request/response shape and option-field conversion only; cryptographic
verification belongs to the server's WebAuthn implementation and its own
authenticator tests.
