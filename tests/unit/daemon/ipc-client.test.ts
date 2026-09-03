import { createServer } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { once } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import { coreIpcRequestDeadline, IPCClient } from '../../../src/daemon/ipc-server.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('core daemon IPC client mutation outcomes', () => {
  it('uses a deadline beyond Employee bootstrap and returns the original id on timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-core-ipc-'));
    roots.push(root);
    const socketPath = join(root, 'daemon.sock');
    const server = createServer(socket => {
      socket.on('error', () => undefined);
      socket.on('data', () => setTimeout(() => socket.end(JSON.stringify({ success: true })), 100));
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const client = new IPCClient('test') as unknown as { socketPath: string; send: IPCClient['send'] };
    client.socketPath = socketPath;
    const mutationId = '12345678-1234-4234-8234-123456789012';
    expect(coreIpcRequestDeadline({ type: 'start-employee-mutation', mutation_id: mutationId })).toBeGreaterThan(45_000);
    const response = await client.send({ type: 'start-employee-mutation', mutation_id: mutationId }, 20);
    expect(response).toMatchObject({ success: false, code: 'MUTATION_OUTCOME_UNKNOWN', data: { mutation_id: mutationId } });
    server.close();
    await once(server, 'close');
  });
});
