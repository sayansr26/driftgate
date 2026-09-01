# Cursor fixtures

`expected/` is hand-written from Cursor's documented `.mdc` format, not generated from
the implementation.

Three details of the dialect that a YAML emitter would get wrong, and that these
fixtures pin:

- **`globs` is a bare, comma-joined string** — `globs: a,b`. Not a YAML sequence, not
  quoted. A YAML emitter would produce a block sequence or a quoted scalar, which looks
  plausible and behaves differently.
- **Empty `globs` is a bare key** — `globs:` with nothing after it, not `globs: []`.
- **`alwaysApply` is derived**, true exactly when the rule is repo-wide. It never
  appears in canonical frontmatter.

The generated-file marker sits *after* the closing `---`, because `.mdc` frontmatter
must occupy the first bytes of the file.

Filenames keep the canonical rule id, including any numeric order prefix
(`10-style.md` → `10-style.mdc`). Stripping the prefix would read more nicely but makes
`10-style` and `20-style` collide, and would hide which canonical file produced which
output.
