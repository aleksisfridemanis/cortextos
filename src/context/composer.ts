import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildEmployeeContextRoutes } from './router.js';
import type { ContextOwner, EffectiveContextBlock, EffectiveContextPacket } from './types.js';
import { digestCrewAuditValue } from '../audit/crew-lifecycle-audit.js';

export const EMPLOYEE_CORE_MAX_BYTES = 24_576;
export const HANDOFF_MAX_BYTES = 16_384;
export const WORK_SESSION_CONTEXT_MAX_BYTES = 16_384;
export type ContextHarness = 'claude-code' | 'codex-app-server' | 'opencode';

export interface ComposeEmployeeContextOptions {
  frameworkRoot: string;
  agentDir: string;
  agentName: string;
  ctxRoot: string;
  mode: 'fresh' | 'continuation';
  projectRoot?: string;
  handoff?: string;
}

export interface ComposeWorkSessionContextOptions {
  frameworkRoot: string;
  projectRoot: string;
  initialRequest?: string;
}

function readRequired(sourceRef: string): string {
  try { return readFileSync(sourceRef, 'utf8'); } catch {
    throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
  }
}

function block(sourceRef: string, owner: ContextOwner, inclusionReason: string): EffectiveContextBlock {
  return { source_ref: sourceRef, text: readRequired(sourceRef), owner, inclusion_reason: inclusionReason };
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function composeEmployeeContext(options: ComposeEmployeeContextOptions): EffectiveContextPacket {
  if (!/^[a-z0-9_-]{1,64}$/.test(options.agentName)) throw new Error('INVALID_AGENT_NAME');
  const contextDir = join(options.frameworkRoot, 'templates', 'context');
  const frameworkCore = block(join(contextDir, 'employee-core.md'), 'framework', 'current Employee runtime and essential safety rules');
  const blocks: EffectiveContextBlock[] = [];
  const overridesPath = join(options.ctxRoot, 'config', 'context-overrides.json');
  let coreOverride: { content?: string | null; disabled?: boolean; mutation_id?: string } | null = null;
  if (existsSync(overridesPath)) {
    try {
      const state = JSON.parse(readFileSync(overridesPath, 'utf8'));
      if (state?.schema_version !== 2 || !state?.employees || typeof state.employees !== 'object') throw new Error('invalid');
      coreOverride = state.employees?.[options.agentName]?.rules?.['employee-core'] ?? null;
    } catch {
      throw new Error('CONTEXT_OVERRIDES_CORRUPT');
    }
  }
  if (!coreOverride) blocks.push(frameworkCore);
  else if (coreOverride.disabled) {
    blocks.push({ source_ref: 'owner://context-overrides/employee-core', text: 'The owner explicitly disabled the framework employee-core default.', owner: 'owner', inclusion_reason: `audited disable decision ${coreOverride.mutation_id ?? ''}` });
  } else if (typeof coreOverride.content === 'string') {
    blocks.push({ source_ref: 'owner://context-overrides/employee-core', text: coreOverride.content, owner: 'owner', inclusion_reason: `audited owner decision ${coreOverride.mutation_id ?? ''}` });
  } else {
    throw new Error('CONTEXT_OVERRIDES_CORRUPT');
  }
  blocks.push(block(join(contextDir, 'employee-router.md'), 'framework', 'stable dynamic context routing contract'));
  for (const [name, reason] of [
    ['IDENTITY.md', 'Employee identity and role'],
    ['GOALS.md', 'Employee goals and commitments'],
    ['USER.md', 'owner-authored user rules'],
  ] as const) {
    const sourceRef = join(options.agentDir, name);
    if (existsSync(sourceRef)) blocks.push(block(sourceRef, 'instance', reason));
  }
  if (options.mode === 'continuation' && options.handoff) {
    if (Buffer.byteLength(options.handoff, 'utf8') > HANDOFF_MAX_BYTES) {
      throw new Error(`CONTEXT_BUDGET_EXCEEDED: handoff exceeds ${HANDOFF_MAX_BYTES} bytes`);
    }
    blocks.push({ source_ref: 'logical://current-work/handoff', text: options.handoff, owner: 'instance', inclusion_reason: 'one-shot continuation handoff' });
  }
  const text = blocks.map(item => `<!-- source: ${item.source_ref} -->\n${item.text}`).join('\n\n');
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > EMPLOYEE_CORE_MAX_BYTES + (options.mode === 'continuation' ? HANDOFF_MAX_BYTES : 0)) {
    throw new Error(`CONTEXT_BUDGET_EXCEEDED: Employee packet is ${byteLength} bytes`);
  }
  return {
    schema_version: 1,
    builder_version: '1',
    launch_mode: options.mode,
    blocks,
    routes: buildEmployeeContextRoutes(options),
    provenance: blocks.map(item => ({
      source_ref: item.source_ref,
      digest: digest(item.text),
      owner: item.owner,
      inclusion_reason: item.inclusion_reason,
    })),
    text,
    byte_length: byteLength,
  };
}

export function composeWorkSessionContext(options: ComposeWorkSessionContextOptions): EffectiveContextPacket {
  const blocks: EffectiveContextBlock[] = [
    block(join(options.frameworkRoot, 'templates', 'context', 'work-session.md'), 'framework', 'tiny Work Session runtime and communication contract'),
  ];
  for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
    const sourceRef = join(options.projectRoot, fileName);
    if (existsSync(sourceRef)) blocks.push(block(sourceRef, 'instance', 'project-authored harness instructions'));
  }
  if (options.initialRequest) {
    blocks.push({ source_ref: 'logical://current-work/initial-request', text: options.initialRequest, owner: 'owner', inclusion_reason: 'owner request that opened this Work Session' });
  }
  const text = blocks.map(item => `<!-- source: ${item.source_ref} -->\n${item.text}`).join('\n\n');
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > WORK_SESSION_CONTEXT_MAX_BYTES) throw new Error(`CONTEXT_BUDGET_EXCEEDED: Work Session packet is ${byteLength} bytes`);
  return {
    schema_version: 1, builder_version: '1', launch_mode: 'fresh', blocks, routes: [],
    provenance: blocks.map(item => ({ source_ref: item.source_ref, digest: digest(item.text), owner: item.owner, inclusion_reason: item.inclusion_reason })),
    text, byte_length: byteLength,
  };
}

export function materializeContextPacket(packet: EffectiveContextPacket, runtime: ContextHarness) {
  const packetDigest = digestCrewAuditValue({
    schema_version: packet.schema_version,
    builder_version: packet.builder_version,
    launch_mode: packet.launch_mode,
    provenance: packet.provenance,
    routes: packet.routes,
  });
  const common = { runtime, packet_digest: packetDigest, routes: packet.routes, provenance: packet.provenance };
  if (runtime === 'claude-code') return { ...common, native: { append_system_prompt: packet.text } };
  if (runtime === 'codex-app-server') return { ...common, native: { input: [{ type: 'text', text: packet.text, text_elements: [] }] } };
  return { ...common, native: { startup_prompt: packet.text } };
}
