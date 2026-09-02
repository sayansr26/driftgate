import type { AdapterDocs, SourceLink } from '@driftgate/adapter-kit';

const GITHUB_REPO_INSTRUCTIONS: SourceLink = {
  url: 'https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions',
  title: 'GitHub Docs — Adding repository custom instructions for GitHub Copilot',
  retrieved: '2026-09-02',
};

const VSCODE_CUSTOM_INSTRUCTIONS: SourceLink = {
  url: 'https://code.visualstudio.com/docs/copilot/customization/custom-instructions',
  title: 'Visual Studio Code — Use custom instructions in VS Code',
  retrieved: '2026-09-02',
};

/**
 * Encoded precedence knowledge for GitHub Copilot.
 *
 * Copilot is the tool this data exists for. It has **three** competing repository
 * instruction mechanisms, they are additive rather than exclusive, and two of them are
 * files other adapters in this repository also generate — so "which file wins" is the
 * wrong question and "which files are all being sent at once" is the right one. Nothing
 * in Copilot's own UI says that, which is what makes it worth writing down.
 *
 * The ranking below is by specificity, and it is the ranking `doctor` reports. It is not
 * an override chain: when a path-specific file matches, GitHub's documentation is explicit
 * that the repository-wide file is used *as well*.
 */
export const docs: AdapterDocs = {
  toolName: 'GitHub Copilot',
  homepage: 'https://docs.github.com/en/copilot',
  verifiedAgainst: {
    version: 'GitHub Docs and VS Code docs as published 2026-09-02',
    date: '2026-09-02',
  },
  // GitHub's documentation is explicit that a matching path-specific file is applied *in addition to* the repository-wide one, and VS Code reads AGENTS.md and CLAUDE.md on top of both.
  resolution: 'additive',
  files: [
    {
      pattern: '.github/instructions/*.instructions.md',
      scope: 'project',
      role: 'instructions',
      managed: true,
      description:
        'Mechanism 1 of 3 — path-specific instructions. Applied only when the file being worked on matches the `applyTo` glob, and applied *in addition to* the repository-wide file, not instead of it. Driftgate generates one of these per glob-scoped canonical rule.',
      source: GITHUB_REPO_INSTRUCTIONS,
    },
    {
      pattern: '.github/copilot-instructions.md',
      scope: 'project',
      role: 'instructions',
      managed: true,
      description:
        'Mechanism 2 of 3 — repository-wide instructions, always on for every request in the repository. Driftgate generates this from the canonical rules that carry no globs.',
      source: GITHUB_REPO_INSTRUCTIONS,
    },
    {
      pattern: 'AGENTS.md',
      scope: 'project',
      role: 'instructions',
      managed: false,
      nesting: 'nearest-wins',
      description:
        'Mechanism 3 of 3 — the cross-vendor agent file, also read by Copilot, with the nearest one in the directory tree taking precedence. Driftgate writes it from the **codex** adapter, never from this one: two adapters generating one path is an E_ARTIFACT_PATH_CONFLICT by design.',
      source: GITHUB_REPO_INSTRUCTIONS,
    },
    {
      pattern: 'CLAUDE.md',
      scope: 'project',
      role: 'instructions',
      managed: false,
      description:
        'VS Code additionally reads CLAUDE.md (root, .claude/, or ~/.claude/) for Claude-tool compatibility. Owned by the claude-code adapter here, and listed so `doctor` can account for a file Copilot loads that nothing in Copilot’s own documentation mentions.',
      source: VSCODE_CUSTOM_INSTRUCTIONS,
    },
    {
      pattern: '~/.copilot/instructions/*.instructions.md',
      scope: 'global',
      role: 'instructions',
      managed: false,
      description:
        'User-level path-specific instructions, applied across projects and ranked above repository instructions. Read-only context for `doctor`: Driftgate never writes outside the repository.',
      source: VSCODE_CUSTOM_INSTRUCTIONS,
    },
  ],
  limits: {
    note: 'No byte cap is documented in the GitHub or VS Code instruction documentation cited above. The relevant cost is not a cap but the additive loading described in the notes below: the repository-wide file, any matching path-specific file, and AGENTS.md are all sent together.',
  },
  notes: [
    {
      level: 'warn',
      message:
        'The three mechanisms are additive, not exclusive. Enabling the copilot, codex and claude-code adapters together means Copilot loads the same canonical rules from .github/copilot-instructions.md, AGENTS.md and CLAUDE.md at once — correct output from three adapters, and roughly three times the tokens. This is the case `doctor` exists to make visible.',
      source: GITHUB_REPO_INSTRUCTIONS,
    },
    {
      level: 'info',
      message:
        'Precedence across scopes runs personal instructions → repository instructions → organization instructions, and every applicable set is supplied to the model. Repository instructions cannot override a personal instruction.',
      source: GITHUB_REPO_INSTRUCTIONS,
    },
    {
      level: 'info',
      message:
        '`applyTo` is a single quoted string, and multiple patterns are comma-separated inside it — not a YAML sequence. A YAML list parses cleanly and then matches nothing, which is the failure this adapter’s renderer is hand-written to avoid.',
      source: VSCODE_CUSTOM_INSTRUCTIONS,
    },
    {
      level: 'info',
      message:
        'Driftgate writes instructions only. Prompt files (`.github/prompts/*.prompt.md`) and chat modes are a different surface — user-invoked rather than always-on — and generating them is deliberately out of scope for v0.',
      source: VSCODE_CUSTOM_INSTRUCTIONS,
    },
  ],
};
