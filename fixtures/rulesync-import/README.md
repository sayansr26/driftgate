# `rulesync-import`

A **rulesync** repository. Two rules, chosen so the `targets` mapping is falsifiable:

- `style.md` has `targets: ["*"]` and must import as `tools: all`.
- `tests.md` has `targets: [claudecode, cursor]` and must import as
  `tools: [claude-code, cursor]` — rulesync's ids translated to Driftgate's.

Without the first, an importer that returned a narrow selector for everything would pass.

`targets` is the one field any of these formats has that maps straight onto canonical
`tools`, so it survives here where an adapter import has to widen to `all` and let T018
reconstruct it.

Assertions live in `packages/cli/test/interop-import.test.ts`; `pnpm fixtures:update` skips
this directory because interop importers are not adapters.
