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

The default connection is same-origin `/ws` in a browser. **Connect** in the
sidebar header opens the connect screen: a WebSocket URL or an HTTP(S) server
base URL, a display name, and a sign-in choice (Guest by default; Passkey signs
in with an existing passkey once the guest session is up). The server and name
are stored in local storage, and the last few backends are listed under the
form. The profile bar at the foot of the sidebar edits your handle, which is
sent with the protocol `nick` request after authentication; the editor shows
what the server actually kept.

The profile editor's Sign-in row offers **Add passkey**, **Sign in with passkey**,
and **Sign out** when the server advertises WebAuthn. With the Go example, open
`http://localhost:5173` (or `http://localhost:8080` for a static build); other
deployments need HTTPS and configured RP/frontend origins. Adding a passkey
keeps your guest identity and message ownership. Signing in restores the
identity attached to your chosen passkey.

Passkeys use the browser's native WebAuthn JSON APIs, with no frontend dependency.
An up-to-date browser is required; unsupported browsers can still chat as guests.
Browser cancellation and verification errors appear in the profile editor. A
connection change cancels the active ceremony. Chat requests pause while a
ceremony is active, preventing edits from crossing an identity change.

The session token stays in memory, scoped to this mounted client and server URL,
and automatically resumes the same identity after a transport disconnect. A page
reload requires signing in again. Expired sessions require another passkey login;
the client does not automatically replace them with a guest identity. Signing out
revokes the current token and reconnects as a guest. The Go example's credentials
are also in memory and are lost on backend restart.

The implementation-specific WebAuthn exchange is documented in
[`servers/go/README.md`](../../servers/go/README.md#example-webauthn-exchange).
The Cloudflare demo additionally advertises `webauthn.demo.v1`: its
`register`/`login` ceremony uses `step: "begin"` and `step: "finish"`, returns
`public_key` options plus a `challenge_id`, and receives the browser's JSON
credential response. The adapter selects that exchange only when the server
advertises the extension, so the Go example's `register_begin` and
`login_begin` actions remain compatible. Demo sign-out is local and reconnects
as a guest because the extension has no server-side logout method.

The UI follows the Apron design system. `src/lib/design/tokens.css` holds its
color, type, spacing, radius and size tokens as CSS custom properties (dark is
the reference theme; light follows `prefers-color-scheme`), and
`src/lib/design/apron.css` is the design system's component stylesheet copied
verbatim, so every `ap-*` class in `src/routes/+page.svelte` matches the
system's React components one to one (thread cards with a preview line, reply
quotes, the pinned thread summary, the thread editor popover, the profile
editor's sign-in row and the connect screen included). Re-copy `apron.css` when
the design system changes rather than editing it here; the few `app-*` rules in
the page are layout glue only.

Protocol types, replay reduction, and the WebSocket session live under
`src/lib/protocol`. When `history_floor.v1` is advertised, recovery tracks the
monotonic floor and a per-scope checkpoint, captures a fixed room head, pages
complete snapshots from the retained boundary, and buffers bounded live
snapshots until recovery finishes. A checkpoint at `floor - 1` resumes safely;
if retention overtakes the next uncovered range, the client rebuilds from the
new floor and ignores obsolete replies. Sparse timestamp log IDs are expected.
Opening a thread fetches its history independently with `thread_id` and a fixed
head, without advancing room coverage. The reducer installs the greatest
`log_id` for each `message_id`, so overlapping history and live delivery cannot
revert newer state. The UI displays a notice that the demo retains roughly the
last day and honors server retry delays with jittered reconnect backoff.

Edits, moves, and deletion use the same `message` request as creation, with an
existing `message_id` and complete editable state. The client preserves unknown
extensions, embeds, and other fields it is not changing. Starting a thread first
requests server-assigned metadata through `thread`, then saves the message with
the returned `thread_id`. Thread titles fall back to the root excerpt or ID in
the UI; empty threads remain available.
