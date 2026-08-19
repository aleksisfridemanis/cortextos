/**
 * Canonical user identity, resolved the same way on both sides of the wire.
 *
 * The dashboard anchors every pair key on ADMIN_USERNAME (see
 * dashboard/src/lib/comms-identity.ts). `cortextos dashboard` injects that
 * variable into the Next process from <ctxRoot>/dashboard.env, but NO daemon
 * launch path sets it — so a daemon reading only process.env would derive
 * `dm-<agent>--user` while the dashboard reads `dm-admin--<agent>`, and the
 * two could never meet.
 *
 * Resolution order mirrors `cortextos dashboard`: process.env first, then
 * <ctxRoot>/dashboard.env, then the same 'user' fallback the dashboard uses
 * when nothing is configured at all — so both sides agree in every
 * configuration, including the no-dashboard one.
 */

import { join } from 'path';
import { parseEnvFile } from '../utils/env.js';

export function resolveCanonicalUser(ctxRoot: string): string {
  const fromEnv = (process.env.ADMIN_USERNAME || '').trim();
  if (fromEnv) return fromEnv.toLowerCase();

  try {
    const fromFile = (parseEnvFile(join(ctxRoot, 'dashboard.env')).ADMIN_USERNAME || '').trim();
    if (fromFile) return fromFile.toLowerCase();
  } catch {
    /* no dashboard.env — fall through */
  }

  return 'user';
}
