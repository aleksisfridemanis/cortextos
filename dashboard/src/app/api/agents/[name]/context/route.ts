import { NextRequest } from 'next/server';
import { authenticatedWorkSessionOwner } from '@/lib/work-session-owner';
import { IPCClient } from '@/lib/ipc-client';
import { publicApplicationError } from '@/lib/application-error';

export const dynamic = 'force-dynamic';
const BODY_MAX = 131_072;

export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const owner = await authenticatedWorkSessionOwner(request);
  if (!owner) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const { name } = await params;
  const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
  const response = await ipc.send({
    type: 'context-review',
    data: { agentName: decodeURIComponent(name), rule_id: 'employee-core', actor: owner },
  });
  if (!response.success) {
    const mapped = publicApplicationError(response.code, 'CONTEXT_SOURCE_UNAVAILABLE');
    return Response.json({ error: 'Context review unavailable', code: mapped.code }, { status: mapped.status });
  }
  return Response.json(response.data);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const owner = await authenticatedWorkSessionOwner(request);
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
  if (!response.success) {
    const mapped = publicApplicationError(response.code);
    return Response.json({
    error: 'Context decision rejected', code: mapped.code,
    mutation_id: request.headers.get('x-cortext-mutation-id') ?? '',
    }, { status: mapped.status });
  }
  return Response.json(response.data);
}
