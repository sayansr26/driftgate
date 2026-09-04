import { estimateTokens } from '../tokens/estimate.js';
import { hashContents } from '../state/state.js';
import { compareCodepoint } from '../render/order.js';
import { basenamePosix, dirnamePosix } from '../fs/paths.js';
import type { AdapterDocs, FileResolution, PrecedenceEntry } from '../adapter/docs.js';
import type { DiskComparison } from '../state/compare.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { ToolDetection } from '../detect/types.js';
import type { VerifyStatus } from '../pipeline/verify.js';
import type { ToolId } from '../model/ids.js';
import type { FileDiagnosis, FileSyncStatus } from './types.js';

/** One resolved file, measured. The unit both the table and the warnings are built from. */
export interface Measured {
  readonly path: string;
  readonly bytes: number;
  readonly tokens: number;
  readonly hash?: string;
  readonly status: FileSyncStatus;
  readonly loaded: boolean;
  readonly rank: number;
}

export interface ResolveContext {
  readonly fs: ReadOnlyFileSystem;
  readonly globalFs?: ReadOnlyFileSystem;
  readonly detection: ToolDetection;
  readonly comparison: DiskComparison;
  /**
   * `verifyPlan`'s verdict per planned path: disk against the *render*. `comparison`
   * answers a different question — disk against the *record* — and only the two together
   * can tell a stale artifact from a clean one (T079).
   */
  readonly verdicts: ReadonlyMap<string, VerifyStatus>;
  readonly managedBy: ReadonlyMap<string, ToolId>;
  readonly symlinks: SymlinkProbe;
}

export interface ResolvedTool {
  readonly files: readonly FileDiagnosis[];
  readonly loaded: readonly Measured[];
}

/**
 * Turn one tool's declared `AdapterDocs.files` into what is actually on disk, measured.
 *
 * Declared order is preserved throughout and never sorted. `AdapterDocs.files` is ordered
 * on purpose — under `override` index 0 wins, under `additive` the order ranks specificity
 * — and tidying it would destroy the one fact this whole feature exists to surface.
 */
export async function resolveTool(docs: AdapterDocs, ctx: ResolveContext): Promise<ResolvedTool> {
  const resolution: FileResolution = docs.resolution ?? 'override';

  // Two declared entries can resolve to one file. Gemini declares both `**/GEMINI.md`
  // (nested) and `GEMINI.md` (project, managed, all-merged), which overlap exactly —
  // without deduplication every shared file was measured twice, and the duplicate-load
  // warning reported a tool as duplicating its own output against itself.
  //
  // The owner is the entry that names the path *literally*, and only failing that the
  // lowest-ranked entry that matched. Rank alone would hand the root `GEMINI.md` to the
  // glob and report the file Driftgate actually generates as `absent`, which is the
  // opposite of the fact the row exists to state.
  const found: Measured[][] = [];
  for (const [rank, entry] of docs.files.entries())
    found.push(await measureEntry(entry, rank, ctx));

  const owner = new Map<string, number>();
  for (const [i, entry] of docs.files.entries()) {
    for (const m of found[i] ?? []) {
      const current = owner.get(m.path);
      const literal = m.path === entry.pattern;
      if (current === undefined || (literal && docs.files[current]?.pattern !== m.path)) {
        owner.set(m.path, i);
      }
    }
  }
  const measurements = found.map((list, i) => list.filter((m) => owner.get(m.path) === i));

  const shadowed = decideShadowed(docs.files, measurements, resolution);
  // Under `first-match` the tool stops at the first file that exists, so a shadowed entry
  // is not merely outranked — it is never opened. `loaded` has to say so, or the token
  // total bills the user for eight files Zed does not read.
  const unread = resolution === 'first-match';

  const files: FileDiagnosis[] = docs.files.map((entry, i) => {
    const found = measurements[i] ?? [];
    const hashes = found.map((m) => m.hash).filter((h): h is string => h !== undefined);
    const only = hashes.length === 1 ? hashes[0] : undefined;
    const owner = ctx.managedBy.get(entry.pattern);
    return {
      pattern: entry.pattern,
      rank: i,
      paths: found.map((m) => m.path),
      scope: entry.scope,
      role: entry.role,
      managed: entry.managed,
      ...(owner === undefined ? {} : { managedBy: owner }),
      loaded: found.some((m) => m.loaded) && !(unread && (shadowed[i] ?? false)),
      shadowed: shadowed[i] ?? false,
      status: aggregateStatus(found, entry, ctx.detection),
      nested: found.filter((m) => m.path !== entry.pattern).length,
      bytes: found.reduce((n, m) => n + m.bytes, 0),
      tokens: found.reduce((n, m) => n + m.tokens, 0),
      ...(only === undefined ? {} : { contentHash: only }),
    };
  });

  // Narrowed by entry, not only per file. `loadedCount`, `loadedTokens` and every warning
  // that takes a token total read *this* list, so narrowing `FileDiagnosis.loaded` alone
  // left `doctor` still billing Zed for eight files it never opens — the row said one
  // thing and the header said another.
  const read = measurements
    .flatMap((list, i) => (unread && (shadowed[i] ?? false) ? [] : list))
    .filter((m) => m.loaded);

  return { files, loaded: read };
}

