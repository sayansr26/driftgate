import type { AdapterDocs } from '@driftgate/adapter-kit';

const MCP_DOCS = {
  url: 'https://cursor.com/docs/context/mcp',
  title: 'Cursor — Model Context Protocol',
  retrieved: '2026-09-04',
} as const;

const RULES_DOCS = {
  url: 'https://docs.cursor.com/context/rules',
  title: 'Cursor — Rules',
  retrieved: '2026-09-01',
} as const;

export const docs: AdapterDocs = {
  toolName: 'Cursor',
  homepage: 'https://docs.cursor.com',
  verifiedAgainst: { version: '1.x', date: '2026-09-01' },
  // Rules are selected by scope and glob rather than concatenated wholesale.
  resolution: 'override',
  files: [
    {
      pattern: '.cursor/rules/*.mdc',
      scope: 'project',
      role: 'instructions',
      managed: true,
      nesting: 'nearest-wins',
      description:
        'Project rules. One file per rule, each with .mdc frontmatter carrying description, globs, and alwaysApply. Cursor also reads .cursor/rules directories nested in subdirectories.',
      source: RULES_DOCS,
    },
    {
      pattern: '.cursorrules',
      scope: 'project',
      role: 'instructions',
      managed: true,
      description:
        'Legacy single-file rules, superseded by .cursor/rules. Driftgate writes it only when `options.legacy` is true.',
      source: RULES_DOCS,
    },
    {
      pattern: '~/.cursor/rules',
      scope: 'global',
      role: 'instructions',
      managed: false,
      description:
        'User-level rules applied across projects. Read-only context for `doctor`; Driftgate never writes outside the repository.',
      source: RULES_DOCS,
    },
    {
      pattern: '.cursor/mcp.json',
      scope: 'project',
      role: 'mcp',
      managed: true,
      description:
        'Project MCP servers. The file Driftgate generates from .driftgate/mcp/servers.yaml.',
      source: MCP_DOCS,
    },
    {
      pattern: '~/.cursor/mcp.json',
      scope: 'global',
      role: 'mcp',
      managed: false,
      description:
        'User-level MCP servers, available in every project. Read-only context for `doctor`; Driftgate never writes outside the repository.',
      source: MCP_DOCS,
    },
  ],
  limits: {
    note: 'No byte cap is documented in the Cursor rules documentation cited above. Rules with `alwaysApply: true` enter every request, so the practical limit is the context window rather than a published threshold; glob-scoped `.mdc` files are only loaded when a matching file is open.',
  },
  notes: [
    {
      level: 'warn',
      message:
        'Cursor documents no `type` key for a remote MCP server, so an SSE endpoint and a streamable-HTTP one are both written as a bare `url`. A canonical `transport: sse` therefore survives into Claude Code’s .mcp.json and is lost here — the same shape of lossy mapping as the prose “Applies to:” line, recorded rather than left to be discovered.',
      source: MCP_DOCS,
    },
    {
      level: 'info',
      message:
        'Cursor interpolates ${env:NAME} (also ${workspaceFolder} and ${userHome}), where Claude Code uses a bare ${NAME}. The two MCP files look interchangeable and are not.',
      source: MCP_DOCS,
    },
    {
      level: 'warn',
      message:
        'Cursor’s .mdc frontmatter is not strict YAML: `globs` is a bare comma-joined string, an empty `globs` is written as a bare key, and `alwaysApply` is derived rather than authored. Rendering it through a YAML emitter produces plausible-looking output that Cursor interprets differently.',
      source: RULES_DOCS,
    },
    {
      level: 'info',
      message:
        'Generated .mdc filenames keep the canonical rule id, order prefix included, so each output traces back to exactly one canonical file and two rules with the same trailing name cannot collide.',
    },
    {
      level: 'info',
      message:
        'Cursor scopes rules natively via `globs`, so glob-scoped rules do not carry the prose "Applies to:" line that single-file targets such as CLAUDE.md require.',
    },
  ],
};
