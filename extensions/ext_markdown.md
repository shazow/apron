# `ext:markdown`

Adds a common set of extensions to `"markdown"` text
([§3.5.2](../PROTOCOL.md#352-rendering)), so that the same text reads the same
in every client that renders them.

- The extension is informative and for clients only. It has no data, and
  servers don't advertise it. Clients follow it with any server.
- Clients write these extensions with the syntax below, and no other.

## Syntax

- A soft line break renders as a hard break
  ([§3.5.2](../PROTOCOL.md#352-rendering)). A blank line still separates
  paragraphs.
- Tables, strikethrough (`~~text~~`), and task list items (`- [ ] task`,
  `- [x] done`) follow [GFM](https://github.github.com/gfm/).
- `||text||` is a spoiler. Clients hide its text until the reader reveals it.
- A run of `||` opens or closes as `~~` does. `a || b`, with a space on each
  side, is no spoiler.
- A spoiler is inline, so it ends with its paragraph. In a table cell, its bars
  are escaped: `\|\|text\|\|`.
- Where clients show text without rendering it, such as in a notification,
  they show a placeholder in place of each spoiler.
- A bare `http://` or `https://` URL is a link. The link leaves out the
  punctuation at the URL's end.
- A bare Apron link in its `apron:?` form is a link
  ([Appendix A.4](../PROTOCOL.md#a4-links)).
- A fenced code block's info string is its language, for syntax
  highlighting.
- Raw HTML shows as text.
- Where the user may edit a message, checking a task's box edits the
  message's text. The edit rewrites only that item's marker.
- Clients render no other extension, such as footnotes, `==highlight==`, math,
  or typographic quotes. Its syntax shows as text.

Without the extension, clients render `"markdown"` text as
[§3.5.2](../PROTOCOL.md#352-rendering) allows. They show the syntax of an
extension that they don't render as text, such as `||text||`. So a spoiler
hides its text only in clients with the extension.

## References

- [CommonMark](https://spec.commonmark.org/)
- [GitHub Flavored Markdown](https://github.github.com/gfm/)
