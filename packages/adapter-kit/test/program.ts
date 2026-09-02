import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * A TypeScript program over the kit, resolved to **source**.
 *
 * The `paths` mapping is the load-bearing part, and it was added after both freeze
 * guards were caught passing against a stale build. `@driftgate/core` resolves through
 * its `exports` map to `dist/index.d.ts`, so without this the guards describe whatever
 * was last built: edit `DetectResult` in core, run the guards, and they stay green until
 * someone runs `pnpm build`. A guard whose answer depends on build freshness is not a
 * guard. This mirrors what `vitest.config.ts` does for the same reason.
 */
export function createKitProgram(entryFiles: readonly string[]): ts.Program {
  const config = ts.readConfigFile(path.join(repoRoot, 'tsconfig.base.json'), (f) =>
    ts.sys.readFile(f),
  );
  const parsed = ts.parseJsonConfigFileContent(config.config as unknown, ts.sys, repoRoot);
  return ts.createProgram([...entryFiles], {
    ...parsed.options,
    noEmit: true,
    baseUrl: repoRoot,
    paths: {
      '@driftgate/core': [path.join(repoRoot, 'packages/core/src/index.ts')],
    },
  });
}

export function formatDiagnostics(program: ts.Program): string[] {
  return [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()].map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (d.file === undefined || d.start === undefined) return message;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${path.relative(repoRoot, d.file.fileName)}:${line + 1} ${message}`;
  });
}
