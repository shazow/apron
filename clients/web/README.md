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

The default connection is same-origin `/ws` in a browser. The Connect popover
in the sidebar header accepts a WebSocket URL or an HTTP(S) server base URL and
stores it in local storage. The profile bar at the foot of the sidebar edits
your handle, which is sent with the protocol `nick` request after anonymous
authentication; the editor shows what the server actually kept.

The UI follows the Apron design system. `src/lib/design/tokens.css` holds its
color, type, spacing, radius and size tokens as CSS custom properties (dark is
the reference theme; light follows `prefers-color-scheme`), and
`src/lib/design/apron.css` is the design system's component stylesheet copied
verbatim, so every `ap-*` class in `src/routes/+page.svelte` matches the
system's React components one to one. Re-copy `apron.css` when the design
system changes rather than editing it here.

Protocol types, replay reduction, and the WebSocket session live under
`src/lib/protocol`. Room history recovery captures the room head, pages complete
snapshots from the empty-log boundary, and buffers live snapshots until recovery
finishes. Opening a thread fetches its history independently with `thread_id` and
a fixed head. The reducer installs the greatest `log_id` for each `message_id`,
so overlapping history and live delivery cannot revert newer state.

Edits, moves, and deletion use the same `message` request as creation, with an
existing `message_id` and complete editable state. The client preserves unknown
extensions, embeds, and other fields it is not changing. Starting a thread first
requests server-assigned metadata through `thread`, then saves the message with
the returned `thread_id`. Thread titles fall back to the root excerpt or ID in
the UI; empty threads remain available.
