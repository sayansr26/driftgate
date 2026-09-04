import type { ToolId } from '../model/ids.js';
import type { Canonical } from '../model/canonical.js';
import type { AdapterContext } from './context.js';
import type { Artifact } from './artifact.js';
import type { AdapterDocs } from './docs.js';
import { ADAPTER_API_VERSION } from './context.js';

export interface DetectResult {
  readonly detected: boolean;
  /**
   * Repo-relative POSIX paths that triggered detection, sorted.
   *
   * `doctor` has to explain *why* it thinks a tool is in use — "detected Cursor"
   * with no evidence is exactly the unfalsifiable output the doctor exists to
   * replace. Returning the evidence rather than a bare boolean is a deliberate
   * departure from the shape recorded in memory-bank/07-api-documentation.md, made
   * now because this contract freezes at T011 and widening a return type afterwards
   * breaks every external adapter.
   */
  readonly evidence: readonly string[];
}

/**
 * The public adapter contract, and the most important stability boundary in the
 * project: external contributors write against it, so breaking it breaks them.
 *
 * Adapters are pure. No network, no process spawning, no global state, no writes.
 * They read, and they return values.
 */
/**
 * What `read()` returns: canonical content, plus anything the importer needs to say.
 *
 * `warnings` was added at T048 and is **optional**, so every adapter written against v1
 * still satisfies this and no `ADAPTER_API_VERSION` bump is owed — the policy in
 * `docs/adapter-api-v1.md`, and the reason `Exact<A, B>` cannot see an added optional
 * member (recorded at T011).
 *
 * It exists because MCP import can legitimately *not* import something — a server holding
 * a literal that is not a credential, a `${NAME:-default}` reference, a `${input:}` — and
 * an adapter that silently returned fewer servers than the file contains would be exactly
 * the quiet loss this project refuses everywhere else. Strings rather than
 * `RulegateError`s because these are not failures: `init` prints them and continues.
 *
 * **Never quote a value in one.** A message naming the secret would print it into a CI
 * log — T044's failure, committed to a different file.
 */
export type ImportResult = Partial<Canonical> & {
  readonly warnings?: readonly string[];
};

export interface Adapter {
  /** Stable kebab-case id, e.g. "claude-code". Matches the npm package suffix. */
  readonly name: ToolId;
  readonly apiVersion: typeof ADAPTER_API_VERSION;

  /** Must never write, and must never look outside `ctx.repoRoot`. */
  detect(ctx: AdapterContext): Promise<DetectResult>;

  /**
   * Native config -> canonical. Must be lossless: content Rulegate does not
   * understand is preserved verbatim rather than dropped, because a first-run import
   * that quietly discards someone's rules is trust-fatal (PRD §11).
   */
  read(ctx: AdapterContext): Promise<ImportResult>;

  /** Canonical -> artifacts. Deterministic: same input, byte-identical output. */
  write(ctx: AdapterContext): Promise<readonly Artifact[]>;

  readonly docs: AdapterDocs;
}

export const NOT_DETECTED: DetectResult = { detected: false, evidence: [] };

export function detected(evidence: readonly string[]): DetectResult {
  return { detected: evidence.length > 0, evidence: [...evidence].sort() };
}

export { ADAPTER_API_VERSION };
