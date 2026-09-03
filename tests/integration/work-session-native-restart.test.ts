import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkSessionPTY } from '../../src/pty/work-session-pty.js';
import { createWorkSessionRecord } from '../../src/work-sessions/registry.js';
import { WorkSessionManager } from '../../src/work-sessions/manager.js';
import { readRoomLog } from '../../src/rooms/log.js';
import { commitCrewMutationState, prepareCrewMutation, startCrewMutationEffect } from '../../src/audit/crew-mutation-journal.js';
import { digestCrewAuditValue } from '../../src/audit/crew-lifecycle-audit.js';
import { captureProcessIdentity, probeProcessIdentity } from '../../src/utils/process-identity.js';

describe('native Work Session process restart ownership', () => {
  const roots: string[] = [];
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cortext-native-restart-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const cwd = join(root, 'project');
    const ctxRoot = join(root, 'ctx');
    mkdirSync(bin, { recursive: true });
    mkdirSync(cwd);
    const executable = join(bin, 'codex');
    writeFileSync(executable, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync(require('path').join(process.cwd(), 'descendant.pid'), String(child.pid));
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split(/\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const result = request.method === 'thread/start' ? { thread: { id: 'native-thread' } } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    if (request.method === 'turn/start') {
      process.stdout.write(JSON.stringify({ method: 'item/completed', params: { item: {
        id: 'native-answer', type: 'agentMessage', text: 'native durable answer'
      } } }) + '\\n');
    }
  }

});
setInterval(() => {}, 1000);
`);
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    return { root, cwd, ctxRoot };
  }

  function structuredFixture(harness: 'claude-code' | 'opencode') {
    const root = mkdtempSync(join(tmpdir(), `cortext-native-${harness}-`));
    roots.push(root);
    const bin = join(root, 'bin');
    const cwd = join(root, 'project');
    const ctxRoot = join(root, 'ctx');
    mkdirSync(bin, { recursive: true });
    mkdirSync(cwd);
    const executable = join(bin, harness === 'claude-code' ? 'claude' : 'opencode');
    const source = harness === 'claude-code' ? `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), 'launch-args.json'), JSON.stringify(args));
