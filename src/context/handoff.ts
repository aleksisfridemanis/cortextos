import { existsSync, readFileSync, unlinkSync } from 'fs';
import { isAbsolute, join } from 'path';
import { withFileLockSync } from '../utils/lock.js';
import { HANDOFF_MAX_BYTES } from './composer.js';

export function consumeContextHandoff(ctxRoot: string, agentName: string): string | null {
  const stateDir = join(ctxRoot, 'state', agentName);
  const markerPath = join(stateDir, '.handoff-doc-path');
  const lockDir = join(stateDir, 'handoff-consume-lock');
  if (!existsSync(markerPath)) return null;
  return withFileLockSync(lockDir, () => {
    if (!existsSync(markerPath)) return null;
    const docPath = readFileSync(markerPath, 'utf8').trim();
    if (!docPath || !isAbsolute(docPath) || !existsSync(docPath)) {
      unlinkSync(markerPath);
      return null;
    }
    const content = readFileSync(docPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > HANDOFF_MAX_BYTES) {
      throw new Error(`CONTEXT_BUDGET_EXCEEDED: handoff exceeds ${HANDOFF_MAX_BYTES} bytes`);
    }
    unlinkSync(markerPath);
    return content;
  });
}
