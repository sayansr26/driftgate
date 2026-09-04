import type { RulegateError } from '../model/errors.js';
import type { FileResolution, PrecedenceEntry, SourceLink } from '../adapter/docs.js';
import type { ToolId } from '../model/ids.js';

/**
 * What Rulegate knows about one file a tool will read.
 *
 * `absent`, `unmanaged` and `not-probed` are three different answers and are deliberately
 * kept apart. `compareToDisk` already separates `untracked` from `unmanaged` for the same
 * reason: "we would generate this and nothing is there", "somebody else's bytes are there"
 * and "we did not look" call for different advice, and a report that collapses them is
 * confidently wrong in the place a user most needs it right.
 */
export type FileSyncStatus =
  /** Rulegate generates it, it is on disk, and the bytes match what we would render. */
  | 'generated'
  /** Rulegate generates it, it is on disk, and the bytes differ: hand-edited. */
  | 'drifted'
  /**
   * Rulegate generates it, the bytes are still the ones we wrote, and the canonical
   * source has moved on: `sync` would rewrite it. Distinct from `drifted` because the
   * recovery differs — nothing of the user's is at stake, they just have not run `sync`.
   *
   * It exists because `doctor` used to answer this case from `compareToDisk` alone, which
   * asks whether the bytes match the *record*, and so reported a stale artifact as
   * `generated` while `check` called it `stale` (T079).
   */
  | 'stale'
  /** Rulegate would generate it and it is not on disk. */
  | 'missing'
  /** The tool reads it, Rulegate does not generate it, and it exists. */
  | 'unmanaged'
  /** The declared pattern matches nothing. */
  | 'absent'
  /** Global scope, and no home filesystem was supplied. Not the same as `absent`. */
  | 'not-probed';

export interface FileDiagnosis {
  /** Exactly as declared in `AdapterDocs.files` — a literal path or a glob. */
  readonly pattern: string;
  /** Index into `AdapterDocs.files`: this entry's declared precedence position. */
  readonly rank: number;
  /**
   * What the pattern actually resolved to: repo-relative POSIX for project and nested
   * scopes, `~/`-prefixed for global ones. Never absolute — a `DoctorReport` is meant to
   * be pasted into an issue, and `repoRoot` is the only absolute path it may contain.
   */
  readonly paths: readonly string[];
  readonly scope: PrecedenceEntry['scope'];
  readonly role: PrecedenceEntry['role'];
  readonly managed: boolean;
  /**
   * Which adapter generates this file, when one does.
   *
   * Note this is *not* `managed`, which only says "generated for the tool whose docs this
   * entry belongs to". Copilot's `AGENTS.md` entry is `managed: false` and yet the file is
   * very much generated — by the Codex adapter. Attribution therefore needs a cross-adapter
   * scan, and that difference is the whole substance of the duplicate-load warning.
   */
  readonly managedBy?: ToolId;
  /**
   * Is this file sent to the model?
   *
   * True for every present `instructions` file. Deliberately *not* narrowed by
   * `resolution`: see `shadowed`. Files with any other role are configuration rather than
   * context and are excluded, because counting `.claude/settings.json` into a token budget
   * would be a plain falsehood on the one output people screenshot.
   */
  readonly loaded: boolean;
  /**
   * Loaded, but outranked by a nearer file under an `override` resolution — its rules lose
   * a conflict, while still costing what they cost.
   *
   * This is what `resolution` actually decides. It is not the same as "not loaded": see
   * the note on `AdapterDocs.resolution` about the two behaviours that field was quietly
   * describing, of which this is the residue.
   */
  readonly shadowed: boolean;
  readonly status: FileSyncStatus;
  /** How many of `paths` are copies below the declared path rather than the path itself. */
  readonly nested: number;
  /**
   * Size of the EOL-normalized, BOM-stripped content — the same normalization every hash
   * and token count here uses, so a CRLF checkout and an LF checkout of one repository get
   * the same answer against a documented byte cap. Raw on-disk size would make
   * `W_OVER_LIMIT` fire on Windows and not on Linux for identical content.
   */
  readonly bytes: number;
  /** Always approximate; every display of it carries a `~`. */
  readonly tokens: number;
  /** `hashContents` of the file, present only when exactly one path resolved and was read. */
  readonly contentHash?: string;
}

export interface ToolDiagnosis {
  readonly name: ToolId;
  /** The vendor's own name for the tool, from `AdapterDocs.toolName`. */
  readonly toolName: string;
  readonly detected: boolean;
  /** Enabled in `.rulegate/rulegate.yaml`. A tool can be detected and not enabled. */
  readonly enabled: boolean;
  /** Repo-relative POSIX, sorted — straight from the adapter's `DetectResult`. */
  readonly evidence: readonly string[];
  /** Defaulted from `AdapterDocs.resolution ?? 'override'`, so callers never re-default. */
  readonly resolution: FileResolution;
  /**
   * In **declared** order, never sorted. `AdapterDocs.files` is ordered on purpose and
   * that order is the single piece of information this whole feature exists to surface.
   */
  readonly files: readonly FileDiagnosis[];
  readonly loadedCount: number;
  readonly loadedBytes: number;
  readonly loadedTokens: number;
  /** Set when the adapter's `detect()` threw or its `apiVersion` is unreadable. */
  readonly failed?: RulegateError;
}

export type DoctorWarningCode =
  /** A generated or instruction-shaped file that nothing reads. */
  | 'W_ORPHAN_FILE'
  /** A tool's loaded files exceed a documented cap in its `AdapterDocs.limits`. */
  | 'W_OVER_LIMIT'
  /** A config path is a symlink — the workaround `doctor` exists to name. */
  | 'W_SYMLINK'
  /** One tool loads the same content more than once (T078). */
  | 'W_DUPLICATE_LOAD'
  /** A `warn`-level `DocNote` from the tool's own encoded documentation. */
  | 'W_TOOL_NOTE';

export interface DoctorWarning {
  readonly code: DoctorWarningCode;
  readonly tool?: ToolId;
  /** Repo-relative or `~/`-prefixed, sorted by codepoint. Empty for tool-wide notes. */
  readonly paths: readonly string[];
  readonly message: string;
  /** Carried through from `DocNote.source` so a claim stays checkable. */
  readonly source?: SourceLink;
}

export interface DoctorReport {
  /**
   * The only absolute path permitted anywhere in this report — the same rule
   * `DetectionReport` follows, and for the same reason: this output is destined for
   * screenshots and issue comments.
   */
  readonly repoRoot: string;
  /**
   * Does this repository have a canonical source at all?
   *
   * `false` is an ordinary answer, not a failure. Reporting on a repository that has never
   * adopted Rulegate is `doctor`'s primary job and the first thing `init` will ask of it.
   */
  readonly adopted: boolean;
  /** False when no global filesystem was supplied. "Did not look" is not "found nothing". */
  readonly globalProbed: boolean;
  /** Sorted by tool id, so registry order cannot reach the output. */
  readonly tools: readonly ToolDiagnosis[];
  /** Sorted by code, then tool, then first path. */
  readonly warnings: readonly DoctorWarning[];
  /** Fatal problems only. A missing canonical source is not one of them. */
  readonly errors: readonly RulegateError[];
}
