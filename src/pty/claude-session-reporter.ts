import { randomBytes } from 'crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'fs';
import { dirname, join } from 'path';

export interface ClaudeSessionStartPayload { session_id?: unknown; hook_event_name?: unknown }

export function acknowledgeClaudeSessionStart(expectedSessionId: string, acknowledgementPath: string, payload: ClaudeSessionStartPayload): void {
  if (payload.hook_event_name !== 'SessionStart' || payload.session_id !== expectedSessionId) throw new Error('RESUME_HANDLE_UNAVAILABLE');
  const dir = dirname(acknowledgementPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.session-ack-${process.pid}-${randomBytes(4).toString('hex')}`);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify({ session_id: expectedSessionId, acknowledged_at: new Date().toISOString() })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, acknowledgementPath);
}

export async function runClaudeSessionReporter(): Promise<void> {
  const [expected, path] = process.argv.slice(2);
  if (!expected || !path) throw new Error('RESUME_HANDLE_UNAVAILABLE');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  acknowledgeClaudeSessionStart(expected, path, JSON.parse(Buffer.concat(chunks).toString('utf8')) as ClaudeSessionStartPayload);
}

if (require.main === module) runClaudeSessionReporter().catch(() => { process.exitCode = 1; });
