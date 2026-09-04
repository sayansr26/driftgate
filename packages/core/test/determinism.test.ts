import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../src/io/node.js';
import { parse } from '../src/parse/index.js';
import { renderConcatenated, renderRuleSection } from '../src/render/markdown.js';
import { sortRules, compareCodepoint } from '../src/render/order.js';
import { finalizeArtifact } from '../src/render/finalize.js';
import { withHtmlMarker, HTML_MARKER, hasMarker } from '../src/render/marker.js';
import { stableJsonStringify } from '../src/render/json.js';
import { DEFAULT_RULE_ORDER } from '../src/model/rule.js';
import { ALL_TOOLS } from '../src/model/selector.js';
import type { RuleDocument } from '../src/model/rule.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function rule(id: string, order: number, body = `Body of ${id}.`): RuleDocument {
  return {
    id,
    path: `.rulegate/rules/${id}.md`,
    body,
    frontmatter: { globs: [], tools: ALL_TOOLS, order, unknown: {} },
    source: { file: `.rulegate/rules/${id}.md` },
  };
}

/** Deterministic PRNG: a seeded shuffle, because Math.random is itself banned here. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('rendering is deterministic', () => {
  it('produces one unique hash across 100 renders of the same model', () => {
    const rules = [rule('a', 10), rule('b', 20), rule('c', 30)];
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      hashes.add(sha256(withHtmlMarker(renderConcatenated(rules))));
    }
    expect(hashes.size).toBe(1);
  });

  it('is unaffected by the input array order', () => {
    const rules = Array.from({ length: 20 }, (_, i) =>
      rule(`rule-${String(i).padStart(2, '0')}`, i % 5),
    );
    const expected = sortRules(rules).map((r) => r.id);

    for (let seed = 1; seed <= 200; seed += 1) {
      expect(sortRules(shuffle(rules, seed)).map((r) => r.id)).toEqual(expected);
    }
  });

  it('breaks order ties by id, never by position', () => {
    const tied = [rule('zebra', 10), rule('apple', 10), rule('mango', 10)];
    expect(sortRules(tied).map((r) => r.id)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('sorts by codepoint rather than locale', () => {
    // localeCompare would order these by language rules, and differently per ICU build.
    const words = ['Zebra', 'apple', 'Apple', 'zebra'];
    expect([...words].sort(compareCodepoint)).toEqual(['Apple', 'Zebra', 'apple', 'zebra']);
  });
});

describe('CRLF and LF sources are indistinguishable', () => {
  it('renders byte-identical output from both fixtures', async () => {
    const render = async (variant: string): Promise<string> => {
      const result = await parse({ fs: new NodeFileSystem(path.join(fixtures, 'eol', variant)) });
      expect(result.errors).toEqual([]);
      return withHtmlMarker(renderConcatenated(result.canonical.rules));
    };

    const lf = await render('lf');
    const crlf = await render('crlf');

    expect(crlf).toBe(lf);
    expect(sha256(crlf)).toBe(sha256(lf));
    // Guard against the fixture quietly losing its own point: if .gitattributes stops
    // protecting fixtures from EOL translation, both directories become LF and this
    // test passes while testing nothing.
    expect(lf).not.toContain('\r');
  });
});

describe('finalizeArtifact', () => {
  const make = (contents: string): string =>
    finalizeArtifact({ path: 'X.md', contents, adapter: 'test', kind: 'rules' }).contents;

  it.each([
    ['a', 'a\n'],
    ['a\n', 'a\n'],
    ['a\n\n\n', 'a\n'],
    ['a\r\n', 'a\n'],
    ['a\r\nb\r\n', 'a\nb\n'],
    ['﻿a', 'a\n'],
    ['', ''],
  ])('normalizes %j to %j', (input, expected) => {
    expect(make(input)).toBe(expected);
  });

  it('preserves trailing spaces, which are a Markdown hard line break', () => {
    expect(make('line one  \nline two')).toBe('line one  \nline two\n');
  });
});

describe('marker', () => {
  it('leads the file and is detectable', () => {
    const out = withHtmlMarker('Body.\n');
    expect(out.startsWith(HTML_MARKER)).toBe(true);
    expect(hasMarker(out)).toBe(true);
    expect(hasMarker('Hand-written file.\n')).toBe(false);
  });

  it('can be suppressed for formats that cannot carry a comment', () => {
    expect(withHtmlMarker('Body.\n', false)).toBe('Body.\n');
  });
});

describe('stableJsonStringify', () => {
  it('sorts keys regardless of insertion order', () => {
    const a = stableJsonStringify({ zebra: 1, apple: { yak: 2, ant: 3 } });
    const b = stableJsonStringify({ apple: { ant: 3, yak: 2 }, zebra: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{\n  "apple": {\n    "ant": 3,\n    "yak": 2\n  },\n  "zebra": 1\n}\n');
  });
});

describe('glob-scoped rules', () => {
  it('states the scope in prose where the format has no native mechanism', () => {
    const scoped: RuleDocument = {
      ...rule('frontend', DEFAULT_RULE_ORDER, 'Prefer server components.'),
      frontmatter: {
        description: 'Frontend',
        globs: ['src/components/**/*.tsx'],
        tools: ALL_TOOLS,
        order: DEFAULT_RULE_ORDER,
        unknown: {},
      },
    };

    const section = renderRuleSection(scoped, { headingLevel: 2, showGlobs: true });
    expect(section).toBe(
      '## Frontend\n\n**Applies to:** `src/components/**/*.tsx`\n\nPrefer server components.',
    );
  });

  it('omits the scope line for formats that scope natively', () => {
    const scoped: RuleDocument = {
      ...rule('frontend', 100),
      frontmatter: { globs: ['src/**'], tools: ALL_TOOLS, order: 100, unknown: {} },
    };
    expect(renderRuleSection(scoped, { headingLevel: 2, showGlobs: false })).not.toContain(
      'Applies to',
    );
  });
});
