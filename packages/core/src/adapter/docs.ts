export interface SourceLink {
  readonly url: string;
  readonly title: string;
  /** ISO yyyy-mm-dd on which the URL was actually read. */
  readonly retrieved: string;
}

export interface VerifiedAgainst {
  /** Tool version string as the tool itself reports it. */
  readonly version: string;
  readonly date: string;
}

export interface PrecedenceEntry {
  /** Literal path or glob, POSIX, e.g. `CLAUDE.md` or `.cursor/rules/*.mdc`. */
  readonly pattern: string;
  readonly scope: 'project' | 'global' | 'nested';
  readonly role: 'instructions' | 'mcp' | 'skills' | 'settings';
  /** Does Driftgate generate this file, or is it read-only context? */
  readonly managed: boolean;
  readonly nesting?: 'nearest-wins' | 'all-merged' | 'root-only';
  readonly description: string;
  readonly source: SourceLink;
}

/**
 * Whether one file supersedes the others, or they are all sent together.
 *
 * `'override'` is the default because it is what a reader assumes, and stating the
 * assumption is cheaper than a field every adapter has to set.
 */
export type FileResolution = 'override' | 'additive';

export interface DocNote {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly source?: SourceLink;
}

/**
 * The encoded precedence knowledge for one tool: which files it reads, in what order,
 * project versus global, how nesting resolves, and what the size limits are.
 *
 * This is the project's actual moat — incumbents already sync files, but nobody has
 * written down what each tool truly loads. Treat it as versioned data, not comments:
 * every claim carries a source URL and the tool version it was verified against, so a
 * reviewer can check it and a stale entry is visible rather than silently wrong.
 * Powers `doctor` (T026/T027) and the per-tool docs pages (T065).
 */
export interface AdapterDocs {
  readonly toolName: string;
  readonly homepage: string;
  readonly verifiedAgainst: VerifiedAgainst;
  /**
   * How the tool combines the files below. Defaults to `'override'` when absent.
   *
   * This field exists because "highest precedence first" was quietly describing two
   * different behaviours. For Claude Code and Cursor a nearer file *replaces* a further
   * one, so index 0 is the only one that matters. For Copilot, Codex and Gemini every
   * matching file is sent *at once* — Copilot's own documentation is explicit that a
   * path-specific file is applied **in addition to** the repository-wide one — so the
   * order ranks specificity, not authority, and a reader who assumes override semantics
   * cannot explain why a rule they deleted still applies.
   *
   * The distinction is what `doctor` needs to answer "which files are all being sent at
   * once", which is the question T078 records: with all five adapters enabled, `CLAUDE.md`,
   * `AGENTS.md` and `GEMINI.md` are byte-identical here and Copilot loads three of them
   * together. Deriving that warning from this field rather than hardcoding it for Copilot
   * is what makes a sixth adapter covered without a code change.
   */
  readonly resolution?: FileResolution;
  /**
   * Ordered. Under `'override'` this is highest-precedence-first and index 0 wins; under
   * `'additive'` every entry is loaded and the order is most-specific-first.
   */
  readonly files: readonly PrecedenceEntry[];
  readonly limits?: {
    readonly maxBytesPerFile?: number;
    readonly maxTotalBytes?: number;
    readonly note?: string;
  };
  readonly notes?: readonly DocNote[];
}
