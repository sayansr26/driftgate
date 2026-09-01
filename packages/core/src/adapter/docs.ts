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
  /** Highest precedence first: index 0 wins. */
  readonly files: readonly PrecedenceEntry[];
  readonly limits?: {
    readonly maxBytesPerFile?: number;
    readonly maxTotalBytes?: number;
    readonly note?: string;
  };
  readonly notes?: readonly DocNote[];
}
