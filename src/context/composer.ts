import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildEmployeeContextRoutes } from './router.js';
import type { ContextOwner, EffectiveContextBlock, EffectiveContextPacket } from './types.js';

export const EMPLOYEE_CORE_MAX_BYTES = 24_576;
export const HANDOFF_MAX_BYTES = 16_384;

export interface ComposeEmployeeContextOptions {
  frameworkRoot: string;
  agentDir: string;
  ctxRoot: string;
  mode: 'fresh' | 'continuation';
  projectRoot?: string;
  handoff?: string;
}

function readRequired(sourceRef: string): string {
  try { return readFileSync(sourceRef, 'utf8'); } catch {
    throw new Error(`CONTEXT_SOURCE_UNAVAILABLE: ${sourceRef}`);
  }
}

function block(sourceRef: string, owner: ContextOwner, inclusionReason: string): EffectiveContextBlock {
  return { source_ref: sourceRef, text: readRequired(sourceRef), owner, inclusion_reason: inclusionReason };
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function composeEmployeeContext(options: ComposeEmployeeContextOptions): EffectiveContextPacket {
  const contextDir = join(options.frameworkRoot, 'templates', 'context');
  const blocks: EffectiveContextBlock[] = [
    block(join(contextDir, 'employee-core.md'), 'framework', 'current Employee runtime and essential safety rules'),
    block(join(contextDir, 'employee-router.md'), 'framework', 'stable dynamic context routing contract'),
  ];
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
