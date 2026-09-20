# apron

A bottomless chat frontend for any headless backend.

What is "bottomless"? It's the opposite of "headless", bottomless apps are frontends that you can point at a protocol provider and they act as a renderer. For example: Web browsers are bottomless renderers of HTTP.

We aim to substantially simplify the chat protocol by taking advantage of several trust assumptions.

**Status**: v0 alpha, protocol is stabilizing but expect some minor changes.

<img width="721.5" height="536" alt="Screenshot of the Sveltekit Apron Chat implementation" src="https://github.com/user-attachments/assets/bdd4b15c-485e-4c19-838b-75c748dd2890" />

## Assumptions & Goals

- Trusted deployments: Small groups where members are mostly known to each other. No sybil resistance, no spam defense, no public federation. Permission policy is whatever the backend decides.
- Backend is authoritative: Identity, membership, history, threading, mutation. The frontend generally acts as a dumb renderer.
- Backends can be trivial: An afternoon or one-shot LLM prompt should implement a working backend provider.
- Any frontend, many backends: Aspiring to have many Apron-compatible chat frontends and backends.
- Incremental capabilities: Partial implementations should be immediately useful. Avoid capability negotiation when possible, but we expect the protocol to be forked and expanded to fit niche use cases.
- Stateless protocol: Server is not required to hold per-client state between requests.
- One websocket to start, additional signaling bootstrapped from there (e.g. HTTP upload target, WebRTC, etc).
- Multimedia-friendly: Upload images, audio, whatever.

## License

MIT
