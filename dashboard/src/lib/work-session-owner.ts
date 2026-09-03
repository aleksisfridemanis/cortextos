import { auth } from '@/lib/auth';
import { verifiedBearerUserId } from '@/lib/request-principal';
import fs from 'fs';
import path from 'path';

export function workSessionOwnerPrincipal(userId: unknown): string | null {
  return typeof userId === 'string' && userId.length > 0 ? `owner:${userId}` : null;
}

export async function authenticatedWorkSessionOwner(request?: Request): Promise<string | null> {
  const bearerUserId = await verifiedBearerUserId(request);
  if (bearerUserId) return workSessionOwnerPrincipal(bearerUserId);
  const session = await auth();
  return workSessionOwnerPrincipal(session?.user?.id);
}

export function ownsWorkSessionRoom(ctxRoot: string, roomId: string, principal: string): boolean {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(ctxRoot, 'config', 'work-sessions.json'), 'utf8')) as unknown;
    return Array.isArray(rows) && rows.some(row => row && typeof row === 'object'
      && (row as Record<string, unknown>).room_id === roomId
      && (row as Record<string, unknown>).created_by === principal);
  } catch {
    return false;
  }
}
