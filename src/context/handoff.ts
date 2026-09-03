import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { withFileLockSync } from '../utils/lock.js';
import { HANDOFF_MAX_BYTES } from './composer.js';

export interface ContextHandoffClaim { token: string; content: string }

interface StoredClaim { token: string; doc_path: string; claimed_at: string }
const activeClaims = new Map<string, StoredClaim>();

function handoffPaths(ctxRoot: string, agentName: string) {
  const stateDir = join(ctxRoot, 'state', agentName);
  return {
    markerPath: join(stateDir, '.handoff-doc-path'),
    claimPath: join(stateDir, '.handoff-doc-claim.json'),
    lockDir: join(stateDir, 'handoff-consume-lock'),
  };
}

export function claimContextHandoff(ctxRoot: string, agentName: string): ContextHandoffClaim | null {
  const { markerPath, claimPath, lockDir } = handoffPaths(ctxRoot, agentName);
  if (!existsSync(markerPath)) return null;
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return withFileLockSync(lockDir, () => {
    if (!existsSync(markerPath)) return null;
    if (activeClaims.has(claimPath)) return null;
    if (existsSync(claimPath)) {
      try {
        const prior = JSON.parse(readFileSync(claimPath, 'utf8')) as StoredClaim;
        if (Date.now() - Date.parse(prior.claimed_at) < 5 * 60_000) return null;
      } catch { /* malformed claims are stale */ }
      unlinkSync(claimPath);
    }
    const docPath = readFileSync(markerPath, 'utf8').trim();
    if (!docPath || !isAbsolute(docPath) || !existsSync(docPath)) {
      unlinkSync(markerPath);
      return null;
    }
    const content = readFileSync(docPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > HANDOFF_MAX_BYTES) {
      throw new Error(`CONTEXT_BUDGET_EXCEEDED: handoff exceeds ${HANDOFF_MAX_BYTES} bytes`);
    }
    const token = randomUUID();
    const stored = { token, doc_path: docPath, claimed_at: new Date().toISOString() };
    writeFileSync(claimPath, `${JSON.stringify(stored)}\n`, { flag: 'wx', mode: 0o600 });
    activeClaims.set(claimPath, stored);
    return { token, content };
  });
}

export function acknowledgeContextHandoff(ctxRoot: string, agentName: string, token: string): void {
  const { markerPath, claimPath, lockDir } = handoffPaths(ctxRoot, agentName);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  withFileLockSync(lockDir, () => {
    const claim = activeClaims.get(claimPath)
      ?? (existsSync(claimPath) ? JSON.parse(readFileSync(claimPath, 'utf8')) as StoredClaim : null);
    if (!claim) throw new Error('HANDOFF_CLAIM_NOT_FOUND');
    if (claim.token !== token) throw new Error('HANDOFF_CLAIM_MISMATCH');
    if (existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === claim.doc_path) unlinkSync(markerPath);
    if (existsSync(claimPath)) unlinkSync(claimPath);
    activeClaims.delete(claimPath);
  });
}

export function releaseContextHandoff(ctxRoot: string, agentName: string, token: string): void {
  const { claimPath, lockDir } = handoffPaths(ctxRoot, agentName);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  withFileLockSync(lockDir, () => {
    const claim = activeClaims.get(claimPath)
      ?? (existsSync(claimPath) ? JSON.parse(readFileSync(claimPath, 'utf8')) as StoredClaim : null);
    if (!claim || claim.token !== token) return;
    if (existsSync(claimPath)) unlinkSync(claimPath);
    activeClaims.delete(claimPath);
  });
}

/** Compatibility helper for callers that have already accepted the handoff. */
export function consumeContextHandoff(ctxRoot: string, agentName: string): string | null {
  const claim = claimContextHandoff(ctxRoot, agentName);
  if (!claim) return null;
  acknowledgeContextHandoff(ctxRoot, agentName, claim.token);
  return claim.content;
}
