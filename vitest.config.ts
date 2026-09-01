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
      '@driftgate/adapter-kit': src('./packages/adapter-kit/src/index.ts'),
      '@driftgate/adapter-claude-code': src('./packages/adapters/claude-code/src/index.ts'),
      '@driftgate/adapter-cursor': src('./packages/adapters/cursor/src/index.ts'),
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
