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

The default connection is same-origin `/ws` in a browser unless
`VITE_DEFAULT_SERVER_URL` is set at build time. `make deploy-web` from the
repository root builds with `wss://server.apron.chat/` and deploys the static
frontend to `https://web.apron.chat` using `wrangler.toml`. Deploy the backend
separately with `make deploy-worker`. The apex `apron.chat` is reserved for docs.
Local development and ordinary builds retain the same-origin default.
After a failed WebSocket handshake, the client makes a bounded HTTP diagnostic
request to the same URL with `?apron_connection_status=1`. Supporting servers
can expose a capacity error and `Retry-After` through CORS; the client displays
the reason and waits before retrying, including manual retries. Servers without
this optional endpoint retain ordinary reconnect behavior.
Repeated connection failures back off from 500 ms to about one attempt per minute
with jitter. An explicit server retry window takes precedence.
Typing notifications refresh at most once every four seconds per room, with
one stop notification when typing ends, to avoid charging a frame per keystroke.
Explicit server URLs keep their path: a bare hostname connects at `/`, while
servers that require `/ws` should be entered with that suffix.

Typing `@` in the composer opens the mention picker over the senders this room
has seen, filtered by what follows: arrows move, Tab or Enter inserts `@name` as
plain text, Escape dismisses. A rendered body turns an `@handle` that matches a
sender's name or ID — whole word, case-insensitive, never inside code — into a
mention chip. A message that names you tints its row with a rust rule, pulses
once as it arrives (never on replayed history), raises an `@` badge on a room
you aren't reading, and, when it lands above the fold, turns the jump bar rust
with **Jump to mention**. Mentions are decided here from the text; the protocol
carries none.

With the `edit` cap, several of your messages move into one thread at a time:
shift-click a message (or press `x` on it, long-press it on touch, or pick
**Select** from its More menu) to enter select mode, shift-click another to fill
the range, and the selection bar replaces the composer with the count, **Move to
thread**, **New thread** and Cancel. Each message is its own `message` request;
denied ones stay selected and the bar says how many didn't move. Escape leaves
select mode.

When the server advertises an `upload` URL, the composer grows attach and
microphone buttons: attach posts the file as `multipart/form-data` to that URL
(§6.1) and sends the returned URL as an embed, and the microphone records a clip
and sends it as an `audio` embed. Neither example server in this repository
offers uploads, so both buttons stay hidden there.

**Connect** in the
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

When the server advertises token authentication, the session token it returns
is kept in `localStorage`, keyed by server URL, and automatically resumes the
same identity after a transport disconnect, a page reload, or in a new tab, for
as long as the server keeps the session alive (the example servers renew it on
every resume). Servers that offer passkeys without token resume get no stored
credential; there a reconnect runs another ceremony and a reload starts as a
guest. Expired sessions require another passkey login; the client does not
automatically replace them with a guest identity. Signing out clears the stored
credentials and reconnects as a guest. The Go example's sessions are in memory
and are lost on backend restart.

The WebAuthn exchange follows [Appendix C of the protocol](../../PROTOCOL.md#appendix-c--webauthn-authentication-optional):
both registration and login use `action` plus `step: "begin"` or
`step: "finish"`, with the server's `challenge_id` and `public_key` and the
browser's standard JSON credential representation. The implementation details
for the Go example are documented in
[`servers/go/README.md`](../../servers/go/README.md#example-webauthn-exchange).

The UI follows the Apron design system. `src/lib/design/tokens.css` holds its
color, type, spacing, radius and size tokens as CSS custom properties (dark is
the reference theme; light follows `prefers-color-scheme`), and
`src/lib/design/apron.css` is the design system's component stylesheet copied
verbatim. The Svelte components under `src/lib/components` wrap its `ap-*`
classes one to one with the system's React components — `ConnectScreen`,
`Sidebar` and `ProfileBar`, `RoomHeader` and `ThreadEditor`, `ThreadCard`,
`Message`, `Composer` with its `MentionPicker`, `SelectionBar`, `JumpBar`,
`StatusBanner`, `Avatar` — and carry only the layout glue each needs. Re-copy
`apron.css` when the design system changes rather than editing it here.

`src/routes/+page.svelte` owns the session and the navigation (which room or
thread is open, per-destination drafts) and composes the components. The
reactive state behind it lives in `src/lib/ui` as small classes — `SessionView`
(the last authenticated view, held through a reconnect), `MentionTracker`,
`MessageSelection`, `FeedbackState`, `SidebarLayout` — beside pure, unit-tested
helpers: `timeline.ts` builds the room and thread views, `messages.ts` and
`time.ts` read messages, `connection.ts` words the connection state, and
`storage.ts` keeps everything remembered between visits under `apron.*` keys.

Protocol types, replay reduction, and the WebSocket session live under
`src/lib/protocol`. Recovery uses the base protocol's `latest_log_id` and
`history_log_id` fields. It tracks the monotonic effective boundary and a
per-scope checkpoint, captures a fixed room head, pages complete snapshots from
the retained boundary, and buffers bounded live snapshots until recovery
finishes. A checkpoint at `history_log_id - 1` resumes safely; if retention
overtakes the next uncovered range, the client rebuilds from the new boundary
and ignores obsolete replies. `history_log_id: null` means the effective
boundary is `latest_log_id + 1`. Sparse timestamp log IDs are expected.
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
