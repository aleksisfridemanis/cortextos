import { jwtVerify } from 'jose';

/** Verify a mobile Bearer credential and return its immutable user id. */
export async function verifiedBearerUserId(request?: Request): Promise<string | null> {
  const header = request?.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const secretValue = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secretValue) return null;
  try {
    const options = {
      ...(process.env.AUTH_JWT_ISSUER ? { issuer: process.env.AUTH_JWT_ISSUER } : {}),
      ...(process.env.AUTH_JWT_AUDIENCE ? { audience: process.env.AUTH_JWT_AUDIENCE } : {}),
    };
    const { payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(secretValue), options);
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}
