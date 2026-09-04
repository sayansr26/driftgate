/**
 * The four spellings of a tool id, derived once so no template invents its own.
 *
 * `claude-code` is the id, `claudeCode` the exported binding, `Claude Code` the display
 * name, and `CLAUDE-CODE.md` the artifact a concatenating adapter writes. Getting these
 * to disagree is how a scaffold produces a package that does not compile.
 */
export interface ToolNames {
  readonly id: string;
  readonly binding: string;
  readonly title: string;
  readonly artifact: string;
  readonly constant: string;
  readonly dotDir: string;
  readonly packageName: string;
}

/** A tool id is a package directory name: lowercase, kebab-case, no path separators. */
export const TOOL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function toolNames(id: string): ToolNames {
  const parts = id.split('-');
  const artifact = `${id.toUpperCase()}.md`;
  return {
    id,
    binding: parts
      .map((p, i) => (i === 0 ? p : `${p.charAt(0).toUpperCase()}${p.slice(1)}`))
      .join(''),
    title: parts.map((p) => `${p.charAt(0).toUpperCase()}${p.slice(1)}`).join(' '),
    artifact,
    constant: `${id.toUpperCase().replace(/-/g, '_')}_MD`,
    dotDir: `.${id}`,
    packageName: `@driftgate/adapter-${id}`,
  };
}
