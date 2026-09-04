# Seeded adapter requests

One file per `good first adapter` issue: a tool Rulegate does not support, with the files
that tool actually reads, a link to the vendor documentation, and enough detail that the
issue is actionable without asking the maintainer anything.

They live in the repository rather than only in the issue tracker for two reasons. They were
written before this repository was public, and an issue body is not reviewable, diffable, or
correctable once filed — these are, and a tool that changes its format changes the file here
first.

`node scripts/seed-issues.mjs` prints what it would file. `--yes` files it, through `gh`.

Each file is:

```
---
title: "adapter: <Tool>"
labels: good first adapter, adapter, tool-not-supported
---

<the issue body, Markdown>
```

Every claim about a tool's config format carries the URL it came from and the date that page
was read — the same standard `AdapterDocs` holds adapters to. A claim without one does not
belong here.

## Lifecycle of a seed

All five requests here are **filed** (issues #1–#5, 2026-09-04). The files stay checked in
because they are the reviewable, diffable source an issue body stops being the moment it is
posted.

Their siblings — Aider, Cline, Roo Code, Windsurf and Zed — were seeded when five adapters
shipped, were implemented before the repository went public, and were deleted rather than
filed: an issue saying "Windsurf is not supported yet" next to a shipping Windsurf adapter
reads as an abandoned tracker.

`scripts/seed-issues.mjs` enforces both halves of that on its own, so neither depends on
anyone remembering:

- **It skips a seed whose `packages/adapters/<id>/` exists**, and says which. The directory
  listing decides, for the same reason `registry.test.ts` pins `ADAPTERS` to it rather than to
  a hand-kept list.
- **It skips a title already on the tracker**, open or closed, read live from GitHub before it
  files anything. Running `--yes` twice is therefore safe; without this the checked-in files
  would be filed again every time, because "already done" is invisible from inside the
  repository. If it cannot read the tracker it refuses rather than risk duplicates.

Delete a seed when its adapter lands. If you forget, the script will not file it.
