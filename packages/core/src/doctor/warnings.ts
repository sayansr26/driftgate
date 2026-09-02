import { compareCodepoint } from '../render/order.js';
import { matchesGlob } from '../fs/glob.js';
import { basenamePosix } from '../fs/paths.js';
import type { Adapter } from '../adapter/adapter.js';
import type { AdapterDocs } from '../adapter/docs.js';
import type { DiskComparison } from '../state/compare.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { ToolId } from '../model/ids.js';
import type { Measured } from './resolve.js';
import type { DoctorWarning, ToolDiagnosis } from './types.js';

/**
 * T078: one tool loading the same content more than once.
 *
 * Derived from the tool's declared `files`, the `managed` claims of *every* adapter, and
 * the bytes on disk — never from a list of tools known to have the problem. That is the
 * requirement rather than a stylistic preference: a sixth adapter that reads another
 * adapter's output gets this warning without a line of code, and a hardcoded rule would go
 * stale the first time a vendor changed its loading behaviour.
 *
 * Byte-identity is the test, not mere co-ownership, because it is the claim that survives
 * scrutiny: two adapters writing genuinely different files to a tool is not waste, and
 * saying it is would train people to ignore the warning.
 */
export function duplicateLoadWarnings(
  tool: ToolDiagnosis,
  loaded: readonly Measured[],
): DoctorWarning[] {
  const groups = new Map<string, Measured[]>();
  for (const m of loaded) {
    if (m.hash === undefined) continue;
    const group = groups.get(m.hash) ?? [];
    group.push(m);
    groups.set(m.hash, group);
  }

  const duplicated = [...groups.values()].filter((g) => g.length > 1);
  if (duplicated.length === 0) return [];

  const redundant = duplicated.reduce((n, g) => n + g.length - 1, 0);
  const wasted = duplicated.reduce((n, g) => n + (g[0]?.tokens ?? 0) * (g.length - 1), 0);
  const paths = duplicated.flatMap((g) => g.map((m) => m.path)).sort(compareCodepoint);

  return [
    {
      code: 'W_DUPLICATE_LOAD',
      tool: tool.name,
      paths,
      message:
        `${tool.toolName} will load ${tool.loadedCount} files ~${tool.loadedTokens} tokens, of which ` +
        `${redundant} ${redundant === 1 ? 'is a duplicate' : 'are duplicates'} of another adapter's ` +
        `output (${attribute(paths, tool).join(', ')}) — about ${wasted} tokens are paid twice.`,
    },
  ];
}

/**
 * Name who generated each duplicated file.
 *
 * `paths` itself stays a list of real paths — the CLI prints them and a test asserts every
 * warning path is one the report actually resolved — so the attribution lives in the
 * message rather than being spliced into the data.
 */
function attribute(paths: readonly string[], tool: ToolDiagnosis): string[] {
  return paths.map((path) => {
    const owner = tool.files.find((f) => f.paths.includes(path))?.managedBy;
    return owner === undefined || owner === tool.name ? path : `${path} from ${owner}`;
  });
}

/**
 * Loaded content that exceeds a cap the vendor actually documents.
 *
 * Strictly `>`: a file exactly at the cap is accepted, because that is what a cap means and
 * a boundary this warning gets wrong is a false alarm on correct output.
 */
export function overLimitWarnings(
  tool: ToolDiagnosis,
  docs: AdapterDocs,
  loaded: readonly Measured[],
): DoctorWarning[] {
  const limits = docs.limits;
  if (limits === undefined) return [];
  const out: DoctorWarning[] = [];

  const perFile = limits.maxBytesPerFile;
  if (perFile !== undefined) {
    const over = loaded.filter((m) => m.bytes > perFile);
    if (over.length > 0) {
      out.push({
        code: 'W_OVER_LIMIT',
        tool: tool.name,
        paths: over.map((m) => m.path).sort(compareCodepoint),
        message: `${tool.toolName} documents a ${perFile}-byte limit per file, and ${over.length} of the files it loads ${over.length === 1 ? 'exceeds' : 'exceed'} it. Content past the cap may be silently dropped.`,
      });
    }
  }

  const total = limits.maxTotalBytes;
  if (total !== undefined && tool.loadedBytes > total) {
    out.push({
      code: 'W_OVER_LIMIT',
      tool: tool.name,
      paths: loaded.map((m) => m.path).sort(compareCodepoint),
      message: `${tool.toolName} documents a ${total}-byte total limit and will load ${tool.loadedBytes} bytes. Content past the cap may be silently dropped.`,
    });
  }

  return out;
}

export function symlinkWarnings(paths: readonly string[]): DoctorWarning[] {
  return paths.map((path) => ({
    code: 'W_SYMLINK' as const,
    paths: [path],
    message: `${path} is a symlink. Pointing one tool's config at another's is the workaround Driftgate replaces: it checks out as a plain file on Windows, and it makes two files that check as in sync because they are one file.`,
  }));
}