const settingsPath = args[args.indexOf('--settings') + 1];
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const command = settings.hooks.SessionStart[0].hooks[0].command;
const quoted = command.match(/"([^"]+)"$/);
const ackPath = quoted && quoted[1];
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];
fs.writeFileSync(ackPath, JSON.stringify({ session_id: sessionId }));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split(/\\n/); buffer = lines.pop() || '';
  for (const line of lines) if (line.trim()) {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ type: 'assistant', uuid: 'claude-native-answer', message: { content: [{ type: 'text', text: 'Claude native answer: ' + request.message.content[0].text }] } }) + '\\n');
  }
});
setInterval(() => {}, 1000);
` : `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), 'launch-args.json'), JSON.stringify(args));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split(/\\n/); buffer = lines.pop() || '';
  for (const line of lines) if (line.trim()) {
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } }) + '\\n');
    else if (request.method === 'session/new') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'opencode-native-session' } }) + '\\n');
    else if (request.method === 'session/load') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
    else if (request.method === 'session/set_config_option') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
    else if (request.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OpenCode native answer' } } } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;
    writeFileSync(executable, source);
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    return { root, cwd, ctxRoot };
  }

  it.each(['claude-code', 'opencode'] as const)('launches %s through its native structured transport and persists emitted bytes', async harness => {
    const { root, cwd, ctxRoot } = structuredFixture(harness);
    const mutationId = harness === 'claude-code' ? 'c4111111-1111-4111-8111-111111111111' : '04111111-1111-4111-8111-111111111111';
    const record = createWorkSessionRecord(ctxRoot, {
      id: `ws-${mutationId}`, display_name: 'Structured', org: 'platform', harness, requested_cwd: cwd,
      room_id: `work-${mutationId}`, mutation_id: mutationId, created_by: 'owner:test',
    });
    const manager = new WorkSessionManager({ ctxRoot, adapterFactory: () => { throw new Error('unused'); } });
    const adapter = new WorkSessionPTY({
      ctxRoot, frameworkRoot: root, instanceId: 'test', record, timeoutMs: 3_000,
      onOutput: output => manager.recordRuntimeOutput(record.id, output),
    });
    await adapter.startFresh({ id: record.id, mutation_id: mutationId, cwd });
    await adapter.send('native prompt');
    await new Promise(resolve => setTimeout(resolve, 100));
    const args = JSON.parse(readFileSync(join(cwd, 'launch-args.json'), 'utf8')) as string[];
    if (harness === 'claude-code') expect(args).toEqual(expect.arrayContaining(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json']));
    else expect(args.slice(0, 3)).toEqual(['acp', '--cwd', cwd]);
    expect(readRoomLog(ctxRoot, record.room_id).filter(message => message.source === 'work_session'))
      .toEqual([expect.objectContaining({ from: record.id, text: expect.stringContaining('native answer'), delivery_state: 'delivered' })]);
    await adapter.stop();
  }, 10_000);

  it('persists ownership at native spawn and lets a fresh adapter terminate the exact child', async () => {
    const { root, cwd, ctxRoot } = fixture();
    const mutationId = 'd1111111-1111-4111-8111-111111111111';
    const record = createWorkSessionRecord(ctxRoot, {
      id: `ws-${mutationId}`, display_name: 'Native', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd,
      room_id: `work-${mutationId}`, mutation_id: mutationId, created_by: 'owner:test',
    });
    const adapter = new WorkSessionPTY({ ctxRoot, frameworkRoot: root, instanceId: 'test', record, timeoutMs: 3_000 });
    const started = await adapter.startFresh({ id: record.id, mutation_id: mutationId, cwd });
    expect(started).toMatchObject({
      resume_handle: { runtime: 'codex-app-server', thread_id: 'native-thread' },
      runtime_owner: { mutation_id: mutationId, pid: expect.any(Number), started_at: expect.any(String) },
    });
    while (!existsSync(join(cwd, 'descendant.pid'))) await new Promise(resolve => setTimeout(resolve, 20));
    const descendant = captureProcessIdentity(Number(readFileSync(join(cwd, 'descendant.pid'), 'utf8')))!;

    const restarted = new WorkSessionPTY({
      ctxRoot, frameworkRoot: root, instanceId: 'test',
      record: { ...record, lifecycle: 'active', resume_handle: started.resume_handle, runtime_owner: started.runtime_owner },
      timeoutMs: 3_000,
    });
    expect(restarted.status()).toMatchObject({ running: true, ownership: 'detached', pid: started.runtime_owner.pid });
    await restarted.stop();
    expect(restarted.status()).toMatchObject({ running: false, ownership: 'dead' });
    expect(probeProcessIdentity(descendant)).toBe('dead');
  }, 10_000);

  it('persists native completed output once with stable Work Session identity', async () => {
    const { root, cwd, ctxRoot } = fixture();
    const mutationId = 'd4111111-1111-4111-8111-111111111111';
    const record = createWorkSessionRecord(ctxRoot, {
      id: `ws-${mutationId}`, display_name: 'Native output', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd,
      room_id: `work-${mutationId}`, mutation_id: mutationId, created_by: 'owner:test',
    });
    const manager = new WorkSessionManager({ ctxRoot, adapterFactory: () => { throw new Error('unused'); } });
    const adapter = new WorkSessionPTY({
      ctxRoot, frameworkRoot: root, instanceId: 'test', record, timeoutMs: 3_000,
      onOutput: output => manager.recordRuntimeOutput(record.id, output),
    });
    await adapter.startFresh({ id: record.id, mutation_id: mutationId, cwd });
    await adapter.send('answer me');
    await new Promise(resolve => setTimeout(resolve, 100));
    manager.recordRuntimeOutput(record.id, { id: 'native-answer', text: 'native durable answer' });

    const output = readRoomLog(ctxRoot, record.room_id).filter(message => message.source === 'work_session');
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      from: record.id, to: record.created_by, text: 'native durable answer', delivery_state: 'delivered',
    });
    await adapter.stop();
  }, 10_000);

  it('terminates a live exact owner with no discovered handle and finalizes recoverable failure', async () => {
    const { root, cwd, ctxRoot } = fixture();
    const mutationId = 'd3111111-1111-4111-8111-111111111111';
    const input = { display_name: 'No handle', org: 'platform', harness: 'codex-app-server' as const, requested_cwd: cwd, actor: 'owner:test' };
    const record = createWorkSessionRecord(ctxRoot, {
      id: `ws-${mutationId}`, display_name: input.display_name, org: input.org, harness: input.harness,
      requested_cwd: cwd, room_id: `work-${mutationId}`, mutation_id: mutationId, created_by: input.actor,
    });
    prepareCrewMutation(ctxRoot, {
      mutation_id: mutationId, idempotency_key: mutationId, actor: input.actor,
      target: { kind: 'work_session', id: record.id }, action: 'create',
      request_digest: digestCrewAuditValue({ ...input, actor: undefined }), before_digest: digestCrewAuditValue(null), intended_after_digest: '3'.repeat(64),
    });
    commitCrewMutationState(ctxRoot, mutationId, '4'.repeat(64));
    startCrewMutationEffect(ctxRoot, mutationId);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    const owner = await captureProcessIdentity(child.pid!);
    mkdirSync(join(ctxRoot, 'state', 'work-sessions', record.id), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'work-sessions', record.id, 'runtime-owner.json'), JSON.stringify({
      schema_version: 1, session_id: record.id, runtime_owner: { ...owner!, mutation_id: mutationId }, resume_handle: null,
    }));
    const manager = new WorkSessionManager({
      ctxRoot,
      adapterFactory: current => new WorkSessionPTY({ ctxRoot, frameworkRoot: root, instanceId: 'test', record: current, timeoutMs: 2_000 }),
    });
    expect(await manager.reconcilePending()).toMatchObject({ pending: 0 });
    expect(manager.get(record.id)).toMatchObject({ lifecycle: 'failed', last_error: 'RESUME_HANDLE_MISSING', runtime_owner: null });
    expect(probeProcessIdentity(owner!)).toBe('dead');
  }, 10_000);

  it('converges an effect_started create from the durable native spawn receipt without launching twice', async () => {
    const { root, cwd, ctxRoot } = fixture();
    const mutationId = 'd2111111-1111-4111-8111-111111111111';
    const input = {
      display_name: 'Crash boundary', org: 'platform', harness: 'codex-app-server' as const,
      requested_cwd: cwd, actor: 'owner:test',
    };
    const record = createWorkSessionRecord(ctxRoot, {
      id: `ws-${mutationId}`, display_name: input.display_name, org: input.org, harness: input.harness,
      requested_cwd: cwd, room_id: `work-${mutationId}`, mutation_id: mutationId, created_by: input.actor,
    });
    prepareCrewMutation(ctxRoot, {
      mutation_id: mutationId, idempotency_key: mutationId, actor: input.actor,
      target: { kind: 'work_session', id: record.id }, action: 'create',
      request_digest: digestCrewAuditValue({ ...input, actor: undefined }),
      before_digest: digestCrewAuditValue(null), intended_after_digest: '1'.repeat(64),
    });
    commitCrewMutationState(ctxRoot, mutationId, '2'.repeat(64));
    startCrewMutationEffect(ctxRoot, mutationId);
    const firstAdapter = new WorkSessionPTY({ ctxRoot, frameworkRoot: root, instanceId: 'test', record, timeoutMs: 3_000 });
    const spawned = await firstAdapter.startFresh({ id: record.id, mutation_id: mutationId, cwd });

    const manager = new WorkSessionManager({
      ctxRoot,
      adapterFactory: current => new WorkSessionPTY({ ctxRoot, frameworkRoot: root, instanceId: 'test', record: current, timeoutMs: 3_000 }),
    });
    const recovered = await manager.create(input, mutationId);
    expect(recovered).toMatchObject({
      lifecycle: 'active', resume_handle: spawned.resume_handle,
      runtime_owner: spawned.runtime_owner,
    });
    await manager.stop(recovered.id, input.actor, 'd2222222-2222-4222-8222-222222222222');
  }, 10_000);
});
