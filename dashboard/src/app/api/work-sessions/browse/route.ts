import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { browseHostDirectory } from '@/lib/host-paths';
import { checkCrewRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: 'Authentication required', code: 'UNAUTHENTICATED' }, { status: 401 });
  const actor = `owner:${session.user.id}`;
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
    const code = (error as Error).message;
    const status = ['PATH_UNAVAILABLE', 'PATH_UNREADABLE'].includes(code) ? 404 : 400;
    return Response.json({ error: 'Directory cannot be browsed', code }, { status });
  }
}
