# Contributing to Rulegate

The contribution this project wants most is **an adapter for a tool it does not support
yet**. Five ship today; the tools people use number in the dozens. That gap is the one an
outside contributor can close fastest, and `rulegate adapter new <tool>` exists to make it
an afternoon rather than a weekend. Start at
[`docs/writing-an-adapter.md`](docs/writing-an-adapter.md).

Bug reports, precedence corrections and documentation fixes are equally welcome. A
`format-changed` report — a vendor changed a file format and an adapter now generates the
wrong thing — jumps the queue ahead of everything else.

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Node ≥ 20 (this repository develops on 22; see `.nvmrc`) and pnpm 10.18.3, which
`packageManager` pins. There is no bundler: the build is `tsc`, per package.

## The commands

| Command                | What it does                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| `pnpm build`           | `tsc` in every package                                             |
| `pnpm typecheck`       | `tsc --noEmit` across the workspace                                |
| `pnpm test`            | Vitest, once                                                       |
| `pnpm test:watch`      | Vitest, watching                                                   |
| `pnpm lint`            | ESLint, including the rules that enforce the invariants below      |
| `pnpm format`          | Prettier, check only (`format:fix` writes)                         |
| `pnpm verify`          | lint ▸ build ▸ typecheck ▸ test — what a PR has to pass            |
| `pnpm fixtures:update` | Regenerate golden fixtures. Needs `pnpm build` first, and `--yes`. |
| `pnpm smoke`           | Pack every workspace package and install the CLI from the tarballs |

One file: `pnpm vitest run <path>`. One case: add `-t "<name>"`.

### `RULEGATE_TEST_DIST=1 pnpm test`

Run this after `pnpm build`, and run it before opening a PR that touches a package's
`exports` map, its `bin`, or an exit code.

The normal suite aliases `@rulegate/*` to source, so it runs on a clean clone before
anything is built — and nothing in it exercises the built `dist/`. A broken `exports` map or
a regressed exit code would stay invisible until publish day. This lane has already caught
one real regression: a rewrite of `program.ts` dropped commander's `exitOverride`, and usage
errors began exiting 1, which is the code that means _drift_.

## What CI runs

`.github/workflows/ci.yml`, on every push and pull request:

- **Six cells** — macOS, Linux and Windows × Node 20 and 22, `fail-fast: false`. Windows is
  why the matrix exists: path separators and CRLF are where deterministic rendering breaks,
  so a green Linux run is not evidence. Every cell reports; a Windows-only failure hidden
  behind a cancelled matrix is the failure the matrix is for.
- Each cell runs install ▸ **lint before build** (ESLint must resolve the workspace from
  source on a clean clone, which is the state the runner is in) ▸ build ▸ typecheck ▸ test ▸
  the dist lane ▸ **`rulegate check` on this repository**.
- **A packaging smoke** (`scripts/smoke.mjs`) that packs every workspace package and
  installs the CLI from the tarballs, then runs `init`, `sync`, `check` clean, `check`
  against a hand-edited file (exit 1), `doctor`, and an unknown command (exit 2).
- **Prettier**, on one cell.

## The pre-commit hook

This repository ships `.pre-commit-hooks.yaml`, so `rulegate check --staged` can run as a
commit hook in any repository that adopts Rulegate. See the README for the two snippets.

`--staged` is the one place in shipped source that spawns a process, and
`packages/core/src/git/` is the only directory allowed to — `invariants.test.ts` pins that
allowlist to exactly one entry, pins the three read-only git subcommands it may run, and
asserts the module uses `execFile` rather than `exec`. `git fetch` is one argument away from
making "zero network calls" false, so the hole gets its own guard rather than relying on the
file scan that no longer covers it.

## Invariants a pull request must not break

These are not style preferences. Each is enforced mechanically, by
`packages/core/test/invariants.test.ts`, by `eslint.config.js`, or by both — because an
inline `eslint-disable` defeats a lint rule and nothing defeats a file scan.

- **Zero network calls, in any code path.** `node:http`, `node:https`, `node:net`,
  `node:dgram`, `node:dns`, `node:tls`, `fetch(` and `XMLHttpRequest` are banned in all
  shipped source. So is a runtime dependency that would bring one: the allowlist is `yaml`,
  `commander`, `picocolors`, and it is asserted by test.
