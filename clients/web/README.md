# Bottomless Chat web client

This is a Svelte 5 / SvelteKit 2 + TypeScript client for the Bottomless Chat protocol. It
builds as a static shell with `adapter-static`; the browser opens the WebSocket
from `onMount`, so the generated site can be served by the Go server.

From this directory:

```sh
npm ci
npm run dev       # Vite serves the UI and proxies /ws to 127.0.0.1:8080
npm run check     # svelte-check
npm test          # reducer and replay unit tests
npm run build     # writes the static site to build/
npm run preview
```

The default connection is same-origin `/ws` in a browser. The Connection
settings panel accepts a WebSocket URL or an HTTP(S) server base URL and stores
it in local storage. Display names are sent with the protocol `nick` request
after anonymous authentication.

Protocol types, replay reduction, and the WebSocket session live under
`src/lib/protocol`. History recovery captures the room head, pages raw or
rastered transitions from the empty-log boundary, buffers live transitions,
and replays the buffer after the checkpoint. The reducer preserves unknown
event fields, enforces immutable creation IDs, and applies RFC 7396 merge
patches.
