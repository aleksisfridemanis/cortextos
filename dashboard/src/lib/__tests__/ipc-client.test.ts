import { createServer } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { once } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import { IPCClient, ipcRequestDeadline } from '../ipc-client';

const roots: string[] = [];
afterEach(() => {
  delete process.env.CORTEXT_PLAYWRIGHT_FAKE_IPC;
  delete process.env.CORTEXT_PLAYWRIGHT_IPC_PATH;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('IPC request deadlines', () => {
  it('outlives daemon Work Session and Employee mutation bounds', () => {
    expect(ipcRequestDeadline({ type: 'create-work-session', mutation_id: 'mutation' })).toBeGreaterThan(45_000);
    expect(ipcRequestDeadline({ type: 'status' })).toBe(5_000);
  });

  it('returns the original mutation id when a daemon outcome exceeds the client deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-ipc-deadline-'));
    roots.push(root);
    const socketPath = join(root, 'daemon.sock');
    const server = createServer(socket => {
      socket.on('error', () => undefined);
      socket.on('data', () => setTimeout(() => socket.end(JSON.stringify({ success: true })), 100));
    });
    server.listen(socketPath);
    await once(server, 'listening');
    process.env.CORTEXT_PLAYWRIGHT_FAKE_IPC = '1';
    process.env.CORTEXT_PLAYWRIGHT_IPC_PATH = socketPath;

    const mutationId = '33333333-3333-4333-8333-333333333333';
    const response = await new IPCClient().send({ type: 'create-work-session', mutation_id: mutationId }, 20);
    expect(response).toEqual(expect.objectContaining({
      success: false, code: 'MUTATION_OUTCOME_UNKNOWN', data: { mutation_id: mutationId },
    }));
    server.close();
    await once(server, 'close');
  });
});
