#!/usr/bin/env node
import { isDriftgateError } from '@driftgate/core';
import { buildProgram } from './program.js';
import { ExitCode } from './ui/exit.js';

// `driftgate check | head` closes the pipe while we are still writing to it, and Node
// reports that as an asynchronous `EPIPE` on the stream — which, unhandled, prints a stack
// trace for something that is not an error. A C program gets SIGPIPE and dies silently;
// this is the closest equivalent.
//
// The exit code is deliberately left alone. `check` sets it to 1 for drift, and a reader
// closing early must not turn that into a 0 — the whole contract with CI is that the code
// describes the repository, never the terminal.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') return;
    throw error;
  });
}

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
