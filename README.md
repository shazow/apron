# Apron Chat Protocol

Apron aspires to create an ecosystem of _bottomless_ Apron chat clients that work with any headless Apron server.

For example: Web browsers are bottomless renderers of HTTP. There are a bunch of browsers, and there's astronomically many web servers. We want this for chat!

Apron keeps the chat protocol simple by taking advantage of several trust assumptions: A server is authoritative, there is no federation, there is no greater social network. It should be extremely easy to implement a basic server (~100 lines of code), and moderately easy to build a basic client.

**Status**: v1 beta, core protocol is stable, capabilities are being validated

<img width="721.5" height="536" alt="Screenshot of the Sveltekit Apron Chat implementation" src="https://github.com/user-attachments/assets/bdd4b15c-485e-4c19-838b-75c748dd2890" />

## Getting Started

1. Read the [PROTOCOL.md](PROTOCOL.md)
2. Try the live demo: [web.apron.chat](https://web.apron.chat/)
3. Explore some implementations:
  - https://github.com/apron-chat/apron-web (frontend for the live demo above)
  - https://github.com/apron-chat/apron-server-cloudflare (demo server running on a Cloudflare Worker free tier with limited functionality)
  - https://github.com/apron-chat/apron-server-go (more complete reference server for self-hosting)
  - https://github.com/apron-chat/apron-pr-bot (github pull request bot used on the demo server)

## Assumptions & Goals

- Trusted deployments: Small groups where members are mostly known to each other. No sybil resistance, no spam defense, no public federation. Permission policy is whatever the backend decides.
- Backend is authoritative: Identity, membership, history, threading, mutation. The frontend generally acts as a dumb renderer.
- Backends can be trivial: An afternoon or one-shot LLM prompt should implement a working backend provider.
- Any frontend, many backends: Aspiring to have many Apron-compatible chat frontends and backends.
- Incremental capabilities: Partial implementations should be immediately useful. Avoid capability negotiation when possible, but we expect the protocol to be forked and expanded to fit niche use cases.
- Stateless protocol: Server is not required to hold per-client state between requests.
- One websocket to start, additional signaling bootstrapped from there (e.g. HTTP upload target, WebRTC, etc).
- Multimedia-friendly: Upload images, audio, whatever.

## Specification

- [PROTOCOL.md](PROTOCOL.md): the authoritative Apron Chat Protocol definition.
- [HISTORY.md](HISTORY.md): changes by protocol version.
- [`schema/apron.schema.json`](schema/apron.schema.json): an informative JSON Schema of the frames, for validation and editor completion.
- [`tests/fixtures`](tests/fixtures): conformance fixtures that implementations can test against. The [wire fixture README](tests/fixtures/wire/README.md) describes the wire fixtures, and [DEVELOPMENT.md](DEVELOPMENT.md) says where each fixture runs.

## AI Usage

The PROTOCOL.md was very carefully hand-edited but also iterated upon with the help of LLMs. Server and client implementations were more fully derived by autocoding harnesses by using the protocol as a source of truth. This semi-automated validation cycle allowed for refining the protocol more rapidly and precisely, by immediately exploring the edge cases of functionality.

## License

MIT
