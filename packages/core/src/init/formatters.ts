import { DriftgateError } from '../model/errors.js';
import { matchesGlob } from '../fs/glob.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

/**
 * T072, which is a first-run experience rather than a bug in either tool.
 *
 * A formatter and a generator cannot both own a file. Reformat a generated one and the
 * next `sync` correctly reports it as hand-edited and refuses to write it — a deadlock
 * that looks, from the outside, like Driftgate being broken. Every user with a formatter
 * hits it, so `init` says so at the one moment the information is useful.
 *
 * It warns rather than editing the ignore file itself. That file is the user's, and a
 * tool whose pitch is that it never touches what it did not generate should not open its
 * first conversation by editing something it did not generate — the decision taken at
 * T019 and reaffirmed at T072. `init.test.ts` asserts `--yes` writes no ignore file, so
 * this is a guarantee rather than a comment.
 */

/** Where a formatter's exclusions live: a dedicated ignore file, or a key in its config. */
type Exclusions =
  | { readonly kind: 'ignore-file'; readonly path: string }
  | { readonly kind: 'config-key'; readonly key: string };

interface Formatter {
  readonly name: string;
  /** Presence of any of these means the tool is configured for this repository. */
  readonly configs: readonly string[];
  readonly exclusions: Exclusions;
}

/**
 * The four formatters a JavaScript repository actually uses. Each entry names the file or
 * key its exclusions live in, because "add these lines to .prettierignore" is wrong advice
 * for Biome and dprint, which have no ignore file at all — their excludes are a key inside
 * the config. A hint that names the wrong file is the same failure as no hint.
 */
const FORMATTERS: readonly Formatter[] = [
  {
    name: 'Prettier',
    configs: [
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.json5',
      '.prettierrc.yaml',
      '.prettierrc.yml',
      '.prettierrc.toml',
      '.prettierrc.js',
      '.prettierrc.cjs',
      '.prettierrc.mjs',
      'prettier.config.js',
      'prettier.config.cjs',
      'prettier.config.mjs',
      'prettier.config.ts',
    ],
    exclusions: { kind: 'ignore-file', path: '.prettierignore' },
  },
  {
    name: 'Biome',
    configs: ['biome.json', 'biome.jsonc', '.biome.json'],
    exclusions: { kind: 'config-key', key: 'files.includes' },
  },
  {
    name: 'dprint',
    configs: ['dprint.json', 'dprint.jsonc', '.dprint.json', '.dprint.jsonc'],
    exclusions: { kind: 'config-key', key: 'excludes' },
  },
  {
    name: 'ESLint',
    configs: [
      '.eslintrc',
      '.eslintrc.json',
      '.eslintrc.yaml',
      '.eslintrc.yml',
      '.eslintrc.js',
      '.eslintrc.cjs',
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
    ],
    exclusions: { kind: 'ignore-file', path: '.eslintignore' },
  },
];

/**
 * Prettier is also configured from `package.json` — a `prettier` key, or merely being a
 * dependency with no config file at all, which is the default a `create-*` scaffold
 * leaves behind. Detecting only config files misses the common case.
 *
 * Read as text rather than parsed: this decides whether to *warn*, the file may be any
 * shape a user's `package.json` takes, and a JSON parse failure here must not take an
 * `init` down. Over-detecting costs a warning; under-detecting costs the deadlock.
 */
function packageJsonMentions(pkg: string, name: string): boolean {
  return new RegExp(`"${name}"\\s*:`).test(pkg);
}

/**
 * Does an ignore file already cover this path?
 *
 * Exact line equality was the original test and it is wrong on every real repository:
 * this project's own `.prettierignore` lists `.cursor/rules/` and `.github/instructions/`,
 * which cover their contents without naming one of them. A warning that fires on a
 * correctly configured repository is one people learn to ignore, and then it is not there
 * for the repository that needs it.
 */
export function ignoreCovers(ignoreText: string, relPath: string): boolean {
  let covered = false;
  for (const raw of ignoreText.split('\n')) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    // A negation is the user deliberately un-ignoring something, and the last matching
    // line wins — gitignore's own rule, and the one that decides the answer for a repo
    // that ignores `**/*.md` and then re-includes one file.
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);

    for (const pattern of expand(line)) {
      if (matchesGlob(relPath, pattern)) {
        covered = !negated;
        break;
      }
    }
  }
  return covered;
}

/**
 * The gitignore-style spellings of "this directory and everything under it", written out
 * as globs the matcher understands. `dist`, `dist/` and `/dist` all cover `dist/a.md`,
 * and a bare name with no slash matches at every depth — the rule that quietly excluded
 * this repository's Claude fixtures for the whole of M0.
 */
function expand(line: string): readonly string[] {
  const rooted = line.startsWith('/');
  const body = (rooted ? line.slice(1) : line).replace(/\/$/, '');
  if (body === '') return [];

  const out = [body, `${body}/**`];
  // No slash anywhere means gitignore matches it at any depth, not only at the root.
  if (!rooted && !body.includes('/')) out.push(`**/${body}`, `**/${body}/**`);
  return out;
}

export interface FormatterWarningInput {
  readonly fs: ReadOnlyFileSystem;
  /** The paths `sync` would generate. */
  readonly generated: readonly string[];
}

/** One warning per configured formatter that would fight over a generated path. */
export async function formatterWarnings(
  input: FormatterWarningInput,
): Promise<readonly DriftgateError[]> {
  const { fs, generated } = input;
  if (generated.length === 0) return [];

  const pkg = (await fs.tryReadFile('package.json')) ?? '';
  const warnings: DriftgateError[] = [];

  for (const formatter of FORMATTERS) {
    if (!(await isConfigured(fs, formatter, pkg))) continue;

    const { exclusions } = formatter;
    const ignoreText =
      exclusions.kind === 'ignore-file' ? ((await fs.tryReadFile(exclusions.path)) ?? '') : '';
    const unlisted = generated.filter((p) => !ignoreCovers(ignoreText, p));
    if (unlisted.length === 0) continue;

    warnings.push(
      new DriftgateError({
        code: 'E_FORMATTER_CONFLICT',
        message: `this repository uses ${formatter.name}, and ${String(unlisted.length)} generated file(s) are not excluded from it`,
        source:
          exclusions.kind === 'ignore-file'
            ? { file: exclusions.path }
            : { file: formatter.configs[0]! },
        hint: advice(formatter, unlisted),
      }),
    );
  }

  return warnings;
}

async function isConfigured(
  fs: ReadOnlyFileSystem,
  formatter: Formatter,
  pkg: string,
): Promise<boolean> {
  for (const config of formatter.configs) {
    if (await fs.exists(config)) return true;
  }
  const name = formatter.name.toLowerCase();
  return packageJsonMentions(pkg, name);
}

function advice(formatter: Formatter, unlisted: readonly string[]): string {
  const lines = unlisted.join(', ');
  const consequence = `or the next format run will rewrite them and sync will then refuse to`;
  return formatter.exclusions.kind === 'ignore-file'
    ? `add these lines to ${formatter.exclusions.path}, ${consequence}: ${lines}`
    : `exclude these paths under \`${formatter.exclusions.key}\` in ${formatter.configs[0]!}, ${consequence}: ${lines}`;
}
