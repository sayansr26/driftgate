import { aider } from '@driftgate/adapter-aider';
import { claudeCode } from '@driftgate/adapter-claude-code';
import { cline } from '@driftgate/adapter-cline';
import { codex } from '@driftgate/adapter-codex';
import { copilot } from '@driftgate/adapter-copilot';
import { cursor } from '@driftgate/adapter-cursor';
import { gemini } from '@driftgate/adapter-gemini';
import { rooCode } from '@driftgate/adapter-roo-code';
import { windsurf } from '@driftgate/adapter-windsurf';
import { zed } from '@driftgate/adapter-zed';
import type { Adapter } from '@driftgate/core';

/** Every adapter this build ships. Order here is irrelevant; the plan sorts output. */
export const ADAPTERS: readonly Adapter[] = [
  aider,
  claudeCode,
  cline,
  codex,
  copilot,
  cursor,
  gemini,
  rooCode,
  windsurf,
  zed,
];

export const ADAPTER_NAMES: readonly string[] = ADAPTERS.map((a) => a.name);
