import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Aliased to source so `pnpm test` works on a clean clone before `pnpm build`.
    // The trade-off is that nothing here exercises the built dist/ — that gap is
    // covered by the DRIFTGATE_TEST_DIST-gated smoke test, which CI runs after build.
    alias: {
      '@driftgate/core': src('./packages/core/src/index.ts'),
      // The subpath must come first. Vite matches string aliases by prefix in declaration
      // order, so a bare '@driftgate/adapter-kit' listed above this one would rewrite
      // '@driftgate/adapter-kit/testing' into '.../src/index.ts/testing'.
      '@driftgate/adapter-kit/testing': src('./packages/adapter-kit/src/testing/index.ts'),
      '@driftgate/adapter-kit': src('./packages/adapter-kit/src/index.ts'),
      '@driftgate/adapter-claude-code': src('./packages/adapters/claude-code/src/index.ts'),
      '@driftgate/adapter-codex': src('./packages/adapters/codex/src/index.ts'),
      '@driftgate/adapter-copilot': src('./packages/adapters/copilot/src/index.ts'),
      '@driftgate/adapter-cursor': src('./packages/adapters/cursor/src/index.ts'),
      '@driftgate/adapter-gemini': src('./packages/adapters/gemini/src/index.ts'),
      // `action/` imports the CLI by its published name. Without this the Action's tests
      // would be the only ones running against `dist/`, so they would pass or fail on
      // whatever was last built rather than on the source in the diff.
      driftgate: src('./packages/cli/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'action/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
    restoreMocks: true,
  },
});
