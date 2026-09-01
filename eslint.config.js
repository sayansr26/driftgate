import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The rules below are not style preferences. They are the mechanical enforcement of
 * the permanent invariants in memory-bank/03-system-patterns.md: zero network calls,
 * adapters are pure, core knows nothing tool-specific, and rendering is deterministic.
 * A lint rule catches these at author time; a code review does not.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', 'fixtures/**', 'coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // A dedicated lint project: the per-package build tsconfigs deliberately
        // exclude tests and root config files, but those still need linting.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='os'][property.name='EOL']",
          message: 'os.EOL is platform-dependent; Driftgate always emits \\n.',
        },
        {
          selector: "MemberExpression[property.name='localeCompare']",
          message: 'localeCompare depends on locale and ICU version; use compareCodepoint().',
        },
      ],
    },
  },
  {
    // Adapters are pure: they return Artifacts and never touch the world themselves.
    // This is what makes `check` and `sync` structurally incapable of diverging.
    files: ['packages/adapters/*/src/**/*.ts'],
    ignores: ['packages/adapters/*/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'Adapters must not touch the filesystem; use ctx.fs.' },
            { name: 'node:fs', message: 'Adapters must not touch the filesystem; use ctx.fs.' },
            {
              name: 'node:fs/promises',
              message: 'Adapters must not touch the filesystem; use ctx.fs.',
            },
            { name: 'node:child_process', message: 'Adapters must not spawn processes.' },
            { name: 'node:http', message: 'Zero network calls, in any code path, ever.' },
            { name: 'node:https', message: 'Zero network calls, in any code path, ever.' },
            { name: 'node:net', message: 'Zero network calls, in any code path, ever.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Zero network calls, in any code path, ever.' },
      ],
    },
  },
  {
    // No tool-specific logic in core, and no filesystem access outside the io boundary.
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/io/**', 'packages/core/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@driftgate/adapter-*'],
          paths: [
            { name: 'node:fs', message: 'Filesystem access belongs in core/src/io only.' },
            {
              name: 'node:fs/promises',
              message: 'Filesystem access belongs in core/src/io only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
