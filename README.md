# Driftgate

One source of truth for your AI coding agents.

Driftgate keeps `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.github/copilot-instructions.md`
and the rest generated from a single canonical `.driftgate/` directory — and, more
importantly, **verifies** they have not drifted:

- `driftgate sync` — regenerate every enabled tool's config from canonical.
- `driftgate check` — regenerate in memory, diff against disk, exit 1 on drift. Read-only.
- `driftgate doctor` — show which instruction files each tool actually reads, in what
  order, and roughly what they cost in tokens.

**Zero network calls. Zero telemetry.** Not as a setting — as a tested invariant.

> Status: pre-release, under active development. See `docs/rfc-0001-canonical-format.md`
> for the canonical format and `CONTRIBUTING.md` for how to add an adapter.

MIT licensed.