- **No process spawning.** `node:child_process` appears nowhere in shipped source. Scripts
  under `scripts/` may spawn; they are not shipped.
- **Nothing that makes output depend on the machine.** `os.EOL`, `.localeCompare(` and
  `Math.random()` are banned. Sort with `compareCodepoint`. See
  [`docs/determinism.md`](docs/determinism.md) — nondeterminism is a P0 bug, because it is
  what would make `check` cry wolf.
- **Writes live in three files.** `packages/core/src/io/`, `packages/core/src/pipeline/apply.ts`
  and `packages/core/src/fs/types.ts`. `computePlan` is the only renderer, `applyPlan` the
  only writer, `verifyPlan` reads only, and `pipeline/` is pinned to exactly three modules.
  This is what makes `check` and `sync` structurally incapable of disagreeing; if they can
  diverge, `check` is lying.
- **Never write over, or delete, a file Rulegate did not generate.** `state.json` is the
  only record of ownership. `--force` may take ownership, but only after copying the
  original into `.rulegate/backup/`.
- **Adapters import `@rulegate/adapter-kit`, never `@rulegate/core`**, and never
  `node:fs`, `node:path`, `node:os` or a network module. If a symbol you need is missing
  from the kit, add it there — additions are non-breaking, removals cost an
  `ADAPTER_API_VERSION` bump. See [`docs/adapter-api-v1.md`](docs/adapter-api-v1.md).
- **No type escapes in adapter code** — `as any`, `as unknown as`, `@ts-expect-error` and
  `@ts-ignore` all fail the scan.

## This repository generates its own agent config

`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/*.mdc` and
`.github/copilot-instructions.md` are **generated artifacts**. Do not edit them. Edit
`.rulegate/rules/`, run `rulegate sync`, and commit the rule and every regenerated file
together — CI runs `rulegate check` here, so a rule change without its artifacts fails the
build.

For the same reason every generated path is listed in `.prettierignore` deliberately: a
formatter and a generator cannot both own a file. Reformat a generated one and the next
`sync` correctly reports it as hand-edited and refuses to write it. Format
`.rulegate/rules/` instead.

## Fixtures

Goldens live in `fixtures/` and are asserted byte-exact. `fixtures/README.md` is the full
description. The rule that matters most: **hand-write `expected/` from the tool's documented
behavior before implementing the adapter.** Output generated by the adapter it is meant to
check proves only that the adapter agrees with itself — and both format traps this project
has hit (Cursor's `.mdc`, which looks like YAML and is not; Copilot's `applyTo`, which _is_
YAML and must not be treated as one) were caught precisely because the golden came first.

`pnpm fixtures:update` regenerates goldens. It requires a build, writes nothing without
`--yes`, and refuses to run when `CI` is set — a regenerated golden hides the regression it
exists to catch.

## Opening a pull request

- `pnpm verify` is clean, and `RULEGATE_TEST_DIST=1 pnpm test` too if you touched
  packaging, the CLI's exit codes, or an `exports` map.
- **A test that fails without your change.** Not a test that describes the new code — one
  that goes red when the change is reverted.
- **Mutate the guard before believing it.** Delete or invert the exact line your new test
  protects, run the suite, and check that _that_ test fails and ideally that no other one
  does. This repository has found more than a dozen tests that passed while catching
  nothing: a hint scan that read only half of a concatenated string, a fixture comparison
  that tampered with the expected value instead of the rendered one, a refusal branch no
  generator input ever reached. Every one looked correct and passed on the first run.
- Comments explain _why_ a constraint exists, not what a line does. Match the density of the
  code around you.
- Prefer the smallest change that is still correct.

## Reporting

- **Bug** — include the command, the exit code, and `rulegate doctor --json`.
- **`tool-not-supported`** — the tool, the files it reads, and a link to its format
  documentation. This is also the fastest route to an adapter, yours or somebody else's.
- **`format-changed`** — a vendor changed a format and an adapter is now wrong. P0. Include
  the vendor page and the date you read it.

Adapter requests and open-ended questions belong in Discussions; the _Adapter requests_
category is the roadmap.

## Code of conduct

By participating you agree to [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Rulegate is MIT licensed, and contributions are accepted under the same license.
