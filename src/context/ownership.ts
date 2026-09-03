import { digestCrewAuditValue } from '../audit/crew-lifecycle-audit.js';
import type { ContextOwner } from './types.js';

export type ContextSourceCategory = 'framework_rule' | 'identity' | 'goals' | 'memory' | 'user_rules' | 'custom';

export interface ContextOwnershipClassification {
  source_ref: string;
  owner: ContextOwner;
  digest: string;
  reason: string;
}

export function classifyContextOwnership(input: {
  source_ref: string;
  content: string;
  current_framework_content: string;
  known_framework_digests: string[];
  category: ContextSourceCategory;
}): ContextOwnershipClassification {
  const digest = digestCrewAuditValue(input.content);
  if (input.category !== 'framework_rule') {
    return { source_ref: input.source_ref, owner: 'instance', digest, reason: `${input.category} is permanently instance-owned` };
  }
  if (input.content === input.current_framework_content || input.known_framework_digests.includes(digest)) {
    return { source_ref: input.source_ref, owner: 'framework', digest, reason: 'exact known framework bytes' };
  }
  return { source_ref: input.source_ref, owner: 'ambiguous', digest, reason: 'changed or unknown former-framework material is preserved for owner review' };
}

export function proposeContextMerge(frameworkContent: string, preservedContent: string) {
  const content = `${frameworkContent.trimEnd()}\n\n## Preserved instance addition\n\n${preservedContent.trimEnd()}\n`;
  return {
    content,
    digest: digestCrewAuditValue(content),
    explanation: 'Current safety defaults and preserved local material require explicit owner approval before becoming effective.',
  };
}
