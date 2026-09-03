import { execFileSync } from 'child_process';

export interface ProcessIdentity {
  pid: number;
  started_at: string;
}

function startedAt(pid: number): string | null {
  try {
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || null;
  } catch { return null; }
}

export function captureProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const identity = startedAt(pid);
  return identity ? { pid, started_at: identity } : null;
}

export function probeProcessIdentity(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  try { process.kill(identity.pid, 0); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code !== 'EPERM') return 'unknown';
  }
  const observed = startedAt(identity.pid);
  if (!observed) return 'unknown';
  return observed === identity.started_at ? 'alive' : 'dead';
}
