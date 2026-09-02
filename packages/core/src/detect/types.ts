import type { DriftgateError } from '../model/errors.js';
import type { PrecedenceEntry } from '../adapter/docs.js';
import type { ToolId } from '../model/ids.js';

/** How a declared global pattern was resolved into something probeable. */
export type GlobalProbeKind =
  /** A literal path: one `exists()` call. */
  | 'literal'
  /** A `*` in the final segment: one `listDir()` of the parent. */
  | 'one-level-glob'
  /** Contains `**` or `..`. Recorded, never walked — see `parseGlobalPattern`. */
  | 'unsupported'
  /** No global filesystem was supplied, so nothing outside the repository was touched. */
  | 'skipped';

export interface GlobalFileStatus {
  /** Exactly as declared in `AdapterDocs.files`, e.g. `~/.claude/CLAUDE.md`. */
  readonly pattern: string;
  readonly role: PrecedenceEntry['role'];
  readonly present: boolean;
  /**
   * What was found, `~/`-prefixed and sorted by codepoint. Deliberately *not* absolute:
   * an absolute path here is machine-identifying, and this data is destined for `doctor`
   * output that people paste into issues.
   */
  readonly matches: readonly string[];
  readonly probe: GlobalProbeKind;
}

export interface ToolDetection {
  readonly name: ToolId;
  readonly detected: boolean;
  /** Repo-relative POSIX, sorted — straight from the adapter's `DetectResult`. */
  readonly evidence: readonly string[];
  /**
   * In **declared order**, not sorted. `AdapterDocs.files` is documented "highest
   * precedence first: index 0 wins", so sorting this for tidiness would destroy the
   * one piece of information the whole feature exists to surface.
   */
  readonly global: readonly GlobalFileStatus[];
  /** Set when this adapter's `detect()` threw or its `apiVersion` is unreadable. */
  readonly failed?: DriftgateError;
}

export interface DetectionReport {
  /**
   * The only absolute path permitted anywhere in this report. Everything else is
   * repo-relative or `~/`-prefixed, so a report can be pasted into an issue without
   * leaking a username or a directory layout.
   */
  readonly repoRoot: string;
  /** Sorted by tool id, so registry order cannot reach the output. */
  readonly tools: readonly ToolDetection[];
  /** False when no global filesystem was supplied. "Did not look" is not "found nothing". */
  readonly globalProbed: boolean;
}
