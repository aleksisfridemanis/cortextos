import { NextRequest } from 'next/server';
import { authenticatedWorkSessionOwner } from '@/lib/work-session-owner';
import { browseHostDirectory } from '@/lib/host-paths';
import { checkCrewRateLimit } from '@/lib/rate-limit';
import { publicApplicationError } from '@/lib/application-error';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const actor = await authenticatedWorkSessionOwner(request);
  if (!actor) return Response.json({ error: 'Authentication required', code: 'UNAUTHENTICATED' }, { status: 401 });
  const rate = checkCrewRateLimit(actor, 'browse');
  if (!rate.allowed) return Response.json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfter ?? 60) } });
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return Response.json({ error: 'Browse unavailable', code: 'SERVER_MISCONFIGURED' }, { status: 503 });
  try {
    const requestedPath = request.nextUrl.searchParams.get('path') ?? '';
    const rawLimit = request.nextUrl.searchParams.get('limit');
    const result = browseHostDirectory(requestedPath, {
      limit: rawLimit === null ? undefined : Number(rawLimit),
      cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
      secret,
    });
    return Response.json(result);
  } catch (error) {
    const mapped = publicApplicationError(error instanceof Error ? error.message : undefined);
    return Response.json({ error: 'Directory cannot be browsed', code: mapped.code }, { status: mapped.status });
  }
}
