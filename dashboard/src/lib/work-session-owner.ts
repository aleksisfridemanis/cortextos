import { auth } from '@/lib/auth';

export function workSessionOwnerPrincipal(userId: unknown): string | null {
  return typeof userId === 'string' && userId.length > 0 ? `owner:${userId}` : null;
}

export async function authenticatedWorkSessionOwner(): Promise<string | null> {
  const session = await auth();
  return workSessionOwnerPrincipal(session?.user?.id);
}
