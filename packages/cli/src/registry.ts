import { claudeCode } from '@driftgate/adapter-claude-code';
import { cursor } from '@driftgate/adapter-cursor';
import type { Adapter } from '@driftgate/core';

/** Every adapter this build ships. Order here is irrelevant; the plan sorts output. */
export const ADAPTERS: readonly Adapter[] = [claudeCode, cursor];

export const ADAPTER_NAMES: readonly string[] = ADAPTERS.map((a) => a.name);
