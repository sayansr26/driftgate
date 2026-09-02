/** An adapter's stable identifier, e.g. "claude-code". */
export type ToolId = string;

/** A canonical rule's stable identifier: NFC-normalized, POSIX, no extension. */
export type RuleId = string;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Where a piece of the model came from. Present on everything parsed. */
export interface SourceRef {
  /** Repo-relative, POSIX separators. */
  readonly file: string;
  /** 1-based. Absent for whole-file facts. */
  readonly line?: number;
  /** 1-based. */
  readonly column?: number;
  /** Dotted path of the offending field, e.g. "tools[1].id". */
  readonly field?: string;
}

export function formatSourceRef(ref: SourceRef): string {
  let out = ref.file;
  if (ref.line !== undefined) {
    out += `:${ref.line}`;
    if (ref.column !== undefined) out += `:${ref.column}`;
  }
  return out;
}

/**
 * A rule id flattened to one path segment: `frontend/react` -> `frontend-react`.
 *
 * Lives here rather than in an adapter because more than one tool keeps its rules in a
 * single flat directory — Cursor's `.cursor/rules/` and Copilot's `.github/instructions/`
 * — and two adapters deriving "the filename for this rule" independently is how they come
 * to disagree about the same rule. Callers must still detect collisions: two ids can slug
 * to one name, and silently dropping one rule's content is the failure this enables.
 */
export function slugForId(id: RuleId): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
