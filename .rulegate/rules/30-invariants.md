---
description: Invariants
order: 30
---

Verify these still hold whenever `packages/core` changes:

- **Zero network calls** in any code path — including every adapter and every
  dependency.
- **Never write over a file Rulegate did not generate.** `state.json` is the only
  record of ownership; a path absent from it is somebody else's. `--force` may take
  ownership, but only after copying the original to `.rulegate/backup/`.
- **Never delete a file Rulegate did not generate**, checked against `state.json`.
  `DiskComparison.orphaned` is the only source of deletion candidates in the codebase and
  `assertDeletable` is the last gate in front of `deleteFile`, so a path Rulegate never
  recorded cannot reach a delete call. An orphan whose bytes have changed since we wrote
  them is refused and keeps its `state.json` entry — dropping the record is how Rulegate
  forgets it owns a file and later calls its own artifact somebody else's.
- **Deterministic rendering** — byte-identical output across runs, platforms, and Node
  versions. Nondeterminism is a P0 bug. See `docs/determinism.md`.
- **Never write a literal secret.** MCP secrets are references (`env:GITHUB_TOKEN`)
  under every flag.
- Destructive operations **dry-run by default** or back up to `.rulegate/backup/`.
  `sync` deletes orphans on the second clause: every deletion copies the file to
  `.rulegate/backup/` first, and `rulegate restore` puts it back. `restore` itself is on
  the first clause — it prints a plan and writes nothing without `--yes`.
- No tool-specific logic in `packages/core`; no symlinks as an implementation strategy;
  `sync` never writes outside the repo.
