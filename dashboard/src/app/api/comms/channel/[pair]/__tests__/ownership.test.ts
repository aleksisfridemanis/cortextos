import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authMock = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: authMock }));

const root = mkdtempSync(join(tmpdir(), 'work-session-room-owner-'));
process.env.CTX_ROOT = root;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('Work Session room ownership', () => {
  beforeEach(() => {
    rmSync(join(root, 'config'), { recursive: true, force: true });
    rmSync(join(root, 'rooms'), { recursive: true, force: true });
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'rooms', 'work-owned'), { recursive: true });
    writeFileSync(join(root, 'config', 'enabled-agents.json'), '{}');
    writeFileSync(join(root, 'config', 'work-sessions.json'), JSON.stringify([
      { id: 'ws-owned', room_id: 'work-owned', created_by: 'owner:1' },
    ]));
    writeFileSync(join(root, 'rooms', 'work-owned', 'log.jsonl'), `${JSON.stringify({
      id: 'secret', room_id: 'work-owned', from: 'ws-owned', to: 'owner:1', timestamp: '2026-09-03T00:00:00Z',
      text: 'private answer', reply_to: null, thread_id: 'secret', source: 'work_session', attachments: [], delivery_state: 'delivered',
    })}\n`);
  });

  async function readAs(userId: string) {
    authMock.mockResolvedValue({ user: { id: userId } });
    const { GET } = await import('../route');
    return GET(new NextRequest('http://localhost/api/comms/channel/room--work-owned?room_id=work-owned'), {
      params: Promise.resolve({ pair: 'room--work-owned' }),
    });
  }

  it('serves history to the exact creator principal', async () => {
    const response = await readAs('1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({ text: 'private answer', delivery_state: 'delivered' })]);
  });

  it('does not reveal another owner room or history', async () => {
    const response = await readAs('2');
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('private answer');
  });
});
