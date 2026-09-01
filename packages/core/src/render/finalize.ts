import { ensureSingleTrailingNewline, normalizeEol, stripBom } from './eol.js';
import type { Artifact, ArtifactKind } from '../adapter/artifact.js';
import type { RuleId, ToolId } from '../model/ids.js';

export interface ArtifactDraft {
  readonly path: string;
  readonly contents: string;
  readonly adapter: ToolId;
  readonly kind: ArtifactKind;
  readonly provenance?: { readonly ruleIds: readonly RuleId[] };
}

/**
 * The single normalization gate every artifact passes through: strip the BOM,
 * normalize line endings, and ensure exactly one trailing newline.
 *
 * It deliberately does *not* trim trailing whitespace. Two trailing spaces are a
 * meaningful hard line break in Markdown, and a renderer that silently ate them would
 * be mutating user content — the exact failure this project treats as unacceptable.
 */
export function finalizeArtifact(draft: ArtifactDraft): Artifact {
  const contents = ensureSingleTrailingNewline(normalizeEol(stripBom(draft.contents)));
  return {
    path: draft.path,
    contents,
    adapter: draft.adapter,
    kind: draft.kind,
    ...(draft.provenance === undefined ? {} : { provenance: draft.provenance }),
  };
}
