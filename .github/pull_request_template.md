## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `pnpm verify` is clean (lint, build, typecheck, test)
- [ ] `DRIFTGATE_TEST_DIST=1 pnpm test` after `pnpm build`, if this touches packaging, the
      CLI's exit codes, or an `exports` map
- [ ] There is a test that **fails without this change** — not one that merely describes it
- [ ] I mutated each new guard once: I deleted or inverted the line it protects, ran the
      suite, and that test went red
- [ ] If a `.driftgate/rules/` file changed, `driftgate sync` was run and every regenerated
      artifact is committed alongside it
- [ ] No generated file was edited by hand

## For an adapter

- [ ] `fixtures/<tool>/expected/` was hand-written from the vendor's documentation, before
      the adapter existed
- [ ] Every claim in `src/docs.ts` carries a source URL and the date I read it
- [ ] I ran the real tool against the generated config and it loaded — version:
