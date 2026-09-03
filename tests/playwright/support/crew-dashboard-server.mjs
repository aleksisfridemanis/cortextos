import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runRoot = process.env.CORTEXT_PLAYWRIGHT_RUN_ROOT;
if (!runRoot || !existsSync(runRoot)) throw new Error('CORTEXT_PLAYWRIGHT_RUN_ROOT is missing');
const realRoot = realpathSync(runRoot);
const realTemp = realpathSync(tmpdir());
if (!realRoot.startsWith(`${realTemp}${sep}`)) throw new Error('Playwright run root is outside the OS temp directory');
const origin = 'http://127.0.0.1:39183';
const ctxRoot = join(realRoot, 'ctx');
const frameworkRoot = join(realRoot, 'framework');
const storageState = join(realRoot, 'auth', 'storage-state.json');
const socketPath = process.env.CORTEXT_PLAYWRIGHT_IPC_PATH ?? join(homedir(), '.cortextos', 'playwright', 'daemon.sock');
const manifestPath = join(realRoot, 'manifest.json');
let ipcServer;
let dashboard;
let cleaning = false;
const sessions = [];

function seed() {
  for (const dir of [join(ctxRoot, 'config'), join(ctxRoot, 'state'), join(frameworkRoot, 'orgs', 'platform', 'agents'), join(frameworkRoot, 'templates', 'agent'), join(frameworkRoot, 'templates', 'context'), dirname(socketPath), process.env.HOME]) {
    if (dir) mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ ada: { enabled: true, org: 'platform' } }, null, 2));
  writeFileSync(join(ctxRoot, 'config', 'rooms.json'), '[]\n');
  writeFileSync(join(frameworkRoot, 'templates', 'agent', 'config.json'), '{}\n');
  writeFileSync(join(frameworkRoot, 'templates', 'context', 'work-session.md'), 'synthetic runtime and comms\n');
}

async function assertPortFree() {
  await new Promise((resolveFree, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('Port 39183 is already occupied')));
    probe.listen(39183, '127.0.0.1', () => probe.close(resolveFree));
  });
}

function startFakeIpc() {
  try { rmSync(socketPath, { force: true }); } catch {}
  ipcServer = createServer(socket => {
    let raw = '';
    socket.on('data', chunk => {
      raw += chunk;
      let response = { success: false, error: 'Invalid request', code: 'INVALID_INPUT' };
      try {
        const request = JSON.parse(raw);
        if (request.type === 'list-work-sessions') response = { success: true, data: sessions };
        else if (request.type === 'reconcile-crew') response = { success: true, data: { finalized: 0, pending: 0 } };
        else if (request.type === 'create-employee') response = { success: true, data: { status: 'created', employee: { name: request.data.name }, audit: 'finalized' } };
        else if (request.type === 'create-work-session') {
          const record = { schema_version: 1, kind: 'work_session', id: `ws-${request.mutation_id}`, display_name: request.data.display_name, org: request.data.org, harness: request.data.harness, model: request.data.model ?? null, requested_cwd: request.data.requested_cwd, canonical_cwd: request.data.requested_cwd, room_id: `work-${request.mutation_id}`, lifecycle: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null, promoted_employee: null, created_by: request.data.actor, mutation_id: request.mutation_id };
          sessions.push(record); response = { success: true, data: { session: record } };
        } else if (['stop-work-session', 'resume-work-session', 'promote-work-session'].includes(request.type)) {
          const record = sessions.find(row => row.id === request.data.id);
          if (!record) response = { success: false, error: 'missing', code: 'NOT_FOUND' };
          else { record.lifecycle = request.type === 'resume-work-session' ? 'active' : 'archived'; record.updated_at = new Date().toISOString(); response = { success: true, data: record }; }
        } else if (request.type === 'inject-work-session') response = { success: true, data: { delivered: true, mutation_id: request.mutation_id } };
        else response = { success: true, data: [] };
      } catch { return; }
      socket.end(JSON.stringify(response));
    });
  });
  return new Promise((resolveListen, reject) => {
    ipcServer.once('error', reject);
    ipcServer.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolveListen(); });
  });
}

