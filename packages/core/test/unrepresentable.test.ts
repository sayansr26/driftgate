import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { computePlan } from '../src/pipeline/plan.js';
import { codex } from '@driftgate/adapter-codex';
import { claudeCode } from '@driftgate/adapter-claude-code';

/**
 * T083. One server Codex cannot express must not take down the whole run.
 *
 * This lived at the pipeline level, not in the adapter: `renderConfigToml` threw,
 * `computePlan` recorded it as an error, and `applyPlan` writes **nothing** while any
 * error stands. So an ordinary hand-written `servers.yaml` — the documented way to use
 * this feature — produced no `CLAUDE.md`, no `AGENTS.md`, no `.mcp.json` and no
 * `.codex/config.toml`, on a repository where four of those five things were perfectly
 * expressible.
 */
const MANIFEST = [
  '.driftgate/driftgate.yaml',
  'schemaVersion: 1\ntools:\n  - claude-code\n  - codex\n',
] as const;

const SERVERS = [
  '.driftgate/mcp/servers.yaml',
  [
    'schemaVersion: 1',
    'servers:',
    '  github:',
    '    command: srv',
    '    env:',
    '      API_KEY: env:MY_TOKEN',
    '  memory:',
    '    command: npx',
    '',
  ].join('\n'),
] as const;

const RULE = ['.driftgate/rules/10-style.md', '---\ndescription: Style\n---\n\nTwo spaces.\n'] as const;

async function plan(files: readonly (readonly [string, string])[]) {
  return computePlan({
    repoRoot: '/repo',
    fs: new MemoryFileSystem([...files]),
    adapters: [claudeCode, codex],
  });
}

describe('a server one tool cannot express (T083)', () => {
  it('does not abort the run, and every other artifact still renders', async () => {
    const result = await plan([MANIFEST, SERVERS, RULE]);

    // The assertion that matters: no errors, so `applyPlan` will write.
    expect(result.errors).toEqual([]);

    const paths = result.artifacts.map((a) => a.path).sort();
    expect(paths).toEqual(['.codex/config.toml', '.mcp.json', 'AGENTS.md', 'CLAUDE.md']);
  });

  it('still gives Codex the servers it can express', async () => {
    const result = await plan([MANIFEST, SERVERS, RULE]);
    const toml = result.artifacts.find((a) => a.path === '.codex/config.toml')?.contents ?? '';

    expect(toml).toContain('[mcp_servers.memory]');
    expect(toml).not.toContain('[mcp_servers.github]');
  });

  it('names the omission in the generated file, with a hint and no credential', async () => {
    // The file is where the consequence is: it is committed, it appears in `check`'s
    // diff, and a reader learns why a server they configured is missing. A line printed
    // once by `sync` scrolls away.
    const result = await plan([MANIFEST, SERVERS, RULE]);
    const toml = result.artifacts.find((a) => a.path === '.codex/config.toml')?.contents ?? '';

    expect(toml).toContain('# omitted: `github`');
    expect(toml).toContain('rename the variable to API_KEY');
    // T044 still holds: never name the value.
    expect(toml).not.toContain('MY_TOKEN=');
  });

  it('claude-code, which can express it, is unaffected', async () => {
    // The control. Without it every assertion above would pass against a build that
    // dropped the server everywhere rather than only where it cannot be written.
    const result = await plan([MANIFEST, SERVERS, RULE]);
    const json = result.artifacts.find((a) => a.path === '.mcp.json')?.contents ?? '';

    expect(json).toContain('"github"');
    expect(json).toContain('${MY_TOKEN}');
  });
});
