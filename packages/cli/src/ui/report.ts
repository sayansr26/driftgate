import pc from 'picocolors';
import type { DriftgateError } from '@driftgate/core';

export interface Output {
  readonly quiet: boolean;
  log(line: string): void;
  error(line: string): void;
}

/**
 * Colour only on a TTY, and never when NO_COLOR is set or --no-color was passed.
 * CI logs and piped output must stay plain: a diff full of escape sequences is a diff
 * nobody reads.
 */
export function createOutput(opts: { quiet?: boolean; color?: boolean } = {}): Output {
  const useColor =
    opts.color !== false && Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];
  if (!useColor) pc.createColors(false);

  return {
    quiet: opts.quiet === true,
    log(line: string): void {
      if (opts.quiet !== true) process.stdout.write(`${line}\n`);
    },
    error(line: string): void {
      process.stderr.write(`${line}\n`);
    },
  };
}

export function formatErrors(errors: readonly DriftgateError[]): string {
  return errors.map((e) => e.format()).join('\n');
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
