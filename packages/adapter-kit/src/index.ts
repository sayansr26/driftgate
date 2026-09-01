/**
 * The public adapter contract. Frozen at T011 — external contributors write against
 * these types, so a change here breaks them. Until then this package re-exports the
 * definitions that live in @driftgate/core, keeping the declared dependency direction
 * (adapter-kit -> core) intact.
 */
export type {
  Adapter,
  AdapterContext,
  AdapterDocs,
  Artifact,
  ArtifactKind,
  DetectResult,
  DirEntry,
  DocNote,
  PrecedenceEntry,
  ReadOnlyFileSystem,
  SourceLink,
  VerifiedAgainst,
  WritableFileSystem,
} from '@driftgate/core';

export { ADAPTER_API_VERSION, detected, NOT_DETECTED } from '@driftgate/core';

export * from './fixture.js';
