# Agents

## Writing PROTOCOL.md

- State rules, not their consequences. Say what an implementation must do
  and let implementers work out the effects.
- Write short, whole sentences. Split a sentence that carries several ideas.
- Keep lists in point form: one rule per bullet, as a short standalone
  sentence.
- Prefer less text. A change replaces wording rather than adding to it, and
  leaves out what another rule implies or what is up to the implementation.
- Generalize rather than enumerate: one rule that covers the cases beats a
  list of them.
- Use plain terms. If a phrase needs explaining, rewrite it.
- Don't use "names" as a verb. A field "refers to" what it points at, such
  as a `room_id` that refers to a room, and "defines" what it specifies.
- Keep `schema/apron.schema.json` in step with PROTOCOL.md, and run
  `uv run tests/schema/validate.py` after changing either.
