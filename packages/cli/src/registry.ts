import { claudeCode } from '@driftgate/adapter-claude-code';
import { codex } from '@driftgate/adapter-codex';
import { copilot } from '@driftgate/adapter-copilot';
import { cursor } from '@driftgate/adapter-cursor';
import { gemini } from '@driftgate/adapter-gemini';
import type { Adapter } from '@driftgate/core';

/** Every adapter this build ships. Order here is irrelevant; the plan sorts output. */
export const ADAPTERS: readonly Adapter[] = [claudeCode, codex, copilot, cursor, gemini];

export const ADAPTER_NAMES: readonly string[] = ADAPTERS.map((a) => a.name);
