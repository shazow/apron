# Agents

## Writing extensions

Each file defines one extension. [EXTENSIONS.md](../EXTENSIONS.md) is the
index, and its general rules apply to every extension.

- Name the file `ext_<name>.md`, after the capability without `ext:`, such as
  `ext_oauth.md` for `ext:oauth`.
- Add the extension to the index in EXTENSIONS.md: a link, and the
  extension's first sentence.
- Follow [../AGENTS.md](../AGENTS.md), "Writing PROTOCOL.md", for sentences,
  rules, examples, and links. These rules add to it:
  - The heading is the capability, such as `` # `ext:oauth` ``. Subsections
    use `##`.
  - The first sentence starts with the verb of what the extension adds, such
    as "Adds …" or "Lets …".
  - Show the extension's data in a whole example, and its fields as a `ts`
    class with a comment that gives where it lives, such as
    `// server.ext.settings`.
  - End with what clients and servers do without the extension. An extension
    that builds on outside standards then lists them under `## References`.
  - Don't restate the general rules of EXTENSIONS.md.
- Link to PROTOCOL.md as `../PROTOCOL.md#…`, and to another extension as
  `ext_<name>.md`.
- An extension never changes a rule of PROTOCOL.md. If it needs to, change
  PROTOCOL.md instead.
- Changes to an extension don't go in HISTORY.md.
