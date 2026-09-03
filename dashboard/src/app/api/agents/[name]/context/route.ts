import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';
const BODY_MAX = 131_072;

async function actor(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ? `owner:${session.user.id}` : null;
}

function statusFor(code?: string): number {
  if (code === 'EMPLOYEE_NOT_FOUND') return 404;
  if (code === 'STALE_PROPOSAL' || code === 'IDEMPOTENCY_CONFLICT') return 409;
  if (code === 'MUTATION_PENDING') return 503;
  return 400;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const owner = await actor();
  if (!owner) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const { name } = await params;
  const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
  const response = await ipc.send({
    type: 'context-review',
    data: { agentName: decodeURIComponent(name), rule_id: 'employee-core', actor: owner },
  });
  if (!response.success) return Response.json({ error: response.error ?? 'Context review unavailable', code: response.code }, { status: statusFor(response.code) });
  return Response.json(response.data);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const owner = await actor();
  if (!owner) return Response.json({ error: 'Authentication required' }, { status: 401 });
  if (request.headers.get('x-cortext-intent') !== 'context-owner-decision') {
    return Response.json({ error: 'Invalid context decision intent' }, { status: 400 });
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > BODY_MAX) return Response.json({ error: 'Request body is too large' }, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_MAX) return Response.json({ error: 'Request body is too large' }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.prototype.hasOwnProperty.call(body, 'actor')
    || Object.prototype.hasOwnProperty.call(body, 'target')
    || Object.prototype.hasOwnProperty.call(body, 'agentName')) {
    return Response.json({ error: 'Actor and target are server-derived' }, { status: 400 });
  }
  const { name } = await params;
  const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
  const response = await ipc.send({
    type: 'context-owner-decision',
    mutation_id: request.headers.get('x-cortext-mutation-id') ?? '',
    data: {
      agentName: decodeURIComponent(name),
      actor: owner,
      decision: body.decision,
      rule_id: body.rule_id,
      proposal_digest: body.proposal_digest,
      replacement: body.replacement,
    },
  });
  if (!response.success) return Response.json({ error: response.error ?? 'Context decision rejected', code: response.code }, { status: statusFor(response.code) });
  return Response.json(response.data);
}
