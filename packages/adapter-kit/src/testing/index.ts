/**
 * The adapter test harness — `@driftgate/adapter-kit/testing`.
 *
 * A separate entry point from the contract itself, on purpose. This code reads the
 * filesystem and constructs a concrete `NodeFileSystem`; the contract entry must not, or
 * every adapter that imports the kit would carry a filesystem implementation into its
 * runtime graph through the package whose central rule is that adapters do not touch the
 * disk. Nothing here is part of the frozen v1 surface.
 */

export {
  contextFor,
  detectEngineFixture,
  detectFixture,
  fixturePath,
  fixturesRoot,
  importContextFor,
  importFixture,
  importFixtureRules,
  readExpected,
  readInput,
  renderFixture,
  writeFixture,
} from './fixture.js';
export { compareFixture, formatFixtureReport, type FixtureReport } from './compare.js';
export {
  expectContentCovered,
  expectFixtureMatch,
  expectIdempotent,
  expectImportMatch,
} from './assert.js';
export { expectDocsValid, type DocsValidationOptions } from './docs.js';
export {
  escapeInvisibles,
  firstDifference,
  formatDifference,
  type LineDifference,
} from './diff.js';
