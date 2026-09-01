import { createHash } from 'node:crypto';
import { normalizeEol, stripBom } from '../render/eol.js';
import { compareCodepoint } from '../render/order.js';
import { stableJsonStringify } from '../render/json.js';
import type { Artifact, ArtifactKind } from '../adapter/artifact.js';
import type { ToolId } from '../model/ids.js';

export const STATE_SCHEMA_VERSION = 1;

export interface StateArtifact {
  /** Repo-relative, POSIX. */
  readonly path: string;
  /** `sha256:` followed by 64 lowercase hex characters. */
  readonly hash: string;
  readonly adapter: ToolId;
  readonly kind: ArtifactKind;
}

export interface StateFile {
  readonly schemaVersion: number;
  /** Sorted by path, so two people adding different tools touch disjoint regions. */
  readonly artifacts: readonly StateArtifact[];
}

/**
 * Hash the *normalized* content, never the raw bytes.
 *
 * Hashing raw bytes would mean that every Windows user with `core.autocrlf=true` sees
 * every generated file reported as hand-edited on every checkout — `driftgate check`
 * would fail CI for every repository on that platform, for a reason that looks like a
 * renderer bug. Driftgate is EOL-agnostic when comparing and LF-only when writing.
 *
 * The algorithm prefix means a future migration is detectable rather than silently
 * mis-comparing.
 */
export function hashContents(contents: string): string {
  const normalized = normalizeEol(stripBom(contents));
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

export function buildState(artifacts: readonly Artifact[]): StateFile {
  const entries = artifacts.map((a) => ({
    path: a.path,
    hash: hashContents(a.contents),
    adapter: a.adapter,
    kind: a.kind,
  }));
  entries.sort((a, b) => compareCodepoint(a.path, b.path));
  return { schemaVersion: STATE_SCHEMA_VERSION, artifacts: entries };
}

export function serializeState(state: StateFile): string {
  return stableJsonStringify({
    schemaVersion: state.schemaVersion,
    artifacts: state.artifacts.map((a) => ({
      adapter: a.adapter,
      hash: a.hash,
      kind: a.kind,
      path: a.path,
    })),
  });
}

/**
 * Never throws.
 *
 * "Losing state.json is never fatal" has to be true of a *corrupt* file too, not just
 * a missing one — the realistic case is a merge conflict leaving `<<<<<<< HEAD` in the
 * middle of it. Anything unparseable degrades to "no prior state" and the caller warns.
 */
export function parseState(text: string | undefined): StateFile | undefined {
  if (text === undefined || text.trim() === '') return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record['schemaVersion'] !== 'number') return undefined;
  if (!Array.isArray(record['artifacts'])) return undefined;

  const artifacts: StateArtifact[] = [];
  for (const entry of record['artifacts']) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const item = entry as Record<string, unknown>;
    if (
      typeof item['path'] !== 'string' ||
      typeof item['hash'] !== 'string' ||
      typeof item['adapter'] !== 'string' ||
      typeof item['kind'] !== 'string'
    ) {
      return undefined;
    }
    artifacts.push({
      path: item['path'],
      hash: item['hash'],
      adapter: item['adapter'],
      kind: item['kind'] as ArtifactKind,
    });
  }

  return { schemaVersion: record['schemaVersion'], artifacts };
}

export function findArtifact(state: StateFile, path: string): StateArtifact | undefined {
  return state.artifacts.find((a) => a.path === path);
}

export const EMPTY_STATE: StateFile = { schemaVersion: STATE_SCHEMA_VERSION, artifacts: [] };
