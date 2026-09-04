import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { joinWorkspace, readBooleanInput, readInput } from '../src/inputs.js';

describe('readInput', () => {
  it('reads the environment variable the runner actually sets', () => {
    // Uppercased, with spaces turned into underscores. Reading `INPUT_working-directory`
    // would find nothing on a real runner and silently take every default.
    expect(readInput('working-directory', { 'INPUT_WORKING-DIRECTORY': 'apps/web' })).toBe(
      'apps/web',
    );
    expect(readInput('two words', { INPUT_TWO_WORDS: 'x' })).toBe('x');
  });

  it('trims, because the runner preserves the YAML block scalar verbatim', () => {
    expect(readInput('a', { INPUT_A: '  apps/web\n' })).toBe('apps/web');
  });

  it('is empty when unset', () => {
    expect(readInput('missing', {})).toBe('');
  });
});

describe('readBooleanInput', () => {
  it('reads true and false', () => {
    expect(readBooleanInput('a', false, { INPUT_A: 'true' })).toBe(true);
    expect(readBooleanInput('a', true, { INPUT_A: 'false' })).toBe(false);
    expect(readBooleanInput('a', false, { INPUT_A: 'TRUE' })).toBe(true);
  });

  it('falls back rather than reading an unrecognized value as false', () => {
    // A workflow that says `annotations: yes` meant yes. Turning that into "off" is the
    // feature quietly disabling itself, which is indistinguishable from it being broken.
    expect(readBooleanInput('a', true, { INPUT_A: 'yes' })).toBe(true);
    expect(readBooleanInput('a', true, {})).toBe(true);
    expect(readBooleanInput('a', false, {})).toBe(false);
  });
});

describe('joinWorkspace', () => {
  const workspace = path.resolve('/checkout');

  it('defaults to the checkout root', () => {
    expect(joinWorkspace('', { GITHUB_WORKSPACE: workspace })).toBe(workspace);
  });

  it('resolves a relative directory against the workspace, not the process cwd', () => {
    // On a runner those are the same only by accident, and the accident does not hold
    // for a composite action or a container step.
    expect(joinWorkspace('apps/web', { GITHUB_WORKSPACE: workspace })).toBe(
      path.join(workspace, 'apps', 'web'),
    );
    expect(joinWorkspace('apps/web', { GITHUB_WORKSPACE: workspace })).not.toBe(
      path.resolve('apps/web'),
    );
  });

  it('falls back to the process cwd off a runner, so the bundle still runs locally', () => {
    expect(joinWorkspace('', {})).toBe(process.cwd());
  });
});
