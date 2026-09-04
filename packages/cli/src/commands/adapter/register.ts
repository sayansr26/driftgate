import { RulegateError } from '@rulegate/core';
import { toolNames } from './names.js';

/**
 * The three files that turn a directory under `packages/adapters/` into a shipped adapter.
 *
 * Registration is part of the scaffold rather than a follow-up instruction because
 * `packages/cli/test/registry.test.ts` asserts `ADAPTERS` equals the directory listing:
 * an unregistered adapter is not merely invisible, it fails the suite. "Scaffold, then
 * remember to do four more things" is how the 30-minute path becomes an afternoon.
 *
 * Every function here is a pure string transform so that the patch can be shown in the
 * plan before `--yes`, and tested without a filesystem.
 */

const IMPORT_LINE = /^import \{ (?<binding>\w+) \} from '@rulegate\/adapter-(?<id>[a-z0-9-]+)';$/;

/** Rebuild the import block and the ADAPTERS array with `id` added, both sorted by id. */
export function registerInRegistry(source: string, id: string): string {
  const lines = source.split('\n');
  const entries = new Map<string, string>();
  const importIndexes: number[] = [];

  for (const [i, line] of lines.entries()) {
    const match = IMPORT_LINE.exec(line);
    if (match?.groups === undefined) continue;
    entries.set(match.groups['id'] ?? '', match.groups['binding'] ?? '');
    importIndexes.push(i);
  }

  const first = importIndexes[0];
  if (first === undefined) {
    throw patchFailed('packages/cli/src/registry.ts', 'it imports no adapters');
  }

  const n = toolNames(id);
  entries.set(n.id, n.binding);
  const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const rebuilt = sorted.map(
    ([tool, binding]) => `import { ${binding} } from '@rulegate/adapter-${tool}';`,
  );
  const last = importIndexes[importIndexes.length - 1] ?? first;
  const withImports = [...lines.slice(0, first), ...rebuilt, ...lines.slice(last + 1)];

  const text = withImports.join('\n');
  const array = /(export const ADAPTERS: readonly Adapter\[\] = )\[[^\]]*\]/;
  if (!array.test(text)) {
    throw patchFailed('packages/cli/src/registry.ts', 'the ADAPTERS array is not where it was');
  }
  return text.replace(array, `$1[${sorted.map(([, binding]) => binding).join(', ')}]`);
}

/** Add the workspace dependency, in the sorted position the rest of the block is in. */
export function registerInCliPackage(source: string, id: string): string {
  const line = `    "${toolNames(id).packageName}": "workspace:*",`;
  return insertSorted(source, /^ {4}"@rulegate\/adapter-[a-z0-9-]+": "workspace:\*",$/, line, {
    file: 'packages/cli/package.json',
    missing: 'it declares no adapter dependencies',
  });
}

/**
 * Add the source alias.
 *
 * Without it `pnpm test` resolves the new package through its `exports` map into a
 * `dist/` that does not exist yet — so the scaffold would be green only after a build,
 * which is not what "passes pnpm test immediately" means.
 */
export function registerInVitestConfig(source: string, id: string): string {
  const n = toolNames(id);
  const line = `      '${n.packageName}': src('./packages/adapters/${n.id}/src/index.ts'),`;
  return insertSorted(
    source,
    /^ {6}'@rulegate\/adapter-[a-z0-9-]+': src\('\.\/packages\/adapters\/[a-z0-9-]+\/src\/index\.ts'\),$/,
    line,
    { file: 'vitest.config.ts', missing: 'it aliases no adapters' },
  );
}

/**
 * Add the id to RFC-0001 §4.1's table of shipped ids.
 *
 * Not documentation politeness: `packages/cli/test/rfc-output.test.ts` fails when a
 * registered adapter is missing from that table, and it fails for a good reason — a
 * reader could otherwise learn the true set only by triggering `E_UNKNOWN_TOOL`. The
 * whole table is re-rendered rather than appended to, because the column widths are
 * Prettier's and a row that widens a column repads every other one.
 */
export function registerInRfc(source: string, id: string): string {
  const n = toolNames(id);
  const file = 'docs/rfc-0001-canonical-format.md';
  const lines = source.split('\n');

  const start = lines.findIndex((l) => /^\|\s*Id\s*\|/.test(l));
  if (start < 0 || !(lines[start + 1] ?? '').startsWith('|')) {
    throw patchFailed(file, 'section 4.1 has no tool-id table');
  }
  let end = start + 1;
  while ((lines[end + 1] ?? '').startsWith('|')) end += 1;

  const header = cells(lines[start] ?? '');
  const rows = lines.slice(start + 2, end + 1).map((l) => cells(l));
  rows.push([`\`${n.id}\``, `\`${n.artifact}\``]);
  rows.sort(([a], [b]) => ((a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0));

  const widths = header.map((_, i) =>
    Math.max(...[header, ...rows].map((row) => (row[i] ?? '').length)),
  );
  const render = (row: readonly string[]): string =>
    `| ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(' | ')} |`;

  const table = [
    render(header),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(render),
  ];
  return [...lines.slice(0, start), ...table, ...lines.slice(end + 1)].join('\n');
}

/** The cells of one Markdown table row, trimmed. */
function cells(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Insert `line` among the lines matching `shape`, keeping them sorted.
 *
 * Sorted rather than appended: these three blocks are alphabetical today, and a scaffold
 * that appends produces a diff whose first hunk is about ordering rather than about the
 * adapter.
 */
function insertSorted(
  source: string,
  shape: RegExp,
  line: string,
  where: { file: string; missing: string },
): string {
  const lines = source.split('\n');
  const matching = lines.map((l, i) => (shape.test(l) ? i : -1)).filter((i) => i >= 0);
  if (matching.length === 0) throw patchFailed(where.file, where.missing);

  const at =
    matching.find((i) => (lines[i] ?? '') > line) ?? (matching[matching.length - 1] ?? 0) + 1;
  return [...lines.slice(0, at), line, ...lines.slice(at)].join('\n');
}

function patchFailed(file: string, why: string): RulegateError {
  return new RulegateError({
    code: 'E_SCAFFOLD_CONFLICT',
    message: `cannot register the adapter in ${file}: ${why}`,
    hint: 'Run this from a checkout of the rulegate monorepo, or register the adapter by hand.',
  });
}
