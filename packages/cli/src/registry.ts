import { aider } from '@rulegate/adapter-aider';
import { claudeCode } from '@rulegate/adapter-claude-code';
import { cline } from '@rulegate/adapter-cline';
import { codex } from '@rulegate/adapter-codex';
import { copilot } from '@rulegate/adapter-copilot';
import { cursor } from '@rulegate/adapter-cursor';
import { gemini } from '@rulegate/adapter-gemini';
import { rooCode } from '@rulegate/adapter-roo-code';
import { windsurf } from '@rulegate/adapter-windsurf';
import { zed } from '@rulegate/adapter-zed';
import type { Adapter } from '@rulegate/core';

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
