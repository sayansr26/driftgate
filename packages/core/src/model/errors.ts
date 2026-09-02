import { formatSourceRef, type SourceRef } from './ids.js';

export type DriftgateErrorCode =
  | 'E_NO_CANONICAL_SOURCE'
  | 'E_YAML_SYNTAX'
  | 'E_MANIFEST_INVALID'
  | 'E_FRONTMATTER_INVALID'
  | 'E_FRONTMATTER_UNTERMINATED'
  | 'E_RULE_ID_CONFLICT'
  | 'E_UNKNOWN_TOOL'
  | 'E_ARTIFACT_PATH_CONFLICT'
  | 'E_ARTIFACT_OVERWRITES_SOURCE'
  | 'E_PATH_ESCAPE'
  | 'E_STATE_INVALID'
  | 'E_HAND_EDITED'
  // A deletion was proposed for a path `state.json` does not record as ours. Unreachable
  // from `compareToDisk`, whose orphan set is built from state — it guards the one place
  // where being wrong means destroying somebody else's file (T020).
  | 'E_DELETE_UNRECORDED'
  // A formatter and a generator both claim a generated file. Raised as a warning by
  // `init` (T072): reformatting generated output makes the next `sync` report it as
  // hand-edited and refuse to write it, which reads as Driftgate being broken.
  | 'E_FORMATTER_CONFLICT'
  | 'E_ADAPTER_FAILED'
  | 'E_ADAPTER_API_VERSION';

export interface DriftgateErrorInit {
  readonly code: DriftgateErrorCode;
  readonly message: string;
  readonly source?: SourceRef;
  /** One actionable sentence, rendered on its own line as "hint: ...". */
  readonly hint?: string;
  readonly cause?: unknown;
}

/**
 * Every user-facing failure. Carries the file, line, and offending field so that a
 * malformed config produces an actionable message rather than a stack trace.
 */
export class DriftgateError extends Error {
  readonly code: DriftgateErrorCode;
  readonly source: SourceRef | undefined;
  readonly hint: string | undefined;

  constructor(init: DriftgateErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'DriftgateError';
    this.code = init.code;
    this.source = init.source;
    this.hint = init.hint;
  }

  /** e.g. `.driftgate/rules/style.md:4:8  E_FRONTMATTER_INVALID  ...` plus a hint line. */
  format(): string {
    const where = this.source ? formatSourceRef(this.source) : '';
    const head = [where, this.code, this.message].filter((p) => p !== '').join('  ');
    return this.hint === undefined ? head : `${head}\n  hint: ${this.hint}`;
  }
}

export function isDriftgateError(e: unknown): e is DriftgateError {
  return e instanceof DriftgateError;
}
