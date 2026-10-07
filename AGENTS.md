# Agents

## Writing PROTOCOL.md

PROTOCOL.md stands alone. Readers know other protocol specifications; don't
explain conventions, key words, or example arrows. Don't refer to the schema,
fixtures, or implementations from it.

### Structure

- Keep the order: introduction, transport, identifiers, core (§3), then
  capabilities (§4), then appendices. Core sections don't depend on
  capabilities; mention one only to point to it.
- Order §4 by how commonly a capability is implemented, not by when it was
  added.
- A section MAY open with a short paragraph of context and motivation. Write
  it as prose; the rules follow as bullets.
- Group long sections under bold labels (**Delivery.**, **Mute.**) rather
  than new numbered headings.

### Sentences

- Lean on Simplified Technical English (ASD-STE100), loosely: one rule per
  sentence, active voice, an explicit subject ("the server", "clients"),
  the same word for the same thing. Introductions can flow more freely.
- Prefer possessives when they read clearly ("the user's connections").
- Write short, whole sentences. Split a sentence that carries several ideas.
- Keep lists in point form: one rule per bullet, as a short standalone
  sentence.
- Use plain terms. If a phrase needs explaining, rewrite it.
- Don't use "names" as a verb. A field "refers to" what it points at, and
  "defines" what it specifies.
- Requirements use capitalized key words. Lowercase "must" is not a rule.

### Rules

- State rules, not their consequences. Say what an implementation must do
  and let implementers work out the effects.
- Prefer less text, but not at the cost of clarity. A change replaces
  wording rather than adding to it, and leaves out what another rule
  implies or what is up to the implementation.
- Generalize rather than enumerate. Before adding a rule, check whether a
  general one already covers it: unknown or hidden IDs, policy refusals,
  unknown names (§1), server normalization (§1.1), ordering (§1), merging
  (§3.3), extension names (§4). Don't restate a general rule in a section.
- Merges are one level deep: a field that's present replaces the kept
  value, an empty value clears it, and an absent field stays. `ext` merges
  the same way, one level into its keys.
- A method is a request when its sender needs the reply; otherwise it is a
  notification.
- "Server policy" notes stay only when they're brief and point somewhere
  useful, such as a suggested convention.

### Changes

- Every change to the wire goes in HISTORY.md under the current protocol
  version. Editorial changes don't, unless they renumber sections.
- When sections are renumbered, update every link, the schema, and the
  fixtures in the same change.
- Keep `schema/apron.schema.json` in step with PROTOCOL.md, and run
  `uv run tests/schema/validate.py` after changing either.