/**
 * The tool's own warnings, from its `AdapterDocs`.
 *
 * `docs` has been versioned, sourced data since T013 and mechanically validated since
 * T025, and until now nothing read it. Surfacing `warn` notes is what carries Copilot's
 * three-additive-mechanisms finding to a user, with no Copilot-specific code anywhere.
 */
export function toolNoteWarnings(tool: ToolDiagnosis, docs: AdapterDocs): DoctorWarning[] {
  if (!tool.detected) return [];
  return (docs.notes ?? [])
    .filter((n) => n.level === 'warn')
    .map((n) => ({
      code: 'W_TOOL_NOTE' as const,
      tool: tool.name,
      paths: [],
      message: n.message,
      ...(n.source === undefined ? {} : { source: n.source }),
    }));
}

/**
 * Files nothing reads.
 *
 * Two senses, and both are needed. `comparison.orphaned` is the *record* sense:
 * `state.json` says Driftgate generated it and no enabled adapter produces it now. The
 * shape sense catches what the record sense structurally cannot — T073's bug is that the
 * failing run *drops* the state entry, so by the time anyone looks, `state.json` no longer
 * mentions the file it abandoned. Only a scan of the disk finds those.
 *
 * The candidate set is bounded by the adapters' own declared basenames, so it is derived
 * data rather than a hardcoded list of interesting filenames, and a sixth adapter widens it
 * automatically. A file is an orphan when it has the shape of an instruction file and sits
 * where no detected tool's expanded pattern would ever look.
 */
export async function orphanWarnings(
  fs: ReadOnlyFileSystem,
  comparison: DiskComparison,
  adapters: readonly Adapter[],
  tools: readonly ToolDiagnosis[],
): Promise<DoctorWarning[]> {
  const out: DoctorWarning[] = [];

  if (comparison.orphaned.length > 0) {
    const n = comparison.orphaned.length;
    out.push({
      code: 'W_ORPHAN_FILE',
      paths: [...comparison.orphaned].sort(compareCodepoint),
      message: `${n} generated ${n === 1 ? 'file is' : 'files are'} recorded in state.json but no longer produced by any enabled adapter. ${n === 1 ? 'A tool still loads it' : 'Tools still load them'}.`,
    });
  }

  const detected = new Set(tools.filter((t) => t.detected).map((t) => t.name));
  const active = adapters.filter((a) => detected.has(a.name));
  if (active.length === 0) return out;

  const shapes = new Set<string>();
  const readable: string[] = [];
  for (const adapter of active) {
    for (const entry of adapter.docs.files) {
      if (entry.scope === 'global' || entry.role !== 'instructions') continue;
      shapes.add(basenamePosix(entry.pattern));
      readable.push(
        entry.scope === 'nested' || (entry.nesting !== undefined && entry.nesting !== 'root-only')
          ? expand(entry.pattern)
          : entry.pattern,
      );
    }
  }

  const candidates = new Set<string>();
  for (const shape of [...shapes].sort(compareCodepoint)) {
    for (const hit of await fs.glob(expand(shape))) candidates.add(hit);
  }

  const unread = [...candidates]
    .filter((p) => !readable.some((pattern) => p === pattern || matchesGlob(p, pattern)))
    .sort(compareCodepoint);

  if (unread.length > 0) {
    const n = unread.length;
    out.push({
      code: 'W_ORPHAN_FILE',
      paths: unread,
      message: `${n} ${n === 1 ? 'file has' : 'files have'} the shape of a tool instruction file but ${n === 1 ? 'sits' : 'sit'} where no detected tool looks, so nothing reads ${n === 1 ? 'it' : 'them'}.`,
    });
  }

  return out;
}

function expand(pattern: string): string {
  return pattern.includes('/') ? pattern : `**/${pattern}`;
}

/** Deterministic and stable: code, then tool, then first path, then message. */
export function sortWarnings(warnings: readonly DoctorWarning[]): DoctorWarning[] {
  return [...warnings].sort(
    (a, b) =>
      compareCodepoint(a.code, b.code) ||
      compareCodepoint(a.tool ?? '', b.tool ?? '') ||
      compareCodepoint(a.paths[0] ?? '', b.paths[0] ?? '') ||
      compareCodepoint(a.message, b.message),
  );
}

/**
 * pattern -> the one adapter that generates it.
 *
 * Single-valued because `precedence-docs.test.ts` asserts that no two adapters claim
 * `managed: true` for the same pattern. If that ever stopped holding, registry order would
 * pick the winner here silently — so that cross-adapter test is load-bearing for this map,
 * not only for the docs it was written to guard.
 */
export function buildManagedByIndex(adapters: readonly Adapter[]): Map<string, ToolId> {
  const index = new Map<string, ToolId>();
  for (const adapter of adapters) {
    for (const entry of adapter.docs.files) {
      if (entry.managed && !index.has(entry.pattern)) index.set(entry.pattern, adapter.name);
    }
  }
  return index;
}
