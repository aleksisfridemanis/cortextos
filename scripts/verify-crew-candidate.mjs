#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const expectedBase = '4d3e64fb5f34ce4c6f25cf18c3cd32255fa1c1cd';
const preservedTip = 'c045fc043bb6650ae3a4b662a41c875575214b76';
function git(args) { return execFileSync('git', args, { encoding: 'utf8', timeout: 10_000 }).trim(); }
function fail(message) { console.error(`candidate verification failed: ${message}`); process.exit(1); }

const head = git(['rev-parse', 'HEAD']);
if (git(['rev-parse', `${expectedBase}^{commit}`]) !== expectedBase) fail('expected base is missing');
if (git(['rev-parse', `${preservedTip}^{commit}`]) !== preservedTip) fail('preserved Crew tip is missing');
try { execFileSync('git', ['merge-base', '--is-ancestor', preservedTip, head]); } catch { fail('candidate does not descend from preserved Crew tip'); }
if (Number(git(['rev-list', '--count', `${expectedBase}..${preservedTip}`])) !== 25) fail('preserved Crew ancestry is not exactly 25 commits');
const required = [
  'src/work-sessions/registry.ts', 'src/work-sessions/manager.ts', 'src/pty/work-session-pty.ts',
  'dashboard/src/app/api/work-sessions/route.ts', 'dashboard/src/app/api/work-sessions/browse/route.ts',
  'templates/context/work-session.md',
];
for (const file of required) if (!existsSync(file)) fail(`required artifact missing: ${file}`);
const projectionScript = `const projectionModule = await import('./dashboard/src/lib/public-work-session.ts');
const publicWorkSession = projectionModule.publicWorkSession ?? projectionModule.default?.publicWorkSession;
if (typeof publicWorkSession !== 'function') throw new Error('projection unavailable');
const value = publicWorkSession({ id: 'ws-check', lifecycle: 'archived', resume_handle: { thread_id: 'secret' }, runtime_owner: { pid: 42 }, requested_cwd: '/private', canonical_cwd: '/private', mutation_id: 'private', created_by: 'private' });
process.stdout.write(JSON.stringify(value));`;
let projection;
try {
  projection = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', projectionScript], { encoding: 'utf8', timeout: 10_000 }));
} catch { fail('browser projection behavior could not be verified'); }
if (projection.id !== 'ws-check' || projection.lifecycle !== 'archived' || projection.resumable !== true) fail('browser projection omitted public fields');
for (const secret of ['resume_handle', 'runtime_owner', 'requested_cwd', 'canonical_cwd', 'mutation_id', 'created_by']) {
  if (Object.hasOwn(projection, secret)) fail(`browser projection exposed ${secret}`);
}
const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).filter(line => !line.endsWith(' .gsd/') && !line.includes('.gsd/dispatch-isolation-sentinel.json'));
if (dirty.length) fail(`worktree is not clean: ${dirty.join(', ')}`);
console.log(`candidate_sha: ${head}`);
