# Agents

## Writing recipes

Each file is one recipe. [RECIPES.md](../RECIPES.md) is the index, and its
general notes apply to every recipe.

- Name the file after the topic, with `_` between words, such as
  `trusted_federation.md`.
- Add the recipe to the index in RECIPES.md: a link, and the recipe's opening
  question. Order the index by how many implementers need each recipe.
- Follow [../AGENTS.md](../AGENTS.md), "Writing PROTOCOL.md", for sentences,
  examples, and links. These rules add to it:
  - The heading is the topic, such as `# Trusted federation`. Subsections use
    `##`.
  - The first paragraph opens with the question in bold, and answers it:
    "**Can two Apron servers share rooms?** Yes, when…".
  - `## How it works` comes next, as numbered steps. Details for each
    platform go in bullets under their step, such as "Apple:" and "Android:".
  - A recipe that translates protocol objects MAY add `## Mapping`, a table
    with one row for each kind of object.
  - `## Limits` comes last. It lists what the recipe cannot do, and what it
    leaves to others, such as a platform.
  - Recipes give advice, and state no rules. They use no capitalized key
    words.
  - A recipe that needs a change to the wire MAY carry it as a draft
    extension, in a section `## Draft extension: \`ext:<name>\`` before
    `## Limits`. Write it as an extension file
    ([../extensions/AGENTS.md](../extensions/AGENTS.md)), with these
    differences: it states what implementations do without capitalized key
    words, and it opens by saying that it is a draft. When it has proved
    itself, move it to its own extension file, and link to that file.
  - Don't restate the general notes of RECIPES.md.
- Link to PROTOCOL.md as `../PROTOCOL.md#…`, and to an extension as
  `../extensions/ext_<name>.md`.
- Changes to a recipe don't go in HISTORY.md.
