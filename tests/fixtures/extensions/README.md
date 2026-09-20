# Protocol extension fixtures

This directory contains the separate `webauthn.demo.v1` fixture used by the
public Cloudflare demo. It contains wire shapes that a client or server
adapter can replay without a browser or a live Durable Object. History
availability is part of the base protocol and is covered by
`tests/fixtures/history.json`; it is not negotiated through the server
announcement's `extensions` field.

The WebAuthn fixture uses deliberately synthetic credential bytes. It checks
request/response shape and option-field conversion only; cryptographic
verification belongs to the server's WebAuthn implementation and its own
authenticator tests.
