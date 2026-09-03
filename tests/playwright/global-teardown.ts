import { existsSync, readFileSync, realpathSync } from 'fs';
import { createConnection } from 'net';
import { tmpdir } from 'os';
import { sep } from 'path';

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function processGroupExists(id: number): boolean {
  try { process.kill(-id, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function portIsClosed(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: 39183 });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

export default async function globalTeardown() {
  const root = process.env.CORTEXT_PLAYWRIGHT_RUN_ROOT;
  if (!root || !existsSync(root)) return;
  const real = realpathSync(root);
  const temp = realpathSync(tmpdir());
  if (!real.startsWith(`${temp}${sep}`)) throw new Error('Refusing teardown outside the OS temp directory');
  const manifestPath = `${real}${sep}manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    supervisor_pid: number;
    dashboard_process_group_id: number;
    socket: string;
    storageState: string;
    root: string;
  };
  if (manifest.root !== real
    || !manifest.socket.startsWith(`${real}${sep}`)
    || !manifest.storageState.startsWith(`${real}${sep}`)
    || !Number.isInteger(manifest.supervisor_pid)
    || !Number.isInteger(manifest.dashboard_process_group_id)) {
    throw new Error('Invalid Playwright supervisor manifest');
  }
  try { process.kill(manifest.supervisor_pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const stopped = !processExists(manifest.supervisor_pid)
      && !processGroupExists(manifest.dashboard_process_group_id)
      && await portIsClosed()
      && !existsSync(manifest.socket)
      && !existsSync(manifest.storageState)
      && !existsSync(manifestPath)
      && !existsSync(real);
    if (stopped) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Playwright supervisor did not completely remove its isolated runtime');
}
