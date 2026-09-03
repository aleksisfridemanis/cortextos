import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot, getAllAgents } from '@/lib/config';
import { IPCClient } from '@/lib/ipc-client';
import { checkCrewRateLimit } from '@/lib/rate-limit';
import { authenticatedWorkSessionOwner } from '@/lib/work-session-owner';

export const dynamic = 'force-dynamic';

/**
 * POST /api/messages/send - Send a message to an agent
 *
 * Writes the message to the agent's inbox directory in the same format
 * as bus/send-message.sh. The agent's fast-checker daemon picks it up
 * on its next inbox check cycle (every 1 second).
 *
 * Body: { agent: string, text: string, type?: string, reply_to?: string }
 * Returns: { success: boolean, messageId: string }
 */

/**
 * reply_to is interpolated RAW into the PTY header the daemon injects
 * (`[reply_to: ...]` in src/daemon/fast-checker.ts formatInboxMessage — it
 * sanitizes `from`, not this). Until this route existed only the signed bus path
 * could set the field. Anything outside a message id is rejected here, at the
 * edge, rather than sanitized downstream.
 */
const REPLY_TO_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > 131_072) return Response.json({ error: 'Request body is too large' }, { status: 413 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 131_072) return Response.json({ error: 'Request body is too large' }, { status: 413 });
    body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.target_kind === 'work_session') {
    const actor = await authenticatedWorkSessionOwner();
    if (!actor) return Response.json({ error: 'Authentication required' }, { status: 401 });
    const rate = checkCrewRateLimit(actor, 'message');
    if (!rate.allowed) return Response.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfter ?? 60) } });
    const id = typeof body.work_session_id === 'string' ? body.work_session_id : '';
    const text = typeof body.text === 'string' ? body.text : '';
    if (!/^[a-z0-9_-]{1,128}$/.test(id)) return Response.json({ error: 'Invalid Work Session id' }, { status: 400 });
    if (!text) return Response.json({ error: 'text is required' }, { status: 400 });
    if (Buffer.byteLength(text, 'utf8') > 65_536) return Response.json({ error: 'Message is too large' }, { status: 413 });
    const mutationId = request.headers.get('x-cortext-mutation-id') ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mutationId)) {
      return Response.json({ error: 'Valid mutation id required' }, { status: 400 });
    }
    const result = await new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default').send({
      type: 'inject-work-session', source: 'dashboard', mutation_id: mutationId,
      data: { id, text, actor },
    });
    if (!result.success) {
      const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : result.code === 'INVALID_TRANSITION' ? 409 : result.code === 'REGISTRY_CORRUPT' ? 503 : 500;
      return Response.json({ error: status === 409 ? 'Resume the Work Session before sending' : 'Unable to send Work Session message', code: result.code }, { status });
    }
    return Response.json({ success: true, messageId: mutationId }, { status: 200 });
  }

  const { agent, text, type, reply_to } = body as {
    agent?: string;
    text?: string;
    type?: string;
    reply_to?: string;
  };

  if (!agent || typeof agent !== 'string') {
    return Response.json({ error: 'agent is required' }, { status: 400 });
  }
  if (!/^[a-z0-9_-]+$/.test(agent)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  if (!text || typeof text !== 'string') {
    return Response.json({ error: 'text is required' }, { status: 400 });
  }
  if (Buffer.byteLength(text, 'utf8') > 65_536) return Response.json({ error: 'Message is too large' }, { status: 413 });
  if (reply_to !== undefined && (typeof reply_to !== 'string' || !REPLY_TO_PATTERN.test(reply_to))) {
    return Response.json({ error: 'Invalid reply_to' }, { status: 400 });
  }

  // Verify the agent actually exists in the registry (defense against
  // path traversal / arbitrary inbox creation even with a valid-looking name).
  const knownAgents = getAllAgents();
  if (!knownAgents.some((a) => a.name === agent)) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }

  const ctxRoot = getCTXRoot();

  // Sender identity: use the dashboard admin username so chat bar messages
  // land in the same channel as Telegram messages for the same user.
  const epochMs = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const from = (process.env.ADMIN_USERNAME ?? 'user').toLowerCase();
  const messageId = `${epochMs}-${from}-${rand}`;

  // Priority 2 = normal (matches bus/send-message.sh mapping)
  const filename = `2-${epochMs}-from-${from}-${rand}.json`;

  const inboxDir = path.join(ctxRoot, 'inbox', agent);
  const tmpPath = path.join(inboxDir, `.tmp.${filename}`);
  const finalPath = path.join(inboxDir, filename);

  try {
    // Ensure inbox directory exists
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }

    // Build message JSON (same schema as bus/send-message.sh)
    const message = {
      id: messageId,
      from: from,
      to: agent,
      priority: 'normal',
      timestamp: new Date().toISOString(),
      text: text,
      reply_to: reply_to ?? null,
    };

    // Atomic write: temp file then rename (same pattern as send-message.sh)
    fs.writeFileSync(tmpPath, JSON.stringify(message) + '\n');
    fs.renameSync(tmpPath, finalPath);

    // Wake the target agent's fast-checker instantly via SIGUSR1
    const pidFile = path.join(ctxRoot, 'state', agent, '.fast-checker.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid > 0) {
          process.kill(pid, 'SIGUSR1');
        }
      } catch {
        // Fast-checker may not be running
      }
    }

    // Log the inbound message for history
    const logDir = path.join(ctxRoot, 'logs', agent);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'inbound-messages.jsonl');
    const logEntry = JSON.stringify({
      id: messageId,
      timestamp: new Date().toISOString(),
      agent,
      direction: 'inbound',
      type: type || 'text',
      text,
      from_name: from,
      source: 'dashboard',
    });
    fs.appendFileSync(logFile, logEntry + '\n');

    return Response.json({ success: true, messageId }, { status: 200 });
  } catch (err: unknown) {
    // Clean up temp file on error
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch { /* ignore */ }

    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/messages/send] Error:', message);
    return Response.json(
      { error: 'Failed to send message', details: message },
      { status: 500 }
    );
  }
}
