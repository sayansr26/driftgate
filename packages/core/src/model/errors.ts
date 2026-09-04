import { formatSourceRef, type SourceRef } from './ids.js';

export type RulegateErrorCode =
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
  // hand-edited and refuse to write it, which reads as Rulegate being broken.
  | 'E_FORMATTER_CONFLICT'
  // `rulegate adapter new` refused rather than overwrite a path that already exists, or
  // patch one that does not (T028).
  | 'E_SCAFFOLD_CONFLICT'
  // `check --staged` needed the git index, and git could not answer. Two codes rather
  // than one: not being in a git working tree at all is a different situation from a
  // file that is simply not staged, and only the first is worth a hint about `--staged`.
  | 'E_GIT_UNAVAILABLE'
  | 'E_GIT_NOT_STAGED'
  | 'E_GIT_FAILED'
  | 'E_ADAPTER_FAILED'
  | 'E_ADAPTER_API_VERSION'
  // `.rulegate/mcp/servers.yaml` does not describe a server Rulegate can render (T043).
  | 'E_MCP_INVALID'
  // A value that should be an `env:` reference is a literal (T044). Its own code because
  // it is the one parse failure whose *message must not quote the offending value*.
  | 'E_LITERAL_SECRET'
  // A canonical MCP server is valid, and the target format has no way to say it (T047).
  //
  // **No longer raised by the Codex writer (T083)** — that path omits the server and names
  // it in the generated file instead, because failing the run took down every other
  // artifact too. The code stays: it is the right answer for a target that cannot degrade
  // at all, and removing it would make the next such case reach for something weaker.
  //
  // Distinct from `E_MCP_INVALID`, which means the *author* wrote something wrong. Here
  // the canonical file is correct and one destination cannot express it — Codex has no
  // variable substitution at all, so an `env:` reference under a key it cannot map is
  // inexpressible there and expressible everywhere else. Raised only where the loss would
  // be silent and wrong (a credential that never arrives); a loss that is merely lossy and
  // still functional, such as `transport: sse` on a target with no discriminator, is a
  // `warn` note in the adapter's `docs` instead.
  | 'E_MCP_UNREPRESENTABLE'
  // Something in somebody else's MCP config was not imported (T048). A **warning**, and
  // deliberately not an error: `runInit` writes nothing while `errors` is non-empty, so an
  // error here would make a new user's first command fail on a file Rulegate only read —
  // T077's shape. The server is absent from canonical and the reason is printed.
  | 'W_MCP_IMPORT'
  // The platform refused a path — Windows' 260-character limit, in practice (T069). Its own
  // code because the bare errno names no limit and suggests no action, and because it makes
  // `check` fail on one platform and pass on another for the same repository.
  | 'E_PATH_TOO_LONG'
  // A competing rule-sync tool held something Rulegate imports rules but not everything
  // from — MCP, skills, subagents (T054). A warning: `init` completes, and the user is told
  // what did not come across rather than discovering it when a server stops working.
  | 'W_INTEROP_NOT_IMPORTED';

export interface RulegateErrorInit {
  readonly code: RulegateErrorCode;
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
export class RulegateError extends Error {
  readonly code: RulegateErrorCode;
  readonly source: SourceRef | undefined;
  readonly hint: string | undefined;

  constructor(init: RulegateErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'RulegateError';
    this.code = init.code;
    this.source = init.source;
    this.hint = init.hint;
  }

  /** e.g. `.rulegate/rules/style.md:4:8  E_FRONTMATTER_INVALID  ...` plus a hint line. */
  format(): string {
    const where = this.source ? formatSourceRef(this.source) : '';
    const head = [where, this.code, this.message].filter((p) => p !== '').join('  ');
    return this.hint === undefined ? head : `${head}\n  hint: ${this.hint}`;
  }
}

export function isRulegateError(e: unknown): e is RulegateError {
  return e instanceof RulegateError;
}