async function measureEntry(
  entry: PrecedenceEntry,
  rank: number,
  ctx: ResolveContext,
): Promise<Measured[]> {
  // Only `instructions` reaches the model. `settings` and the rest are configuration, and
  // a token budget that counts them is lying about the number people will screenshot.
  const loaded = entry.role === 'instructions';

  if (entry.scope === 'global') {
    // Global paths were already probed by the detection engine, under rules that stop it
    // ever walking the user's home directory. Re-resolving them here would be a second,
    // unreviewed way to touch $HOME.
    const status = ctx.detection.global.find((g) => g.pattern === entry.pattern);
    const out: Measured[] = [];
    for (const display of status?.matches ?? []) {
      out.push(await measureGlobal(display, rank, loaded, ctx.globalFs));
    }
    return out;
  }

  // A repo-wide walk is authorized by `nesting`, and by nothing else. Without this, a
  // pattern like `.cursorrules` would be searched for at every depth, and a nested copy
  // that Cursor genuinely does not read would be reported as read.
  const pattern =
    entry.scope === 'nested' || (entry.nesting !== undefined && entry.nesting !== 'root-only')
      ? nestedPattern(entry.pattern)
      : entry.pattern;

  const paths = pattern.includes('*')
    ? [...(await ctx.fs.glob(pattern))].sort(compareCodepoint)
    : (await ctx.fs.exists(pattern))
      ? [pattern]
      : [];

  const out: Measured[] = [];
  for (const path of paths) {
    await ctx.symlinks.check(path);
    let text: string | undefined;
    try {
      text = await ctx.fs.readFile(path);
    } catch {
      // Unreadable is reported as zero rather than taking the run down: `doctor` is the
      // command you reach for precisely when a repository is already in a bad state.
      text = undefined;
    }
    out.push({
      path,
      rank,
      loaded,
      bytes: text === undefined ? 0 : byteLength(text),
      tokens: text === undefined ? 0 : estimateTokens(text),
      ...(text === undefined ? {} : { hash: hashContents(text) }),
      status: statusOf(path, entry, ctx),
    });
  }
  return out;
}

/** `CLAUDE.md` -> `**` + `/CLAUDE.md`, keeping the root copy in scope too. */
function nestedPattern(pattern: string): string {
  return pattern.includes('/') ? pattern : `**/${pattern}`;
}

async function measureGlobal(
  display: string,
  rank: number,
  loaded: boolean,
  globalFs: ReadOnlyFileSystem | undefined,
): Promise<Measured> {
  const unread: Measured = {
    path: display,
    rank,
    loaded,
    bytes: 0,
    tokens: 0,
    status: 'unmanaged',
  };
  if (globalFs === undefined || !display.startsWith('~/')) return unread;
  try {
    const text = await globalFs.readFile(display.slice(2));
    return {
      path: display,
      rank,
      loaded,
      bytes: byteLength(text),
      tokens: estimateTokens(text),
      hash: hashContents(text),
      status: 'unmanaged',
    };
  } catch {
    // A directory, or EACCES. Either way it is present and uncounted, never a crash.
    return unread;
  }
}

/**
 * Under `override`, which entries lose a conflict to a nearer file?
 *
 * Grouped by (role, scope), not decided across the whole list: a `settings.json` does not
 * compete with an instruction file, and a user-level file is not superseded by a project
 * one. `override` means a nearer file replaces a further one *within one chain* — the
 * claude-code adapter's own comment says "for the same scope" — and flattening the chains
 * would mark `~/.claude/CLAUDE.md` as losing to a project `CLAUDE.md`, which is not what
 * the tool does.
 *
 * Shadowed is deliberately *not* the same as unloaded. The file is still sent and still
 * costs its tokens; it is its rules, not its bytes, that lose. Reporting a shadowed file
 * as unloaded would under-report a token total, which is the direction of error T024
 * rejected `chars / 4` for.
 */
function decideShadowed(
  entries: readonly PrecedenceEntry[],
  measurements: readonly Measured[][],
  resolution: FileResolution,
): boolean[] {
  const claimed = new Set<string>();
  return entries.map((entry, i) => {
    if ((measurements[i] ?? []).length === 0) return false;
    if (resolution === 'additive') return false;
    // `override` and `first-match` share this shape — the first present entry in a chain
    // wins — and differ only in whether the losers are still read. That is decided by
    // `loaded` at the call site, not here.
    const chain = `${entry.role} ${entry.scope}`;
    if (claimed.has(chain)) return true;
    claimed.add(chain);
    return false;
  });
}

