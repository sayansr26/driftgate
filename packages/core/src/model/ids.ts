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
