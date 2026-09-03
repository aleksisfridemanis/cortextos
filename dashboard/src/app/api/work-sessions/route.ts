import { NextRequest } from 'next/server';
import { IPCClient } from '@/lib/ipc-client';
import { checkCrewRateLimit } from '@/lib/rate-limit';
import { authenticatedWorkSessionOwner } from '@/lib/work-session-owner';
import { publicWorkSession } from '@/lib/public-work-session';
export { publicWorkSession } from '@/lib/public-work-session';

export const dynamic = 'force-dynamic';
const BODY_MAX = 131_072;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RouteError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly mutationId?: string) { super(message); }
}

async function actor(request?: NextRequest): Promise<string> {
  const principal = await authenticatedWorkSessionOwner(request);
  if (!principal) throw new RouteError('UNAUTHENTICATED', 401, 'Authentication required');
  return principal;
}

export async function readBoundedJson(request: NextRequest): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > BODY_MAX) throw new RouteError('BODY_TOO_LARGE', 413, 'Request body is too large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_MAX) throw new RouteError('BODY_TOO_LARGE', 413, 'Request body is too large');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); } catch { throw new RouteError('INVALID_BODY', 400, 'Invalid JSON body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RouteError('INVALID_BODY', 400, 'Request body must be an object');
  return value as Record<string, unknown>;
}

function statusFor(code?: string): number {
  if (code === 'CONTEXT_BUDGET_EXCEEDED') return 413;
  if (code === 'NOT_FOUND' || code === 'CWD_NOT_FOUND') return 404;
  if (code === 'CWD_NOT_DIRECTORY' || code === 'CWD_UNREADABLE') return 400;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'CWD_LEASE_CONFLICT' || code === 'INVALID_TRANSITION' || code === 'RESUME_HANDLE_MISSING') return 409;
  if (['REGISTRY_CORRUPT', 'RECOVERY_REQUIRED', 'MUTATION_PENDING', 'CREW_RECOVERY_REQUIRED', 'MUTATION_OUTCOME_UNKNOWN'].includes(code ?? '')) return 503;
  if (code?.endsWith('_FAILED') || code === 'RESUME_HANDLE_UNAVAILABLE') return 500;
  return 400;
}

export async function GET(request?: NextRequest) {
  try {
    const owner = await actor(request);
    const response = await new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default').send({ type: 'list-work-sessions', source: 'dashboard', data: { actor: owner } });
    if (!response.success) throw new RouteError(response.code ?? 'LIST_FAILED', statusFor(response.code), 'Unable to list Work Sessions');
    return Response.json({ sessions: Array.isArray(response.data) ? response.data.map(publicWorkSession) : [] });
  } catch (error) {
    const route = error instanceof RouteError ? error : new RouteError('LIST_FAILED', 500, 'Unable to list Work Sessions');
    return Response.json({ error: route.message, code: route.code }, { status: route.status });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get('x-cortext-intent') !== 'create-work-session') throw new RouteError('INVALID_INTENT', 400, 'Invalid Work Session creation intent');
    const owner = await actor(request);
    const rate = checkCrewRateLimit(owner, 'lifecycle');
    if (!rate.allowed) return Response.json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfter ?? 60) } });
    const mutationId = request.headers.get('x-cortext-mutation-id') ?? '';
    if (!UUID.test(mutationId)) throw new RouteError('INVALID_MUTATION_ID', 400, 'Valid mutation id required');
    const body = await readBoundedJson(request);
    if ('actor' in body || 'resume_handle' in body) throw new RouteError('FORGED_SERVER_FIELD', 400, 'Server-owned field supplied');
    const response = await new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default').send({
      type: 'create-work-session', source: 'dashboard', mutation_id: mutationId,
      data: { display_name: body.display_name, org: body.org, harness: body.harness, requested_cwd: body.requested_cwd, model: body.model, initial_request: body.initial_request, actor: owner },
    });
    if (!response.success) throw new RouteError(response.code ?? 'CREATE_FAILED', statusFor(response.code), 'Unable to create Work Session', mutationId);
    const data = response.data as { session?: unknown };
    return Response.json({ ...data, session: publicWorkSession(data?.session) }, { status: 201 });
  } catch (error) {
    const route = error instanceof RouteError ? error : new RouteError('CREATE_FAILED', 500, 'Unable to create Work Session');
    return Response.json({
      error: route.message, code: route.code, ...(route.mutationId ? { mutation_id: route.mutationId } : {}),
    }, { status: route.status });
  }
}
