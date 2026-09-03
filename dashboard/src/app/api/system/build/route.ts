import packageMetadata from '../../../../../../package.json';

export const dynamic = 'force-dynamic';
const SHA = /^[0-9a-f]{40}$/;

export async function GET() {
  const sha = process.env.CORTEXT_BUILD_SHA?.toLowerCase() ?? '';
  if (!SHA.test(sha)) return Response.json({ error: 'Build identity unavailable', code: 'BUILD_IDENTITY_UNAVAILABLE' }, { status: 503 });
  return Response.json({ version: packageMetadata.version, sha });
}
