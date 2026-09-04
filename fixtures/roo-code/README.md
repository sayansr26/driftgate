# `roo-code`

The fixture is built so that **canonical order and alphabetical order disagree**, which is
the one thing this adapter has to get right.

Roo Code concatenates the files in `.roo/rules/` sorted "by basename only,
case-insensitive". That ordering is Roo's, and it knows nothing about Rulegate's `order`
frontmatter — so a rule named `40-alpha-last` would sort *before* `10-style` under any
scheme that used the rule id alone, and the user's stated order would silently invert.

Generated filenames therefore carry a zero-padded index derived from the rule's position in
`sortRules`: `001-10-style.md`, `002-20-testing.md`, `003-40-alpha-last.md`. The full
canonical id stays after the index, so every output file still traces to exactly one
canonical rule (T007's reasoning for keeping the `10-` prefix in `.mdc` filenames).

A fixture whose rules happened to sort the same way both times would pass against an adapter
that emitted no index at all.
