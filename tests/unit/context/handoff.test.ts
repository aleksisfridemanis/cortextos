import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeContextHandoff,
  claimContextHandoff,
  releaseContextHandoff,
} from '../../../src/context/handoff.js';

describe('context handoff claim lifecycle', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  function fixture() {
    const ctxRoot = mkdtempSync(join(tmpdir(), 'context-handoff-'));
    roots.push(ctxRoot);
    const stateDir = join(ctxRoot, 'state', 'ada');
    mkdirSync(stateDir, { recursive: true });
    const documentPath = join(ctxRoot, 'handoff.md');
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(documentPath, '# handoff\nkeep this work\n');
    writeFileSync(markerPath, `${documentPath}\n`);
    return { ctxRoot, stateDir, markerPath };
  }

  it('keeps the handoff durable until launch acknowledgement and excludes concurrent claims', () => {
    const { ctxRoot, stateDir, markerPath } = fixture();
    const claim = claimContextHandoff(ctxRoot, 'ada');
    expect(claim?.content).toContain('keep this work');
    expect(existsSync(markerPath)).toBe(true);
    expect(existsSync(join(stateDir, '.handoff-doc-claim.json'))).toBe(true);
    expect(claimContextHandoff(ctxRoot, 'ada')).toBeNull();
    acknowledgeContextHandoff(ctxRoot, 'ada', claim!.token);
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(join(stateDir, '.handoff-doc-claim.json'))).toBe(false);
  });

  it('releases a failed launch claim without deleting the one-shot handoff', () => {
    const { ctxRoot, markerPath } = fixture();
    const first = claimContextHandoff(ctxRoot, 'ada')!;
    releaseContextHandoff(ctxRoot, 'ada', first.token);
    expect(existsSync(markerPath)).toBe(true);
    const retry = claimContextHandoff(ctxRoot, 'ada');
    expect(retry?.content).toBe(first.content);
  });
});
