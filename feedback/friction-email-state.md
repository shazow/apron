### F1. Several pending proposals with the same state
- Spec: §4.11.1 (proposal `state`), §4.11.3 ("An approval MAY carry the proposal's `state`")
- Kind: ambiguity
- What happened: `state` now names a proposal across connections, but nothing says a client uses a new state for each proposal, or what a server does when two live proposals (on different connections) carry the same state. A short code plus state then has two candidate proposals.
- What I did: apron-server-go indexes proposals by SHA-256 of state and lets the latest proposal with a state own it; an earlier one keeps its code on its own connection and its link. apron-web already makes a fresh 32-byte state per proposal.
- Suggested spec change: in §4.11.1, "A client uses a new `state` for each proposal." Optionally: "When live proposals share a `state`, it names the latest."

### F2. A state that names no proposal, or one that is too long, on an approval
- Spec: §4.11.1 (failed attempts; state at most 256 bytes), §4.11.3
- Kind: gap
- What happened: §4.11.1 bounds `state` at 256 bytes for a proposal, and says failed attempts count against "the proposal". An approval whose state names no live proposal (wrong, expired, or longer than 256 bytes) has no proposal to count against, and the spec does not say whether an over-long state on an approval is `too_large` (as on a proposal) or simply `denied`.
- What I did: Go answers `denied` and counts nothing for a state that matches nothing, at any length; a wrong code with a matching state counts against that proposal from any connection, and so do five of them cancel it.
- Suggested spec change: §4.11.3: "A `state` that names no pending proposal is ignored: the token is then checked as without it." (This also makes "no state" and "wrong state" behave the same, which is what the tests check.)

### F3. A proposal's requested name/user_id when approved elsewhere with state
- Spec: §4.11.3, §3.2 (`name`, `user_id`)
- Kind: gap (informative)
- What happened: apron-server-go applies the proposal's own `name`/`user_id` only when the proposing connection approves, since a link opened elsewhere is the mailbox owner's. A code with state on a fresh connection is usually the proposer, but the link carries the state too, so the server cannot tell them apart.
- What I did: kept the rule: on another connection only the approval's own `name`/`user_id` apply. The web client sends its name with the approval's follow-up `me`, so nothing is lost there.
- Suggested spec change: none needed; optionally a note in §4.11.3 that a client resending `name`/`user_id` with the approval gets them on any connection.

### F4. A test mock in apron-web lists `email` without `token`
- Spec: §4.11 ("Servers that list `email` ... MUST also list `token`")
- Kind: conformance (test fixture only)
- What happened: apron-web's e2e mock server (`e2e/mock-server.ts`) greets with `auth: ['guest', 'webauthn', 'email']`. It never completes an email sign-in, so nothing breaks, but it now models a non-conforming server. apron-server-go always adds `token` when it offers any scheme; apron-server-cloudflare does not offer `email`.
- What I did: left the mock alone (changing its `auth` changes what the connect screen shows across e2e specs and the perf budget); noted here.
- Suggested spec change: none.