function statusOf(path: string, entry: PrecedenceEntry, ctx: ResolveContext): FileSyncStatus {
  // `managed` is only this adapter's own claim. `managedBy` catches the case that matters
  // most here — a file another adapter generates, which is exactly what a tool reading
  // AGENTS.md or CLAUDE.md is doing.
  if (!entry.managed && !ctx.managedBy.has(entry.pattern)) return 'unmanaged';

  // `check`'s answer wins wherever it has one, so the two commands cannot describe one
  // file two ways. It has one for every planned path; a nested copy or a global file is
  // not planned, and falls through to the ownership answer below.
  const verdict = ctx.verdicts.get(path);
  if (verdict !== undefined) return VERDICT_STATUS[verdict];

  if (ctx.comparison.changed.includes(path)) return 'drifted';
  if (ctx.comparison.unmanaged.includes(path)) return 'unmanaged';
  if (ctx.comparison.missing.includes(path)) return 'missing';
  if (ctx.comparison.unchanged.includes(path)) return 'generated';
  return 'unmanaged';
}

/**
 * `check`'s vocabulary in `doctor`'s. Only the four statuses a *planned* path can carry
 * appear here: an orphan has no `PrecedenceEntry` to be a row of, and is reported by
 * `W_ORPHAN_FILE` instead.
 */
const VERDICT_STATUS: Record<VerifyStatus, FileSyncStatus> = {
  stale: 'stale',
  'hand-edited': 'drifted',
  unmanaged: 'unmanaged',
  missing: 'missing',
  orphaned: 'unmanaged',
  'orphan-hand-edited': 'unmanaged',
};

/** Worst first, so one drifted file inside a glob is never hidden behind four clean ones. */
const STATUS_RANK: Record<FileSyncStatus, number> = {
  drifted: 0,
  missing: 1,
  stale: 2,
  unmanaged: 3,
  generated: 4,
  'not-probed': 5,
  absent: 6,
};

function aggregateStatus(
  found: readonly Measured[],
  entry: PrecedenceEntry,
  detection: ToolDetection,
): FileSyncStatus {
  // The declared path is the one Driftgate has an opinion about; a nested copy it never
  // generated must not colour the answer. Without this, `CLAUDE.md` reported `unmanaged`
  // on this very repository because five unrelated copies under `fixtures/` outranked the
  // generated root file under worst-first.
  const declared = found.find((m) => m.path === entry.pattern);
  if (declared !== undefined) return declared.status;
  if (found.length === 0) {
    if (entry.scope !== 'global') return 'absent';
    const probe = detection.global.find((g) => g.pattern === entry.pattern)?.probe;
    // "We did not look" and "we looked and found nothing" are different claims, and the
    // detection engine already keeps them apart. Collapsing them here would undo that.
    return probe === 'skipped' || probe === 'unsupported' ? 'not-probed' : 'absent';
  }
  let worst: FileSyncStatus = 'absent';
  for (const m of found) if (STATUS_RANK[m.status] < STATUS_RANK[worst]) worst = m.status;
  return worst;
}

/**
 * Bytes of the normalized text, not of the file on disk.
 *
 * `TextEncoder` is a global, so this module still imports no `node:` anything. The choice
 * matters where it is used: `AdapterDocs.limits` is compared against this, and raw on-disk
 * size would make a documented cap fire on a CRLF checkout and not on an LF one for
 * byte-identical content — a platform-dependent answer, which is the determinism failure
 * this repository treats as P0.
 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Which config paths are symlinks?
 *
 * `DirEntry.kind` already carries this, so no new filesystem capability is needed — one
 * `listDir` per directory, memoized, rather than a stat per file. Symlinking one tool's
 * config at another's is the oldest workaround in this space and the one Driftgate exists
 * to replace, so naming it is the point of reporting it.
 */
export class SymlinkProbe {
  readonly #fs: ReadOnlyFileSystem;
  readonly #listings = new Map<string, Promise<ReadonlyMap<string, string>>>();
  readonly #symlinks = new Set<string>();

  constructor(fs: ReadOnlyFileSystem) {
    this.#fs = fs;
  }

  async check(path: string): Promise<void> {
    const dir = dirnamePosix(path);
    let listing = this.#listings.get(dir);
    if (listing === undefined) {
      listing = this.#list(dir);
      this.#listings.set(dir, listing);
    }
    if ((await listing).get(basenamePosix(path)) === 'symlink') this.#symlinks.add(path);
  }

  found(): readonly string[] {
    return [...this.#symlinks].sort(compareCodepoint);
  }

  async #list(dir: string): Promise<ReadonlyMap<string, string>> {
    try {
      const entries = await this.#fs.listDir(dir === '' ? '.' : dir);
      return new Map(entries.map((e) => [e.name, e.kind]));
    } catch {
      return new Map();
    }
  }
}