async function cleanup(code = 0) {
  if (cleaning) return;
  cleaning = true;
  if (dashboard?.pid) {
    try { process.kill(-dashboard.pid, 'SIGTERM'); } catch {}
    await new Promise(resolveWait => { const timer = setTimeout(resolveWait, 5000); dashboard.once('exit', () => { clearTimeout(timer); resolveWait(); }); });
    try { process.kill(-dashboard.pid, 'SIGKILL'); } catch {}
  }
  if (ipcServer) await new Promise(resolveClose => ipcServer.close(resolveClose));
  try { rmSync(socketPath, { force: true }); } catch {}
  try { rmSync(storageState, { force: true }); } catch {}
  try { rmSync(realRoot, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(0); });
process.on('uncaughtException', error => { console.error(error); cleanup(1); });
process.on('unhandledRejection', error => { console.error(error); cleanup(1); });

await assertPortFree();
seed();
await startFakeIpc();
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const forwardedKeys = [
  'PATH', 'HOME', 'TMPDIR', 'PORT', 'HOSTNAME', 'DASHBOARD_URL', 'NEXTAUTH_URL',
  'AUTH_SECRET', 'NEXTAUTH_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'SYNC_ADMIN_PASSWORD',
  'CTX_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'CTX_INSTANCE_ID',
  'CORTEXT_PLAYWRIGHT_RUN_ROOT', 'CORTEXT_PLAYWRIGHT_FAKE_IPC', 'CORTEXT_PLAYWRIGHT_IPC_PATH',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY',
];
const env = {
  ...Object.fromEntries(forwardedKeys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  CORTEXT_BUILD_SHA: sha,
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PRIVATE_BUILD_WORKER: '1',
  NEXT_PRIVATE_MAX_WORKERS: '1',
};
const prewarm = spawn(
  process.execPath,
  ['--import', 'tsx', '--input-type=module', '--eval', "await import('./dashboard/src/lib/db.ts')"],
  { cwd: repo, env, stdio: 'inherit' },
);
const prewarmCode = await new Promise(resolveCode => prewarm.once('exit', code => resolveCode(code ?? 1)));
if (prewarmCode !== 0) await cleanup(prewarmCode);
const build = spawn('npm', ['--prefix', 'dashboard', 'run', 'build'], { cwd: repo, env, stdio: 'inherit' });
const buildCode = await new Promise(resolveCode => build.once('exit', code => resolveCode(code ?? 1)));
if (buildCode !== 0) await cleanup(buildCode);
dashboard = spawn('npm', ['--prefix', 'dashboard', 'run', 'start', '--', '--hostname', '127.0.0.1', '--port', '39183'], { cwd: repo, env, stdio: 'inherit', detached: true });
writeFileSync(manifestPath, `${JSON.stringify({
  supervisor_pid: process.pid,
  dashboard_process_group_id: dashboard.pid,
  socket: socketPath,
  storageState,
  root: realRoot,
  sha,
  forwarded_environment_keys: Object.keys(env).sort(),
  live_api_keys_empty: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'].every(key => env[key] === ''),
}, null, 2)}\n`);
await Promise.race([
  (async () => { for (let i = 0; i < 300; i++) { try { const response = await fetch(`${origin}/api/workflows/health`); if (response.ok) return; } catch {} await new Promise(resolveWait => setTimeout(resolveWait, 100)); } throw new Error('Dashboard readiness timed out'); })(),
  new Promise((_, reject) => dashboard.once('exit', code => reject(new Error(`Dashboard exited before readiness (${code})`)))),
]);
dashboard.once('exit', code => { if (!cleaning) cleanup(code ?? 1); });
await new Promise(() => {});
