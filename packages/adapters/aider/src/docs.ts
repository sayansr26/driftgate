import type { AdapterDocs, SourceLink } from '@driftgate/adapter-kit';

const CONVENTIONS_DOCS: SourceLink = {
  url: 'https://aider.chat/docs/usage/conventions.html',
  title: 'Aider — Specifying coding conventions',
  retrieved: '2026-09-04',
};

/**
 * What Aider actually loads — and the answer is **nothing, unless told to**.
 *
 * Aider is the odd one in the roster and that is what makes it a good `doctor` case. It has
 * no automatic instruction file at all: it reads whatever `.aider.conf.yml`'s `read:` key
 * names, or whatever `--read` / `/read` is given. So a generated `CONVENTIONS.md` that the
 * config never mentions is loaded by nothing — and Driftgate would otherwise report the
 * repository as perfectly in sync while Aider reads none of it.
 *
 * That hazard is carried here as **data**, not as code: a `warn`-level note `doctor` already
 * surfaces as `W_TOOL_NOTE`, plus `.aider.conf.yml` declared as an unmanaged `settings`
 * entry so the report shows whether it is even present. It is the same shape as Gemini's
 * `context.fileName`, handled the same way, and it adds **zero lines to `packages/core`** —
 * a generic "is the generated file referenced?" check would need YAML, JSONC and TOML
 * reading in core, and designing that field from a sample of one is how tool-specific logic
 * arrives in core wearing a generic name.
 */
export const docs: AdapterDocs = {
  toolName: 'Aider',
  homepage: 'https://aider.chat',
  verifiedAgainst: { version: 'Aider docs as published 2026-09-04', date: '2026-09-04' },
  // Every file named by `read:` is loaded; there is no chain and nothing is superseded.
  resolution: 'additive',
  files: [
    {
      pattern: 'CONVENTIONS.md',
      scope: 'project',
      role: 'instructions',
      managed: true,
      description:
        'The conventional filename, and what Driftgate generates. Aider loads it only when .aider.conf.yml names it under `read:`, or when it is passed with --read / /read. The name is a convention, not a requirement.',
      source: CONVENTIONS_DOCS,
    },
    {
      pattern: '.aider.conf.yml',
      scope: 'project',
      role: 'settings',
      managed: false,
      description:
        'Aider’s configuration, and the only thing that decides whether CONVENTIONS.md is read at all. Driftgate never writes it: it is the user’s file and it can hold literal API keys.',
      source: CONVENTIONS_DOCS,
    },
  ],
  limits: { note: 'Aider publishes no size cap for a conventions file.' },
  notes: [
    {
      level: 'warn',
      message:
        'Aider loads no instruction file automatically. A generated CONVENTIONS.md is read only if .aider.conf.yml names it under `read:` (or it is passed with --read). Without that line the file is in sync, correct, and loaded by nothing — check the config, not just the file.',
      source: CONVENTIONS_DOCS,
    },
    {
      level: 'info',
      message:
        'Driftgate never writes .aider.conf.yml, under any flag. It is the user’s file, it can hold literal API keys, and owning it would mean owning every Aider setting — the trade-off the codex adapter makes for config.toml and this one deliberately does not.',
      source: CONVENTIONS_DOCS,
    },
    {
      level: 'info',
      message:
        'Whether `read:` merges or replaces across Aider’s home, git-root and cwd config files is undocumented. If it replaces, a repository-level config silently drops a user’s global conventions — worth knowing before relying on both.',
      source: CONVENTIONS_DOCS,
    },
  ],
};
