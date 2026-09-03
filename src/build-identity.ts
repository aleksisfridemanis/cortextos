import { execFileSync } from 'child_process';

const SHA = /^[0-9a-f]{40}$/;

export interface CortextBuildIdentity { sha: string; source: 'environment' | 'git' | 'unknown' }

/** Exact source identity shared by daemon evidence and the dashboard build route. */
export function resolveBuildIdentity(cwd = process.cwd()): CortextBuildIdentity {
  const provided = process.env.CORTEXT_BUILD_SHA?.toLowerCase();
  if (provided && SHA.test(provided)) return { sha: provided, source: 'environment' };
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 2000 }).trim().toLowerCase();
    if (SHA.test(sha)) return { sha, source: 'git' };
  } catch { /* packaged installs may not retain Git metadata */ }
  return { sha: 'unknown', source: 'unknown' };
}
