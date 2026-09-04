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
