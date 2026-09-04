import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * A hint is advice we tell the user to follow. `sync` used to hint at
 * `rulegate sync --import`, which is T051 and unimplemented, so following it produced
 * usage help and exit 2 — the code reserved for "you made a mistake" (T075). A README
 * promise decays; this does not.
 *
 * Subcommands are covered too, as of T019. They could not be until then: two hints and
 * RFC §8 named `rulegate init` while it was unregistered, so following the only
 * instruction a user with no `.rulegate/` ever received exited **2** (T077). Widening
 * this guard is how that stays fixed.
 */

function registeredSubcommands(): Set<string> {
  return new Set(buildProgram().commands.map((cmd) => cmd.name()));
}

function registeredLongFlags(): Set<string> {
  const program = buildProgram();
  const out = new Set<string>();
  for (const cmd of [program, ...program.commands]) {
    for (const option of cmd.options) {
      if (option.long !== undefined) out.add(option.long);
      // `--no-color` registers as `--color`; both spellings are accepted on the CLI.
      if (option.long?.startsWith('--no-') === true) out.add(`--${option.long.slice(5)}`);
      if (option.long !== undefined && !option.long.startsWith('--no-')) {
        out.add(`--no-${option.long.slice(2)}`);
      }
    }
  }
  return out;
}

async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test') {
          continue;
        }
        await walk(child);
        continue;
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(child);
    }
  };
  await walk(path.join(repoRoot, 'packages'));
  return out.sort();
}

/**
 * Both channels a hint can reach the user through: `RulegateError.hint`, and the CLI's
 * own free-text `hint:` lines. Matching on the source text rather than on constructed
 * errors is what makes this cover hints no test happens to trigger.
 *
 * The window is expression-shaped rather than line-shaped on purpose. Hint text is
 * routinely a `'…' + '…'` concatenation split across two lines, and a line-based scan
 * reads only the first half — which is exactly the half that tends not to hold the flag.
 * It ends at the first line that closes the enclosing call or object literal, which is
 * how every hint in this codebase is written. Over-reading slightly is the safe
 * direction: it can only make this test louder, never quieter.
 */
function hintExpressions(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/hint:/g)) {
    const rest = source.slice(match.index);
    const close = rest.search(/\n\s*[)}]/);
    out.push(close === -1 ? rest : rest.slice(0, close));
  }
  return out;
}

async function hintTexts(): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for (const file of await sourceFiles()) {
    const rel = path.relative(repoRoot, file);
    for (const text of hintExpressions(await readFile(file, 'utf8'))) {
      out.push({ file: rel, text });
    }
  }
  return out;
}

describe('hints only name things that exist', () => {
  it('finds the hints it is meant to be checking', async () => {
    // Without this, a refactor that renamed the `hint` field would leave the suite
    // passing vacuously.
    const hints = await hintTexts();
    expect(hints.length).toBeGreaterThanOrEqual(10);
  });

  it('never advertises a subcommand the CLI does not register', async () => {
    // T077: `run: rulegate init` was the first instruction a new user got, and it was
    // the first thing that failed.
    const registered = registeredSubcommands();
    const offenders: string[] = [];
    const matched: string[] = [];

    for (const { file, text } of await hintTexts()) {
      // Only actual invocations: `run: rulegate x` or a backticked `rulegate x`.
      // A bare `rulegate <word>` also matches prose like "pin rulegate to a version".
      for (const [, name] of text.matchAll(/(?:run: |`)rulegate ([a-z][a-z0-9-]*)/g)) {
        if (name === undefined) continue;
        matched.push(name);
        if (!registered.has(name)) offenders.push(`${file}: ${name}`);
      }
    }

    // The regex carries the product name, so a rename that misses it makes `matchAll`
    // yield nothing, the loop body never run, and `expect([]).toEqual([])` pass while
    // checking absolutely nothing. The outer hint-count guard above does not cover this
    // loop. Assert the regex still matches before trusting its verdict.
    expect(matched.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('never advertises a flag the CLI does not accept', async () => {
    const registered = registeredLongFlags();
    const offenders: string[] = [];

    for (const { file, text } of await hintTexts()) {
      for (const [flag] of text.matchAll(/--[a-z][a-z0-9-]*/g)) {
        if (!registered.has(flag)) offenders.push(`${file}: ${flag}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
