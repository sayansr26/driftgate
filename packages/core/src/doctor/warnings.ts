import { compareCodepoint } from '../render/order.js';
import { matchesGlob } from '../fs/glob.js';
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
/**
 * What makes two loaded files the same context, twice.
 *
 * **Byte identity was the wrong question, and using it was the bug (T084).** It catches
 * `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, which are identical concatenations, and misses
 * every adapter that writes one file per rule: Cline reads `AGENTS.md` on top of
 * `.clinerules/*.md`, and Roo Code reads it on top of `.roo/rules/*.md` — the same canonical
 * rules, sent twice, in different bytes. The warning stayed silent exactly where the token
 * cost was real, and both adapters shipped a hand-written `docs` note as a workaround.
 *
 * Set *equality* is not enough either: `AGENTS.md` carries the union of what five
 * `.clinerules` files carry, so no two of those files have the same rule set. The question
 * is per **rule** — is this rule reaching the model from more than one file? —  which is
 * what `Artifact.provenance.ruleIds` answers directly.
 *
 * A file with no provenance (a global file, an unmanaged one, anything Driftgate did not
 * generate) is keyed by its content hash instead, which is the only signal available for it
 * and is still correct for the identical-concatenation case.
 */
function unitsOf(m: Measured, provenance: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const rules = provenance.get(m.path);
  if (rules !== undefined && rules.length > 0) return rules.map((id) => `rule:${id}`);
  return m.hash === undefined ? [] : [`hash:${m.hash}`];
}

export function duplicateLoadWarnings(
  tool: ToolDiagnosis,
  loaded: readonly Measured[],
  provenance: ReadonlyMap<string, readonly string[]> = new Map(),
): DoctorWarning[] {
  // Every unit of context, and which files deliver it.
  const carriers = new Map<string, Measured[]>();
  for (const m of loaded) {
    for (const unit of unitsOf(m, provenance)) {
      const group = carriers.get(unit) ?? [];
      group.push(m);
      carriers.set(unit, group);
    }
  }

  const groups = new Map<string, Measured[]>();
  for (const [unit, files] of carriers) {
    if (files.length > 1) groups.set(unit, files);
  }

  const duplicated = [...groups.values()];
  if (duplicated.length === 0) return [];

  // A file's tokens spread over the units it carries, so a rule duplicated between a
  // five-rule `AGENTS.md` and a one-rule `.clinerules/10-style.md` is charged what that
  // rule actually costs rather than what the whole file does.
  const share = (m: Measured): number => {
    const units = unitsOf(m, provenance).length;
    return units === 0 ? 0 : m.tokens / units;
  };

  // The number reported is the number of *files listed*, because those are what a reader
  // can act on and what the message goes on to name. Counting rule-copies instead gave
  // "10 copies" beside a list of three paths, which is accurate and unreadable.
  const involved = new Set<string>();
  for (const group of duplicated) for (const m of group) involved.add(m.path);
  const wasted = Math.round(
    duplicated.reduce((n, g) => {
      const cheapest = Math.min(...g.map(share));
      return n + cheapest * (g.length - 1);
    }, 0),
  );
  const paths = [...involved].sort(compareCodepoint);

  return [
    {
      code: 'W_DUPLICATE_LOAD',
      tool: tool.name,
      paths,
      message:
        `${tool.toolName} will load ${tool.loadedCount} files ~${tool.loadedTokens} tokens. ` +
        `${paths.length} of them carry content that also arrives from another file ` +
        `(${attribute(paths, tool).join(', ')}) — about ${wasted} tokens are paid twice.`,
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
 *
 * `options.ignore` narrows the *shape* sense only (T081). Some directories hold instruction
 * files as data — a golden fixture tree above all, where a `CLAUDE.md` is test input rather
 * than a rule anything loads — and there is no way to tell that from the file. The record
 * sense is never narrowed: `state.json` says Driftgate wrote those, and a tool that can be
 * configured to stop mentioning a file it owns is one config line from forgetting it.
 */
export async function orphanWarnings(
  fs: ReadOnlyFileSystem,
  comparison: DiskComparison,
  adapters: readonly Adapter[],
  tools: readonly ToolDiagnosis[],
  ignore: readonly string[] = [],
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
      shapes.add(entry.pattern);
      readable.push(
        entry.scope === 'nested' || (entry.nesting !== undefined && entry.nesting !== 'root-only')
          ? expand(entry.pattern)
          : entry.pattern,
      );
    }
  }

  const candidates = new Set<string>();
  for (const shape of [...shapes].sort(compareCodepoint)) {
    for (const hit of await fs.glob(shapeGlob(shape))) candidates.add(hit);
  }

  const unread = [...candidates]
    .filter((p) => !readable.some((pattern) => p === pattern || matchesGlob(p, pattern)))
    .filter((p) => !ignore.some((pattern) => p === pattern || matchesGlob(p, pattern)))
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

/**
 * The shape a file must have to be a misplaced copy of a file some tool reads.
 *
 * A pattern carrying a directory identifies its files by that directory and not by their
 * names: `.clinerules/*.md` means "every Markdown file in `.clinerules/`", so reducing it
 * to its basename claims every Markdown file in the repository has the shape of a Cline
 * rule. The directory stays, and a misplaced copy is therefore a misplaced *directory*.
 *
 * A leading any-depth prefix matches zero directories here (see `fs/glob.ts`), so the root
 * copy is still found and still filtered out by `readable` — only the nested one survives.
 */
function shapeGlob(pattern: string): string {
  return pattern.startsWith('**/') ? pattern : `**/${pattern}`;
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
