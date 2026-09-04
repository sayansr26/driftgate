# `cline-import`

Covers **both tiers of T017's import rule** in one fixture, which is the point of it.

- `generated.md` carries the generated-file marker, so Rulegate wrote it and it is split
  at `##` — the exact inverse of `renderRuleSection`. Its heading becomes a `description`
  and its `**Applies to:**` line becomes `globs`, so a scoped rule survives a
  `write()` -> `read()` round trip instead of coming back repo-wide with its scoping
  stranded in the body as prose.
- `style.md` has no marker, so it is somebody's hand-written file and is imported
  **whole**: `## Style` stays in the body. In a file Rulegate did not write, a heading is
  prose structure rather than a rule boundary, and splitting on it silently reorders the
  author's instructions and attaches the wrong globs.
- `notes.txt` is here because the vendor documents `.txt` alongside `.md`. An importer
  reading only `.md` would silently drop half a user's rules, and no `.md`-only fixture
  can catch that.
