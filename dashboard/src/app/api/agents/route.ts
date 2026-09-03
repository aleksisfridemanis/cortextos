import { NextRequest } from 'next/server';
import { authenticatedWorkSessionOwner } from '@/lib/work-session-owner';
import { publicApplicationError } from '@/lib/application-error';
import { getAllAgents } from '@/lib/config';
import { getHeartbeat, getHealthStatus } from '@/lib/data/heartbeats';
import { IPCClient } from '@/lib/ipc-client';
import { checkCrewRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
const CREW_BODY_MAX_BYTES = 131_072;

class RouteError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
  }
}

export async function GET() {
  try {
    const agents = getAllAgents();
    return Response.json(await Promise.all(agents.map(async agent => {
      const heartbeat = await getHeartbeat(agent.name);
      return {
        ...agent,
        health: heartbeat ? getHealthStatus(heartbeat) : 'down',
        lastHeartbeat: heartbeat?.last_heartbeat ?? undefined,
        currentTask: heartbeat?.current_task ?? undefined,
        status: heartbeat?.status ?? undefined,
      };
    })));
  } catch {
    return Response.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}

async function readBoundedJson(request: NextRequest): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > CREW_BODY_MAX_BYTES) {
    throw new RouteError('BODY_TOO_LARGE', 413, 'Request body is too large');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > CREW_BODY_MAX_BYTES) throw new RouteError('BODY_TOO_LARGE', 413, 'Request body is too large');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    throw new RouteError('INVALID_BODY', 400, 'Request body must be valid UTF-8');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RouteError('INVALID_BODY', 400, 'Invalid JSON body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteError('INVALID_BODY', 400, 'Request body must be an object');
  }
  return value as Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get('x-cortext-intent') !== 'create-employee') {
      throw new RouteError('INVALID_INTENT', 400, 'Invalid Employee creation intent');
    }
    const actor = await authenticatedWorkSessionOwner(request);
    if (!actor) throw new RouteError('UNAUTHENTICATED', 401, 'Authentication required');
    const rate = checkCrewRateLimit(actor, 'lifecycle');
    if (!rate.allowed) {
      return Response.json(
        { error: 'Rate limit exceeded', code: 'RATE_LIMITED' },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfter ?? 60) } },
      );
    }
    const body = await readBoundedJson(request);
    if (Object.prototype.hasOwnProperty.call(body, 'actor')
      || Object.prototype.hasOwnProperty.call(body, 'source_work_session_id')) {
      throw new RouteError('FORGED_ACTOR', 400, 'Server-owned field supplied');
    }
    const mutationId = request.headers.get('x-cortext-mutation-id') ?? '';
    const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
    const result = await ipc.send({
      type: 'create-employee',
      mutation_id: mutationId,
      data: { ...body, actor },
    });
    if (!result.success) {
      const mapped = publicApplicationError(result.code, 'CREATE_FAILED');
      return Response.json({
        error: 'Failed to create Employee', code: mapped.code, mutation_id: mutationId,
      }, { status: mapped.status });
    }
    return Response.json(result.data, { status: 201 });
  } catch (cause) {
    if (cause instanceof RouteError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: cause.status });
    }
    return Response.json({ error: 'Failed to create Employee', code: 'CREATE_FAILED' }, { status: 500 });
  }
}
