---
description: Invariants
order: 30
---

Verify these still hold whenever `packages/core` changes:

- **Zero network calls** in any code path — including every adapter and every
  dependency.
- **Never write over a file Driftgate did not generate.** `state.json` is the only
  record of ownership; a path absent from it is somebody else's. `--force` may take
  ownership, but only after copying the original to `.driftgate/backup/`.
- **Never delete a file Driftgate did not generate**, checked against `state.json`.
- **Deterministic rendering** — byte-identical output across runs, platforms, and Node
  versions. Nondeterminism is a P0 bug. See `docs/determinism.md`.
- **Never write a literal secret.** MCP secrets are references (`env:GITHUB_TOKEN`)
  under every flag.
- Destructive operations **dry-run by default** or back up to `.driftgate/backup/`.
- No tool-specific logic in `packages/core`; no symlinks as an implementation strategy;
  `sync` never writes outside the repo.
