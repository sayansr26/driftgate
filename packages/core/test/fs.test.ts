import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { escapesRoot, normalizeRelative } from '../src/fs/paths.js';
import { matchesGlob } from '../src/fs/glob.js';
import { ensureSingleTrailingNewline, normalizeText } from '../src/render/eol.js';

describe('path safety', () => {
  it.each([
    ['/etc/passwd', true],
    ['C:\\Windows', true],
    ['../outside.md', true],
    ['a/../../outside.md', true],
    ['', true],
    ['a/../b.md', false],
    ['.rulegate/rules/style.md', false],
  ])('escapesRoot(%s) === %s', (input, expected) => {
    expect(escapesRoot(input)).toBe(expected);
  });

  it('normalizes to POSIX with no . or .. segments', () => {
    expect(normalizeRelative('./a/b/../c.md')).toBe('a/c.md');
  });
});

describe('glob', () => {
  it.each([
    ['.rulegate/rules/a.md', '.rulegate/rules/**/*.md', true],
    ['.rulegate/rules/nested/a.md', '.rulegate/rules/**/*.md', true],
    ['.rulegate/rules/a.txt', '.rulegate/rules/**/*.md', false],
    ['src/a.ts', 'src/*.ts', true],
    ['src/nested/a.ts', 'src/*.ts', false],
  ])('matchesGlob(%s, %s) === %s', (p, pattern, expected) => {
    expect(matchesGlob(p, pattern)).toBe(expected);
  });
});

describe('MemoryFileSystem', () => {
  it('normalizes CRLF and strips the BOM on read', async () => {
    const fs = new MemoryFileSystem([['a.md', '\uFEFFone\r\ntwo\r\n']]);
    expect(await fs.readFile('a.md')).toBe('one\ntwo\n');
  });

  it('returns listings and globs in codepoint order, not insertion order', async () => {
    const fs = new MemoryFileSystem([
      ['r/z.md', 'z'],
      ['r/a.md', 'a'],
      ['r/m.md', 'm'],
    ]);
    expect((await fs.listDir('r')).map((e) => e.name)).toEqual(['a.md', 'm.md', 'z.md']);
    expect(await fs.glob('r/*.md')).toEqual(['r/a.md', 'r/m.md', 'r/z.md']);
  });

  it('refuses reads that escape the repository root', async () => {
    const fs = new MemoryFileSystem();
    await expect(fs.tryReadFile('../secrets')).rejects.toThrow(/escapes the repository root/);
  });
});

describe('text normalization', () => {
  it.each([
    ['a', 'a\n'],
    ['a\n', 'a\n'],
    ['a\n\n\n', 'a\n'],
    ['', ''],
  ])('ensureSingleTrailingNewline(%j) === %j', (input, expected) => {
    expect(ensureSingleTrailingNewline(input)).toBe(expected);
  });

  it('makes CRLF and LF sources indistinguishable', () => {
    expect(normalizeText('a\r\nb')).toBe(normalizeText('a\nb'));
  });
});
