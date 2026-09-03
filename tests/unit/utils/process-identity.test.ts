import { spawn } from 'child_process';
import { once } from 'events';
import { describe, expect, it } from 'vitest';
import { captureProcessIdentity, probeProcessIdentity } from '../../../src/utils/process-identity.js';

describe('native process generation identity', () => {
  it('captures a stable generation and distinguishes the process after exit', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const identity = captureProcessIdentity(child.pid!);
      expect(identity).toMatchObject({ pid: child.pid, started_at: expect.any(String) });
      expect(probeProcessIdentity(identity!)).toBe('alive');
      child.kill('SIGTERM');
      await once(child, 'exit');
      expect(probeProcessIdentity(identity!)).toBe('dead');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
