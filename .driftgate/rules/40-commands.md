---
description: Commands
order: 40
---

- `pnpm install` · `pnpm build` · `pnpm test` (Vitest) · `pnpm lint` · `pnpm verify`
- `pnpm -r exec tsc --noEmit` — typecheck across the workspace
- Single test file: `pnpm vitest run <path>` · single case: add `-t "<name>"`
- `DRIFTGATE_TEST_DIST=1 pnpm test` — exercises the **built** binary. The normal suite
  aliases `@driftgate/*` to source, so nothing else catches a broken `exports` map or a
  regressed exit code. Run it after `pnpm build`; it has already caught one real
  regression.

Golden fixtures live in `fixtures/<tool>/{input,expected}` and are asserted byte-exact;
detect fixtures use `fixtures/<tool>-detect/{positive,negative}`. Regenerate with
`pnpm build && pnpm fixtures:update` — it prints the change set and writes nothing without
`--yes`, and it refuses to run when `CI` is set. See `fixtures/README.md`.

Exit codes: `0` ok · `1` drift or failure · `2` usage. CI reads the code, not the
message, so a usage error must never be reported as drift.
