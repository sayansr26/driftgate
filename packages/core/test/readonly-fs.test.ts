import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadOnlyFileSystem, NodeFileSystem } from '../src/io/node.js';

/**
 * "Read-only by construction" has to be a fact about the object, not about the type.
 * `createHomeFileSystem` learned this at T016: a `NodeFileSystem` typed as
 * `ReadOnlyFileSystem` still carried its writers, one cast away. `check` holds this.
 */
describe('createReadOnlyFileSystem', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'driftgate-ro-'));
    await writeFile(path.join(root, 'a.md'), 'hello\r\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('has no write method on the object at all', () => {
    const fs = createReadOnlyFileSystem(root);
    expect(Object.keys(fs).sort()).toEqual([
      'exists',
      'glob',
      'listDir',
      'readFile',
      'readFileRaw',
      'tryReadFile',
    ]);
    expect('writeFile' in fs).toBe(false);
    expect('deleteFile' in fs).toBe(false);
    expect('copyFile' in fs).toBe(false);
    // Control: the thing it wraps does have them, so the absence above is the function's doing.
    expect('writeFile' in new NodeFileSystem(root)).toBe(true);
  });

  it('reads through the same normalizing path as NodeFileSystem', async () => {
    const fs = createReadOnlyFileSystem(root);
    expect(await fs.readFile('a.md')).toBe('hello\n');
    expect(await fs.tryReadFile('missing.md')).toBeUndefined();
    expect(await fs.exists('a.md')).toBe(true);
    expect(await fs.glob('*.md')).toEqual(['a.md']);
    expect(new TextDecoder().decode(await fs.readFileRaw('a.md'))).toBe('hello\r\n');
  });

  it('inherits containment: a path escaping the root is refused', async () => {
    const fs = createReadOnlyFileSystem(root);
    await expect(fs.readFile('../outside.md')).rejects.toMatchObject({ code: 'E_PATH_ESCAPE' });
  });
});
