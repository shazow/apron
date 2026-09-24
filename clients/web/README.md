# Bottomless Chat web client

This is a Svelte 5 / SvelteKit 2 + TypeScript client for the Bottomless Chat protocol. It
builds as a static shell with `adapter-static`; the browser opens the WebSocket
from `onMount`, so the generated site can be served by the Go server.

From this directory:

```sh
npm ci
npm run dev       # Vite serves the UI and proxies /ws, /write/, /files/, /streams/ to 127.0.0.1:8080
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
with jitter. An explicit server retry window takes precedence, including a
`retry_after` error about the connection as a whole (`data.retry_after`
seconds); after such a `denied` error the client stops reconnecting, shows
**Signed out** with the server's message, and waits for **Sign in**.
With the `activity` cap, typing is reported as `activity` notifications that ask
for a 15-second indicator (`typing: 15`) and refresh it at most once every 12
seconds per room, with one `typing: 0` when typing pauses, to avoid charging a
frame per keystroke. Sending a message sends no `typing: 0`: the message itself
ends the indicator. Other people's indicators last as long as their `typing`
asks, or until their next message arrives in that room.
Explicit server URLs keep their path: a bare hostname connects at `/`, while
servers that require `/ws` should be entered with that suffix.

Names and avatars are the latest the server sent for each `user_id` (from
`you`, `user` notifications, `room_list` members, then live messages), so a
rename or a new avatar shows on earlier messages too; a `user` notification
with `old` maps the retired ID to the new identity. Without an avatar, a
person's initials sit on a muted tint whose hue is hashed from their `user_id`,
so the same person has the same color on every client. Senders whose `user_id`
starts with `@` render as quiet system lines.

Mentions follow the `@user_id` convention (Appendix J.3). Typing `@` in the
composer opens the mention picker over the room's recent senders and its
members (`room_list` with the room's `room_id`), filtered by name or ID:
arrows move, Tab or Enter picks, Escape dismisses. A picked person becomes a chip showing their name, and a
typed `@name` (case-insensitive, spaces allowed) or `@user_id` collapses into
the same chip once finished, when exactly one person in the room goes by it;
one ending the draft collapses on send. Chips are always sent as `@user_id`, so
the field reads by name while the wire stays ID-based. A rendered body (plain or Markdown, never inside
code) shows a known user's mention as a chip with their current name, a room's
as a link that opens it (or joins it), and unknown IDs as written. A message
that names you tints its row with a rust rule, pulses once as it arrives (never
on replayed history), raises an `@` badge on a room you aren't reading, and,
when it lands above the fold, turns the jump bar rust with **Jump to mention**.

With the `activity` cap, reading the latest message of a room advances your
read cursor (`read_message_id`), which the server syncs across your
connections. Opening a room places a **New** divider above the first message
after the cursor as it was when you arrived; it stays put while you read.

Threads are rooms with a `parent_room_id`. The sidebar lists top-level rooms
and the open room's threads under it; the room feed shows each thread as a card
that previews its intro message (or, without one, its latest loaded message).
With the `rooms` cap, **Start thread** on a message creates a thread under the
room with that message as its intro; the message stays in the room, where its
card stands in for it, and leads the thread's timeline, pinned under the header.
A thread's header offers **Edit** for its title. Threads load their history when
opened; drafts are kept per room, threads included.

With the `rooms` cap the header also offers **Leave**, which leaves the room (and
its threads) or the thread. **Browse rooms** in the sidebar lists, via
`room_list`, the visible rooms you haven't joined, and **More threads…** under
the open room lists its other threads; picking one joins it and opens it once
the server announces it. Listings arrive a page at a time, newest first;
**Show older rooms** and **Show older threads** add the page before.

With the `edit` cap, several of your messages move at a time: shift-click a
message (or press `x` on it, long-press it on touch, or pick **Select** from its
More menu) to enter select mode, shift-click another to fill the range, and the
selection bar replaces the composer with the count, **Move to thread** (or, in a
thread, back to the room), **New thread** (with the `rooms` cap) and Cancel. A
move is a save of the message with the destination's `room_id`, one request per
message; a new thread is created first and the moves follow once the server has
named it. Denied ones stay selected and the bar says how many didn't move.
Escape leaves select mode.

A reply's quote may point into another room: clicking it opens that room or
thread, loading the thread's history if needed, and highlights the message.

With the `reactions` cap, a message's **React** action opens a small emoji
palette, and reactions show as chips under the message: emoji and count,
highlighted when one is yours, with a tooltip naming who reacted. Clicking a
chip toggles your reaction. Tombstones show no reactions.

Embeds render by kind, in the design system's components (Appendix E):

- **Uploads** (cap `embed:upload`): the composer's paperclip and microphone send
  files and voice clips as `upload` embeds with whatever is in the field, then
  write each file to the `write_url` in the result. The message shows a pending
  card with progress until the server publishes the finished file: an image, a
  video or audio player from its `og`, or else a file card.
- **Streams** (cap `embed:stream`): while the embed has a `url` the client reads
  it with a streaming `GET` and shows the text growing under a Live badge;
  when a snapshot carries `text` instead it shows the kept text as Finished.
  `terminal` output is monospace with ANSI colors and emphasis, carriage
  returns overwrite the line (progress bars), and other escape sequences are
  dropped; `markdown` renders, the rest is plain.
- **`iframe`** embeds stay a paused placeholder until **Load live view**, then
  load sandboxed (`allow-scripts`, never same-origin, no referrer), clamped to
  480px. **`html`** embeds are sanitized with DOMPurify before insertion.
- Any other kind renders from its `og` as a link card, else as the fallback card
  with its kind name and its `url` or `text`.

Media in `og` and stream URLs load only from the chat server's own origin;
links may point anywhere `http(s)`.

**Connect** in the
sidebar header opens the connect screen: a WebSocket URL or an HTTP(S) server
base URL, a display name, and a sign-in choice (Guest by default; Passkey signs
in with an existing passkey once the guest session is up). The server and name
are stored in local storage, and the last few backends are listed under the
form. The profile bar at the foot of the sidebar edits your handle, which is
sent with the protocol `me` request after authentication; the editor shows
what the server actually kept. With `embed:upload` it also sets your avatar:
the image is uploaded as a message to room `@avatar` (Appendix J.4), and the
server applies it with a `user` notification; **Remove** sends `me` with
`avatar: ""`.

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

The WebAuthn exchange follows [Appendix I of the protocol](../../PROTOCOL.md#appendix-i--webauthn-authentication-optional):
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
`Message` with its `ReactionBar`, `Composer` with its `MentionPicker`, `SelectionBar`, `JumpBar`,
`StatusBanner`, `Avatar` — and carry only the layout glue each needs. Re-copy
`apron.css` when the design system changes rather than editing it here.

`src/routes/+page.svelte` owns the session and the navigation (which room or
thread is open, per-room drafts) and composes the components. The
reactive state behind it lives in `src/lib/ui` as small classes — `SessionView`
(the last authenticated view, held through a reconnect), `MentionTracker`,
`MessageSelection`, `FeedbackState`, `SidebarLayout` — beside pure, unit-tested
helpers: `timeline.ts` groups threads under their rooms and builds the room and
thread views, `reactions.ts` turns reaction summaries into chips, `messages.ts`
and `time.ts` read messages, `connection.ts` words the connection state, and
`storage.ts` keeps everything remembered between visits under `apron.*` keys.

Protocol types, replay reduction, and the WebSocket session live under
`src/lib/protocol` and speak Apron protocol v4. `reducer.ts` keeps one store
of room records, message snapshots, and per-user reaction sets for every room;
each record replaces the stored one only when its `log_id` is greater, so
overlapping history and live delivery cannot revert newer state, and a move
snapshot re-homes a message into its new room. Embedded `reply_to` and
`intro_message` snapshots install like any other record. Reactions aggregate
per message (counts per emoji, who reacted, whether you did) and are hidden on
tombstones.

Recovery is per room and uses `latest_log_id` and `history_log_id`. For each
top-level room the client tracks the monotonic effective lower bound and a
checkpoint, captures a fixed head when the room is announced, pages every
record kind from the bound (or the checkpoint), and buffers bounded live
records until recovery finishes; the room's published timeline is held until
then. If retention overtakes the next uncovered position the client rebuilds
from the new bound and ignores obsolete replies. `history_log_id: null` means
the effective bound is `latest_log_id + 1`. Sparse timestamp log IDs are
expected. Threads are rooms with a `parent_room_id`; they load their own
history with `loadRoom` when opened. The UI displays a notice that the demo
retains roughly the last day (from the worker's `server.ext.demo` hints) and honors server retry delays with jittered
reconnect backoff.

Edits, moves, and deletion use the same `message` request as creation, with an
existing `message_id`, and resubmit every client field of the latest snapshot
(`room_id`, `body`, a bare `reply_to`, and `ext` unchanged). A move is a save
with another `room_id`. Rooms and threads are created and updated with the
`room` request (cap `rooms`); updates resubmit `title`, a bare `intro_message`,
and `ext`. Reactions use the `reactions` request (cap `reactions`) with your
complete emoji set.
