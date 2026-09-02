# @driftgate/adapter-kit

The public contract for Driftgate adapters.
An adapter turns one canonical set of AI-agent instructions into one tool's native config,
and it is a pure module: `{ detect, read, write, docs }`, no network, no writes.

**This package is the contract. `@driftgate/core` is not** — it is published because this
package depends on it, but it carries no compatibility guarantee, and adapter source may not
import it.

```ts
import {
  ADAPTER_API_VERSION,
  detected,
  finalizeArtifact,
  renderConcatenated,
  selects,
  sortRules,
  withHtmlMarker,
  type Adapter,
  type AdapterContext,
  type Artifact,
} from '@driftgate/adapter-kit';
```

Two entry points:

- **`@driftgate/adapter-kit`** — the frozen contract.
- **`@driftgate/adapter-kit/testing`** — the fixture harness, for tests only. It reads the
  filesystem, which is why it is not part of the contract entry.

## Stability

The surface is **frozen at API v1**. Adding an export is non-breaking; removing or renaming
one, or changing an existing shape, requires an `ADAPTER_API_VERSION` bump.

The full list, the breaking/non-breaking policy, and how a v2 would arrive are in
[`docs/adapter-api-v1.md`](../../docs/adapter-api-v1.md). Both halves are enforced by tests
rather than by review: `test/public-api.test.ts` pins the export names and kinds, and
`test/shape/pins.ts` pins the structural shapes that no export name would reveal.

MIT.
