import { createHash } from 'crypto';

/** Deterministic child identity binding an Employee publication to one promotion. */
export function promotionEmployeeMutationId(parentMutationId: string): string {
  const hex = createHash('sha256').update(`work-session-promotion:${parentMutationId}`, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
