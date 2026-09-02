# `tokens` fixtures

Five frozen documents and their true `cl100k_base` token counts, used to hold
`estimateTokens` (T024) inside ±15%.

## Provenance of `reference.json`

Counts were produced on **2026-09-02** with **`gpt-tokenizer` 4.0.0**, encoding
**`cl100k_base`**, over the byte-exact files in `documents/`.

`gpt-tokenizer` is a **devDependency of the repository root only**. It is deliberately not
a dependency of any published package: `packages/core/test/invariants.test.ts` allows
exactly `yaml`, `commander` and `picocolors` at runtime, and Driftgate's whole pitch is
that it ships no tokenizer, makes no network call, and downloads no model. The reference
tokenizer exists to check the approximation in CI and never at runtime.

## Why the counts are re-derived rather than trusted

`token-accuracy.test.ts` calls the reference tokenizer itself and compares against
`reference.json`. Committing the numbers *and* re-deriving them may look redundant; it is
not. A committed number that nothing recomputes can be wrong forever, and the tempting way
to "fix" a failing accuracy test is to regenerate the expectation from the estimator — at
which point the test measures whether the estimator agrees with itself.

So there is **no `tokens:update` script**, by design. If a count here is ever wrong, it is
meant to be inconvenient to change.

## Why these five documents

| File | What it stresses |
|---|---|
| `01-claude-md.md` | this repository's own generated `CLAUDE.md` — the population `doctor` actually measures |
| `02-canonical-rule.md` | a canonical `.driftgate/rules/*.md` source: prose, dense inline code |
| `03-cursor-rule.mdc` | the `.mdc` dialect — frontmatter, bare globs |
| `04-prose-and-tables.md` | long prose with Markdown tables and headings |
| `05-adversarial.md` | long paths and globs, fenced TS and JSON, dense CJK/Hangul/Kana, Cyrillic, Greek, many ZWJ emoji sequences, a punctuation run, a very long line, and a CRLF section |

`AGENTS.md` and `.github/copilot-instructions.md` are deliberately **absent**: in this
repository all three are byte-identical to `CLAUDE.md` (T078 — the same 6,516 characters
and 1,637 tokens), so a fourth copy would have added a fixture that tests nothing.

### How adversarial `05` has to be

The first draft of it was not adversarial at all: `chars / 4` estimated it to within 9.5%,
so the control asserting that a naive estimator *fails* had nothing to catch. The CJK and
emoji sections were too small a share of the document. It now carries enough of both that
`chars / 4` is **-34%** on it, which is the point of the file existing.

The estimator was **not** retuned afterwards. Its constants were fitted before this
content was written, and it holds at -4.5% on the harder document — so that number is a
generalization result rather than a fit.

## These are frozen copies, not live reads

Documents 01–04 are copies of files that `driftgate sync` regenerates. A test that read
them from their real locations would have its input change under it whenever a rule was
edited — and a test whose input drifts is a test whose failure means nothing.

`.gitattributes` carries `fixtures/** -text` and `fixtures/**` is in `.prettierignore`, so
these keep their exact bytes. That matters most for `05-adversarial.md`, whose final
section is CRLF on purpose.
