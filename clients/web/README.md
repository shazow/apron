# Moved: Apron web client

The SvelteKit web client deployed at `https://web.apron.chat` now lives in
[apron-chat/apron-web](https://github.com/apron-chat/apron-web), with its
history. That repository tests every pull request and deploys on merge to
`main`.

The browser tests in [`tests/interop`](../../tests/interop) still run it
against the Go server; `make install` clones it into `.apron-web/`.
