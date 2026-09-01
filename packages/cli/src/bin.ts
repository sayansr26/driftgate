#!/usr/bin/env node
import { isDriftgateError } from '@driftgate/core';
import { buildProgram } from './program.js';
import { ExitCode } from './ui/exit.js';

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  // A DriftgateError that reaches here is still a user-facing failure, not a crash:
  // print the actionable form rather than a stack trace.
  process.stderr.write(
    `${isDriftgateError(error) ? error.format() : String(error instanceof Error ? error.message : error)}\n`,
  );
  process.exitCode = ExitCode.Failure;
}
