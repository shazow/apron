# Apron Chat Protocol

Apron is a simple chat protocol that takes advantage of several trade-offs: A server is authoritative, there is no federation, messages inside a server are not end-to-end encrypted, there is no greater social network.

It should be extremely easy to implement a basic server (~100 lines of code) that works with any client (just a few lines for a stateless bot).

Do you need a custom self-hosted group chat? Consider using the Apron Chat Protocol!

**Status**: Beta, core protocol is stable

<img width="721.5" height="536" alt="Screenshot of the Sveltekit Apron Chat implementation" src="https://github.com/user-attachments/assets/bdd4b15c-485e-4c19-838b-75c748dd2890" />

## Getting Started

1. Read the [PROTOCOL.md](PROTOCOL.md)
2. Try the live demo: [web.apron.chat](https://web.apron.chat/)
3. Explore some implementations:
   - https://github.com/apron-chat/apron-web (frontend for the live demo above)
   - https://github.com/apron-chat/apron-server-cloudflare (demo server running on a Cloudflare Worker free tier with limited functionality, most of the code is keeping usage under the free quota)
   - https://github.com/apron-chat/apron-server-go (more complete reference server for self-hosting)
   - https://github.com/apron-chat/apron-pr-bot (github pull request bot used on the demo server)

## Assumptions & Goals

- Trusted deployments: Small groups where members are mostly known to each other. No sybil resistance, no spam defense, no public federation. Permission policy is whatever the backend decides.
- Backend is authoritative: Identity, membership, history, threading, mutation. The frontend generally acts as a dumb renderer.
- Backends can be trivial: An afternoon or one-shot LLM prompt should implement a working backend provider.
- Any frontend, many backends: Aspiring to have many Apron-compatible chat frontends and backends.
- Encryption is a transport detail: Self-hosters should leverage TLS to secure the connection between the server and clients.
- Incremental capabilities: Partial implementations should be immediately useful. Avoid capability negotiation when possible, but we expect the protocol to be forked and expanded to fit niche use cases..
- One websocket to start, additional signaling bootstrapped from there (e.g. HTTP upload target, WebRTC, etc).
- Multimedia-friendly: Upload images, audio, whatever.

## Tradeoffs

- Instead of using full SASL, we include a few high-impact login primitives that are most useful for self-hosting small group chats: The primary forms are `guest` (anonymous users that may have restricted access) and `token` (hard to guess opaque string that may be rotated). Beyond that we include WebAuthn challenge (Passkeys), and a couple of modified forms of "Token" mode: `email` (server sends a short-duration Token via email) and `external` (allows implementing any other portal like OAuth/OIDC or SASL or others which converts to a `token`). For many self-hosted cases, `guest` and `token` should suffice, which are by far the easiest to implement correctly.
- Instead of minimizing payload sizes through tight packing and avoiding full state updates, we have a fairly readable JSON messages that may include excessive details which make it much easier to implement clients that are immediately useful with every response. For example, messages may include the full user object so that the client doesn't need to pull a lookup table of users before being able to display messages. Because we're targeting small self-hosted servers rather than massive federated rooms with millions of users, this is a reasonable tradeoff.
- Instead of federating across servers and having a composite network of users, Apron is designed for small independent communities with their own trust assumptions. Designing safe and reliable federation and global auth is very sensitive and complex, and many protocols already attempt it to various degrees of compromise, so Apron explicitly excludes this problem from the scope. The downside is that naively a client may need to connect to multiple transports (such as one websocket per server) which can be battery-inefficient past some size. We include a design for websocket multiplexing to help with this, but there may be other opportunities for worthwhile improvements here.
- Instead of tightly coupling specific frontend and client implementations, Apron is designed to be agnostic similar to how Chrome/Firefox/Safari don't care whether the webserver is Nginx/Caddy/Apache or something entirely custom. In some cases this limits the assumptions we can make, or the UX we can offer (such as adjusting the frontend to respect custom permission policies that a specific server implements).

## Specification

- [PROTOCOL.md](PROTOCOL.md): the authoritative Apron Chat Protocol definition.
- [HISTORY.md](HISTORY.md): changes by protocol version.
- [`schema/apron.schema.json`](schema/apron.schema.json): an informative JSON Schema of the frames, for validation and editor completion.
- [`tests/fixtures`](tests/fixtures): conformance fixtures that implementations can test against. The [wire fixture README](tests/fixtures/wire/README.md) describes the wire fixtures, and [DEVELOPMENT.md](DEVELOPMENT.md) says where each fixture runs.

## Background

Apron was designed to address two main frustrations:
- Chat apps are too tightly coupled with their network. (You can't self-host Discord, or use it without connecting to the official Discord network of users).
- It's too hard to implement a basic server that works with any client, or a basic client that works with any server. (Some protocols prioritize one over the other, but I haven't found a good incremental balance for both.)

Apron was inspired by many previous chat protocols and apps:
- I created [ssh.chat](https://ssh.chat) in 2014 which spawned an ecosystem of bots, clients, forks, and bridges to other protocols. It endured many feature requests, attacks, and hundreds of thousands of unique visitors after landing on the HN frontpage 7+ times. 
- Protocols reviewed over the years include IRC (v3 and earlier), Matrix, XMPP, XMTP, and others.
- Functionality and design is inspired by Zulip, Discord, Slack, and others.

AI usage:
- PROTOCOL.md was very carefully hand-edited but also iterated upon with the help of LLMs.
- Reference server and client implementations are derived by autocoding harnesses using the protocol as a source of truth.

## License

MIT
