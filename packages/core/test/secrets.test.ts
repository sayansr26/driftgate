import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findLiteralSecrets,
  isLiteralSecret,
  literalToEnvRef,
  scanTextForSecrets,
} from '../src/render/secrets.js';
import { parseMcpServers } from '../src/parse/mcp.js';
import { computePlan } from '../src/pipeline/plan.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { ADAPTER_API_VERSION } from '../src/adapter/context.js';
import { MANIFEST_PATH } from '../src/model/paths.js';
import type { Adapter } from '../src/adapter/adapter.js';

/**
 * Not a real credential. Shaped like one so the scanner has something to find, and
 * deliberately not a value any service ever issued.
 */
const FAKE_GITHUB = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
const FAKE_OPAQUE = 'Zx8Qv2Lm9Tp4Rw7Ns1Kd6Hf3Bj5Yc0Ae';

describe('isLiteralSecret', () => {
  it('catches a vendor-prefixed token under any key at all', () => {
    // The prefix is a published format, so a match is a fact rather than a guess —
    // which is why the key is not consulted.
    expect(isLiteralSecret('anythingAtAll', FAKE_GITHUB)).toBe(true);
    expect(isLiteralSecret('note', 'AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('catches an opaque value under a key that says it is a credential', () => {
    expect(isLiteralSecret('apiKey', FAKE_OPAQUE)).toBe(true);
    expect(isLiteralSecret('AUTH_TOKEN', FAKE_OPAQUE)).toBe(true);
  });

  it('reads the key in every case convention, not just camelCase', () => {
    // `apiKey` lowercases to `apikey` on its own, so it proves nothing about the
    // separator stripping — deleting that step passed every other test here. Only a
    // snake_case or kebab-case key supplies the input that reaches it, and real configs
    // are full of both.
    for (const key of ['api_key', 'API-KEY', 'api.key', 'AUTH_TOKEN', 'x-auth-token']) {
      expect(isLiteralSecret(key, FAKE_OPAQUE), key).toBe(true);
    }
  });

  it('accepts a reference in every spelling the targets use', () => {
    // A config that already defers to the environment must not be reported as a literal
    // for spelling it the destination's way.
    for (const ref of [
      'env:GITHUB_TOKEN',
      '${env:GITHUB_TOKEN}',
      '${GITHUB_TOKEN}',
      '$GITHUB_TOKEN',
    ]) {
      expect(isLiteralSecret('token', ref), ref).toBe(false);
    }
  });

  it('leaves ordinary configuration alone', () => {
    // A scan people learn to override is not a scan. These are the values a real
    // servers.yaml is full of.
    expect(isLiteralSecret('command', 'npx')).toBe(false);
    expect(isLiteralSecret('url', 'https://mcp.linear.app/sse')).toBe(false);
    expect(isLiteralSecret('description', 'the token is read from the environment')).toBe(false);
    expect(isLiteralSecret('timeout', '30')).toBe(false);
  });

  it('does not fire on a git hash under an innocent key', () => {
    // This repository's own generated files are full of them.
    expect(isLiteralSecret('hash', 'd77bd461e691')).toBe(false);
  });
});

describe('findLiteralSecrets', () => {
  it('reports the key path and never the value', () => {
    const found = findLiteralSecrets({ nested: { authToken: FAKE_OPAQUE } }, 'servers.a.extra');

    expect(found).toEqual(['servers.a.extra.nested.authToken']);
    // The whole point. A scanner that quoted what it found would print the secret into
    // CI logs, which is the failure it exists to prevent.
    expect(found.join(' ')).not.toContain(FAKE_OPAQUE);
  });

  it('walks into arrays', () => {
    expect(findLiteralSecrets({ args: ['--token', FAKE_GITHUB] }, 'servers.a')).toEqual([
      'servers.a.args[1]',
    ]);
  });

  it('finds nothing in a clean object', () => {
    expect(findLiteralSecrets({ timeout: 30, note: 'kept for the migration' }, 'x')).toEqual([]);
  });
});

describe('the parser refuses a literal', () => {
  it('rejects one in env, naming the key and not the value', () => {
    const { errors } = parseMcpServers(
      `servers:\n  a:\n    command: npx\n    env:\n      GITHUB_TOKEN: ${FAKE_GITHUB}\n`,
    );

    expect(errors[0]?.code).toBe('E_LITERAL_SECRET');
    expect(errors[0]?.message).not.toContain(FAKE_GITHUB);
    expect(errors[0]?.hint).toContain('env:GITHUB_TOKEN');
  });

  it('rejects one hiding in a key it does not understand', () => {
    // `unknown` is the hole the `SecretValue` type cannot close: it is what makes import
    // lossless, it holds plain strings, and they are re-emitted verbatim into generated
    // output without passing a typed secret.
    const { errors } = parseMcpServers(
      `servers:\n  a:\n    command: npx\n    vendorAuth:\n      apiKey: ${FAKE_OPAQUE}\n`,
    );

    expect(errors[0]?.code).toBe('E_LITERAL_SECRET');
    expect(errors[0]?.message).toContain('servers.a.vendorAuth.apiKey');
    expect(errors[0]?.message).not.toContain(FAKE_OPAQUE);
  });

  it('still preserves the unknown key it complained about', () => {
    // Refusing to write is not the same as discarding the user's content.
    const { servers } = parseMcpServers(
      `servers:\n  a:\n    command: npx\n    vendorAuth:\n      apiKey: ${FAKE_OPAQUE}\n`,
    );

    expect(servers[0]?.unknown['vendorAuth']).toEqual({ apiKey: FAKE_OPAQUE });
  });
});

describe('the plan refuses to render one', () => {
  function adapterEmitting(contents: string, kind: 'mcp' | 'rules'): Adapter {
    return {
      name: 'claude-code',
      apiVersion: ADAPTER_API_VERSION,
      detect: () => Promise.resolve({ present: false, evidence: [], global: [] }),
      read: () => Promise.resolve({}),
      write: () => Promise.resolve([{ path: '.mcp.json', contents, adapter: 'claude-code', kind }]),
      docs: { tool: 'claude-code', files: [], nesting: 'none', notes: [], sources: [] },
    } as unknown as Adapter;
  }

  const repo = new MemoryFileSystem(
    new Map([[MANIFEST_PATH, 'schemaVersion: 1\ntools: [claude-code]\n']]),
  );

  it('fails the run rather than writing a credential an adapter produced itself', async () => {
    // The last gate. An adapter renders its own text, so this is the only place that
    // sees what it actually produced — the type system and the parser are both upstream.
    const plan = await computePlan({
      repoRoot: '/repo',
      fs: repo,
      adapters: [adapterEmitting(`{ "token": "${FAKE_GITHUB}" }\n`, 'mcp')],
    });

    expect(plan.errors.map((e) => e.code)).toContain('E_LITERAL_SECRET');
    expect(plan.artifacts.map((a) => a.path)).not.toContain('.mcp.json');
    expect(plan.errors.map((e) => e.message).join(' ')).not.toContain(FAKE_GITHUB);
  });

  it('plans a clean mcp artifact normally, so the assertion above can fail', async () => {
    const plan = await computePlan({
      repoRoot: '/repo',
      fs: repo,
      adapters: [adapterEmitting('{ "token": "${env:GITHUB_TOKEN}" }\n', 'mcp')],
    });

    expect(plan.errors).toEqual([]);
    expect(plan.artifacts.map((a) => a.path)).toEqual(['.mcp.json']);
  });
});

describe('generated output carries no secrets', () => {
  /**
   * T044's stated validation, run over every golden this repository ships. The goldens
   * are the bytes the adapters are asserted to produce, so a scan of them is a scan of
   * generated output — and it is the check that would catch a fixture updated from a
   * developer's real config.
   */
  it('scans every golden fixture', async () => {
    const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
    const offenders: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(full);
          continue;
        }
        const found = scanTextForSecrets(await readFile(full, 'utf8'));
        if (found.length > 0)
          offenders.push(`${path.relative(fixtures, full)} (${found.join(', ')})`);
      }
    };
    await walk(fixtures);

    expect(offenders).toEqual([]);
  });

  it('would notice one, so the scan above is not vacuous', () => {
    expect(scanTextForSecrets(`  "GITHUB_TOKEN": "${FAKE_GITHUB}"\n`)).toEqual(['line 1']);
    expect(scanTextForSecrets(`auth_token = "${FAKE_OPAQUE}"\n`)).toEqual(['line 1']);
  });
});

describe('literalToEnvRef', () => {
  it('names the variable after the key it was found under', () => {
    // The conversion T044 asks import to perform. Wired up by MCP import (T048), which
    // is where a literal can first arrive from somebody else's config file.
    expect(literalToEnvRef('githubToken')).toEqual({ kind: 'env', name: 'GITHUBTOKEN' });
    expect(literalToEnvRef('api-key')).toEqual({ kind: 'env', name: 'API_KEY' });
    expect(literalToEnvRef('1password')).toEqual({ kind: 'env', name: '_1PASSWORD' });
  });
});
