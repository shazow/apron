# Browser interoperability tests

These tests exercise the SvelteKit client against the Go server through real
Chromium browser contexts. They cover cross-session broadcasts and history
recovery, edit/delete update replay including a deleted-message tombstone,
safe rendering of untrusted markup, and basic phone viewport layout.
The desktop suite also reloads a browser while offline, restores connectivity,
verifies history replay without duplicates, and sends another message.

Install and run from the repository root:

```sh
cd tests/interop
npm ci
npx playwright install chromium
npm test
```

The config starts both services itself with `reuseExistingServer: false`:

* Go server: `127.0.0.1:8080`, started from `servers/go` with `-addr`
* Vite dev server: `127.0.0.1:5173`, started from `clients/web`

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the browser is supplied by the
environment (for example, the NixOS VM). If it is unset, Playwright uses its
normal Chromium resolution.

The UI contract used by the tests is an accessible textbox named `Message`, a
`Send message` button, and message containers rendered as
`article[data-message-id]`. Mutation controls are named `Edit message`,
`Save changes`, and `Delete message`; the editor textbox is named `Edit
message`. A deleted container remains visible with the exact text `Message
deleted`.
