# `ext:markdown`

Adds a common syntax for extensions to `"markdown"` text
([§3.5.2](../PROTOCOL.md#352-rendering)), so that clients that implement the
same extension render and write it the same way.

- The extension is informative and for clients only. It has no data, and
  servers don't advertise it. Clients follow it with any server.
- A client implements any of these extensions that it chooses. For each one,
  it uses the syntax below.
- Clients can implement other extensions too. This list can add them later.

## Syntax

- Line breaks:
  - A soft line break renders as a hard break
    ([§3.5.2](../PROTOCOL.md#352-rendering)).
  - A blank line still separates paragraphs.
- Tables:
  - Tables follow
    [GitHub Flavored Markdown](https://github.github.com/gfm/#tables-extension-).
- Strikethrough:
  - `~~text~~` follows
    [GitHub Flavored Markdown](https://github.github.com/gfm/#strikethrough-extension-).
- Task lists:
  - `- [ ] task` and `- [x] done` follow
    [GitHub Flavored Markdown](https://github.github.com/gfm/#task-list-items-extension-).
  - Where the user may edit a message, checking a task's box edits the
    message's text. The edit rewrites only that item's marker.
- Spoilers:
  - `||text||` is a spoiler. Clients hide its text until the reader reveals
    it.
  - A run of `||` opens or closes as `~~` does. `a || b`, with a space on each
    side, is no spoiler.
  - A spoiler is inline, so it ends with its paragraph.
  - In a table cell, a spoiler's bars are escaped: `\|\|text\|\|`.
  - Where clients show text without rendering it, such as in a notification,
    they show a placeholder in place of each spoiler.
- Links:
  - A bare `http://` or `https://` URL is a link. The link leaves out the
    punctuation at the URL's end.
  - A bare Apron link in its `apron:?` form is a link
    ([Appendix A.4](../PROTOCOL.md#a4-links)).
- Code blocks:
  - A fenced code block's info string is its language, for syntax
    highlighting.
- Raw HTML:
  - Raw HTML shows as text.

Without the extension, clients render `"markdown"` text as
[§3.5.2](../PROTOCOL.md#352-rendering) allows. They show the syntax of an
extension that they don't render as text, such as `||text||`. So a spoiler
hides its text only in clients with the extension.

## References

- [CommonMark](https://spec.commonmark.org/)
- [GitHub Flavored Markdown](https://github.github.com/gfm/)
