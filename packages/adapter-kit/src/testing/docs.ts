import { matchesGlob } from '@driftgate/core';
import { readExpected } from './fixture.js';
import type { Adapter, AdapterDocs, SourceLink } from '@driftgate/core';

/**
 * Validate one adapter's encoded precedence rules.
 *
 * `AdapterDocs` is the project's actual moat — incumbents already sync files, but nobody
 * has written down what each tool truly loads. A knowledge asset with no guard rots, and
 * it rots silently: a stale `retrieved` date and a wrong `scope` look exactly like correct
 * ones. Until this existed there was no test anywhere asserting anything about `docs`.
 *
 * Throws plain `Error`s rather than calling `expect`, like the rest of this harness: the
 * kit is published and its runtime dependency allowlist is `yaml`, `commander`,
 * `picocolors`. Pulling a test framework into that graph is what the allowlist prevents.
 */
export interface DocsValidationOptions {
  /**
   * Write-fixture names whose `expected/` trees together contain everything this adapter
   * generates. Cursor needs two (`cursor` plus the opt-in `cursor-legacy`).
   */
  readonly writeFixtures: readonly string[];
}

export async function expectDocsValid(
  adapter: Adapter,
  options: DocsValidationOptions,
): Promise<void> {
  const problems: string[] = [];
  const { docs } = adapter;
  const where = (i: number): string => `${adapter.name}.docs.files[${String(i)}]`;

  if (docs.toolName.trim() === '') problems.push(`${adapter.name}.docs.toolName is empty`);
  problems.push(...checkUrl(`${adapter.name}.docs.homepage`, docs.homepage));
  problems.push(...checkVerifiedAgainst(adapter.name, docs));

  if (docs.files.length === 0) problems.push(`${adapter.name}.docs.files is empty`);

  const generated = await generatedPaths(options.writeFixtures);
  const seen = new Set<string>();
  // Counted, and asserted against `files.length` below. A validator that loops over an
  // array is silently vacuous when the array is empty — this repository's signature bug,
  // and the most ordinary shape it takes.
  let examined = 0;

  for (const [i, entry] of docs.files.entries()) {
    examined += 1;

    if (seen.has(entry.pattern)) {
      problems.push(`${where(i)} duplicates pattern ${entry.pattern}; precedence is undefined`);
    }
    seen.add(entry.pattern);

    if (entry.description.trim() === '') problems.push(`${where(i)} has an empty description`);
    problems.push(...checkSource(where(i), entry.source));

    if (entry.pattern.includes('\\')) {
      problems.push(`${where(i)} pattern ${entry.pattern} is not POSIX`);
    }
    if (entry.pattern.startsWith('/')) {
      problems.push(`${where(i)} pattern ${entry.pattern} is absolute`);
    }

    // Biconditional, both directions. A global entry without `~/` is invisible to the
    // detection engine; a `~/` pattern not marked global would be probed against the
    // *repository*, where it cannot exist.
    const tilde = entry.pattern.startsWith('~/');
    if (entry.scope === 'global' && !tilde) {
      problems.push(`${where(i)} is scope 'global' but does not start with '~/'`);
    }
    if (tilde && entry.scope !== 'global') {
      problems.push(`${where(i)} starts with '~/' but is scope '${entry.scope}'`);
    }

    if (
      entry.scope === 'global' &&
      (entry.pattern.includes('**') || entry.pattern.includes('..'))
    ) {
      // The engine refuses to walk a home directory recursively, so a rule that would
      // require it is a documentation bug rather than a runtime surprise.
      problems.push(`${where(i)} global pattern ${entry.pattern} would require a recursive walk`);
    }

    if (entry.scope === 'nested' && entry.nesting === undefined) {
      problems.push(`${where(i)} is scope 'nested' but declares no nesting behaviour`);
    }

    if (entry.managed) {
      if (entry.scope === 'global') {
        problems.push(`${where(i)} claims to manage ${entry.pattern} outside the repository`);
      }
      if (!generated.some((p) => p === entry.pattern || matchesGlob(p, entry.pattern))) {
        problems.push(
          `${where(i)} claims to generate ${entry.pattern}, but no golden file matches it`,
        );
      }
    } else if (generated.includes(entry.pattern)) {
      // The converse, and the one that would catch an adapter listing a file as somebody
      // else's while quietly emitting it.
      problems.push(`${where(i)} is marked unmanaged but ${entry.pattern} is in its own goldens`);
    }
  }

  if (examined !== docs.files.length) {
    problems.push(`${adapter.name}: examined ${String(examined)} of ${String(docs.files.length)}`);
  }

  for (const note of docs.notes ?? []) {
    if (note.source !== undefined)
      problems.push(...checkSource(`${adapter.name}.docs.notes`, note.source));
  }

  if (docs.resolution === undefined) {
    // The field is optional in the type so that an external adapter is not broken by its
    // addition, but every adapter *we* ship must state it: "highest precedence first"
    // described two different behaviours for five tools, and leaving it to the default
    // is how the ambiguity comes back.
    problems.push(
      `${adapter.name}.docs.resolution is absent; say whether these files override or accumulate`,
    );
  }

  if (docs.limits === undefined) {
    // "No documented cap" and "nobody checked" must not look the same. An adapter that
    // has genuinely verified there is no limit says so in `limits.note`.
    problems.push(
      `${adapter.name}.docs.limits is absent; record the cap, or a note saying none is published`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`encoded precedence rules are invalid:\n  ${problems.join('\n  ')}`);
  }
}

/** Every path this adapter is known to produce, from its golden fixtures. */
async function generatedPaths(fixtures: readonly string[]): Promise<readonly string[]> {
  const out: string[] = [];
  for (const name of fixtures) {
    // Read from the goldens rather than by calling `write()`. A validator that runs the
    // function it is validating can be satisfied by a bug in that function; bytes on disk
    // that were hand-written from the vendor's documentation cannot.
    for (const path of (await readExpected(name)).keys()) out.push(path);
  }
  return out;
}

function checkVerifiedAgainst(name: string, docs: AdapterDocs): readonly string[] {
  const problems: string[] = [];
  if (docs.verifiedAgainst.version.trim() === '') {
    problems.push(`${name}.docs.verifiedAgainst.version is empty`);
  }
  if (!isIsoDate(docs.verifiedAgainst.date)) {
    problems.push(`${name}.docs.verifiedAgainst.date is not an ISO date`);
  }
  return problems;
}

function checkSource(where: string, source: SourceLink): readonly string[] {
  const problems: string[] = [...checkUrl(`${where}.source.url`, source.url)];
  if (source.title.trim() === '') problems.push(`${where}.source.title is empty`);
  if (!isIsoDate(source.retrieved)) {
    problems.push(`${where}.source.retrieved '${source.retrieved}' is not an ISO date`);
  }
  return problems;
}

function checkUrl(where: string, url: string): readonly string[] {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [`${where} '${url}' is not a URL`];
  }
  // https only: a precedence claim is only checkable if the reader can reach the source,
  // and a plain-http citation in 2026 is a link that will break.
  return parsed.protocol === 'https:' ? [] : [`${where} '${url}' is not https`];
}

/**
 * A real calendar date in `yyyy-mm-dd`.
 *
 * Deliberately no "not in the future" check. That would make the suite depend on the
 * host clock, which is the same class of defect as depending on `Math.random` — it passes
 * today and fails on a machine whose clock is skewed, for no reason a reader can act on.
 */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
