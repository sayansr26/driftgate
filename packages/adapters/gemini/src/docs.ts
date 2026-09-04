import type { AdapterDocs, SourceLink } from '@rulegate/adapter-kit';

const GEMINI_CONTEXT_DOCS: SourceLink = {
  url: 'https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html',
  title: 'Gemini CLI — Provide context with GEMINI.md files',
  retrieved: '2026-09-02',
};

/**
 * Encoded precedence knowledge for the Gemini CLI.
 *
 * Gemini's model is *concatenation*, not selection: every context file it finds is joined
 * and sent with each prompt, with the more specific ones later. So `files` ranked
 * highest-first here means "wins a conflict", not "is the only one read" — which is
 * exactly the distinction `doctor` exists to make visible, since a user who assumes
 * override semantics will not understand why a deleted-from-the-root rule still applies.
 */
export const docs: AdapterDocs = {
  toolName: 'Gemini CLI',
  homepage: 'https://google-gemini.github.io/gemini-cli/',
  verifiedAgainst: { version: 'CLI docs as published 2026-09-02', date: '2026-09-02' },
  // Gemini joins global, ancestor and subdirectory context files into every prompt; the ranking below says which wins a conflict, not which is read.
  resolution: 'additive',
  files: [
    {
      pattern: '**/GEMINI.md',
      scope: 'nested',
      role: 'instructions',
      managed: false,
      nesting: 'all-merged',
      description:
        'Component-level context. Gemini scans directories below the working directory, honouring .gitignore and .geminiignore, and appends what it finds. Rulegate writes only the root file; a nested one is somebody else’s.',
      source: GEMINI_CONTEXT_DOCS,
    },
    {
      pattern: 'GEMINI.md',
      scope: 'project',
      role: 'instructions',
      managed: true,
      nesting: 'all-merged',
      description:
        'The file Rulegate generates. Gemini walks from the working directory up to the project root (the directory holding .git) collecting these, then concatenates them — a nested file adds to this one rather than replacing it.',
      source: GEMINI_CONTEXT_DOCS,
    },
    {
      pattern: '~/.gemini/GEMINI.md',
      scope: 'global',
      role: 'instructions',
      managed: false,
      description:
        'User-wide context applied to every project, read before any repository file. Read-only context for `doctor`: Rulegate never writes outside the repository.',
      source: GEMINI_CONTEXT_DOCS,
    },
    {
      pattern: '.gemini/settings.json',
      scope: 'project',
      role: 'settings',
      managed: false,
      description:
        'Gemini CLI settings. `context.fileName` renames the context file, or accepts a list such as ["AGENTS.md", "CONTEXT.md", "GEMINI.md"] — which changes which files on disk this adapter’s output competes with.',
      source: GEMINI_CONTEXT_DOCS,
    },
  ],
  limits: {
    note: 'No byte cap is documented in the Gemini CLI documentation cited above. Gemini concatenates rather than selects — global, ancestor and subdirectory context files are all joined into every prompt — so the total grows with the number of files on the path, not just their size.',
  },
  notes: [
    {
      level: 'warn',
      message:
        'Gemini reads AGENTS.md only if `context.fileName` in .gemini/settings.json says so — it is a configured alias, not a built-in fallback. A repository that has set it and also enables the codex adapter gives Gemini the same rules twice, once from GEMINI.md and once from AGENTS.md. Rulegate does not read settings.json, so it cannot warn about this per-repo; `doctor` reports the setting rather than guessing.',
      source: GEMINI_CONTEXT_DOCS,
    },
    {
      level: 'info',
      message:
        'Gemini has no per-glob rule mechanism, so a glob-scoped canonical rule is rendered with an "Applies to:" line stating its scope in prose. Lossy, but visibly so; dropping the scope silently would turn a component-only rule into a repo-wide one.',
    },
    {
      level: 'info',
      message:
        'Everything found is concatenated into every prompt, so context files are a running token cost rather than a lookup. `/memory show` in the CLI prints the combined text, and the footer counts the loaded files.',
      source: GEMINI_CONTEXT_DOCS,
    },
  ],
};
