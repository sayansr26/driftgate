import { createRequire } from 'node:module';

/**
 * Read from package.json via createRequire rather than an import attribute
 * (`import pkg from '../package.json' with { type: 'json' }`): import attributes are
 * not stable on Node 20, which is one leg of the supported matrix.
 */
export function readVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version?: string };
  return pkg.version ?? '0.0.0';
}
