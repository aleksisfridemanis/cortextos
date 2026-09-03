import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { IPCClient } from '@/lib/ipc-client';
import { checkCrewRateLimit } from '@/lib/rate-limit';
import { publicWorkSession, readBoundedJson, RouteError } from '../route';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[a-z0-9_-]{1,128}$/;
type Action = 'stop' | 'resume' | 'promote';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return Response.json({ error: 'Authentication required', code: 'UNAUTHENTICATED' }, { status: 401 });
    const owner = `owner:${session.user.id}`;
    const rate = checkCrewRateLimit(owner, 'lifecycle');
    if (!rate.allowed) return Response.json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfter ?? 60) } });
    const id = (await params).id;
    if (!ID.test(id)) return Response.json({ error: 'Invalid Work Session id', code: 'INVALID_INPUT' }, { status: 400 });
    const mutationId = request.headers.get('x-cortext-mutation-id') ?? '';
    if (!UUID.test(mutationId)) return Response.json({ error: 'Valid mutation id required', code: 'INVALID_MUTATION_ID' }, { status: 400 });
    const body = await readBoundedJson(request);
    const action = body.action as Action;
    if (!['stop', 'resume', 'promote'].includes(action) || request.headers.get('x-cortext-intent') !== `${action}-work-session`) {
      return Response.json({ error: 'Invalid Work Session intent', code: 'INVALID_INTENT' }, { status: 400 });
    }
    if ('actor' in body || 'resume_handle' in body) return Response.json({ error: 'Server-owned field supplied', code: 'FORGED_SERVER_FIELD' }, { status: 400 });
    const type = `${action}-work-session` as 'stop-work-session' | 'resume-work-session' | 'promote-work-session';
    const employee = action === 'promote' && body.employee && typeof body.employee === 'object'
      ? { ...(body.employee as Record<string, unknown>), actor: owner }
      : undefined;
    const result = await new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default').send({ type, source: 'dashboard', mutation_id: mutationId, data: { id, actor: owner, employee } });
    if (!result.success) {
      const status = result.code === 'NOT_FOUND' ? 404 : ['INVALID_TRANSITION', 'RESUME_HANDLE_MISSING'].includes(result.code ?? '') ? 409 : result.code === 'REGISTRY_CORRUPT' ? 503 : 400;
      return Response.json({ error: 'Work Session operation rejected', code: result.code }, { status });
    }
    return Response.json({ session: publicWorkSession(result.data) });
  } catch (error) {
    if (error instanceof RouteError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return Response.json({ error: 'Work Session operation failed', code: 'OPERATION_FAILED' }, { status: 500 });
  }
}
