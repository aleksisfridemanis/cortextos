import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { getCTXRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_MULTIPART_OVERHEAD = 128 * 1024;
const MAX_HEADER_SIZE = 64 * 1024;

function cleanupSecret(): string | null {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? null;
}

function cleanupToken(relativePath: string): string | null {
  const secret = cleanupSecret();
  return secret ? createHmac('sha256', secret).update(relativePath).digest('hex') : null;
}

// Whitelist by MIME type AND by extension. SVG is intentionally excluded:
// SVGs can carry inline <script> and embedded event handlers, which turns
// any "view the image" link into an XSS vector when served from the same
// origin as the dashboard.
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Canonical extension per MIME type. The server IGNORES the user-supplied
// filename's extension and chooses the extension from the validated MIME
// type, so an attacker cannot upload `evil.html` with `image/png` content-type.
const EXT_FOR_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * POST /api/comms/upload — Upload an image for the chat interface.
 *
 * Accepts multipart/form-data with a single "file" field.
 * Saves to {CTX_ROOT}/media/dashboard-uploads/{timestamp}-{sanitized-name}
 * Returns { path: "media/dashboard-uploads/...", url: "/api/media/media/dashboard-uploads/..." }
 *
 * Used by the chat bar image attach button AND the clipboard paste handler —
 * both feed into the same endpoint so the media layout is consistent.
 */
export async function POST(request: NextRequest) {
  const ctxRoot = getCTXRoot();
  const uploadDir = path.join(ctxRoot, 'media', 'dashboard-uploads');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SIZE + MAX_MULTIPART_OVERHEAD) {
    return Response.json({ error: 'File too large (max 10 MB)' }, { status: 400 });
  }

  let tempPath: string | null = null;
  let publishedPath: string | null = null;
  try {
    fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
    sweepStaleUploadTemps(uploadDir);
    const parsed = await streamMultipartImage(request, uploadDir);
    tempPath = parsed.tempPath;

    // Sanitize filename. We keep only the basename of the client-supplied
    // name, strip any extension/path separators, and then append a
    // server-chosen extension derived from the validated MIME type.
    // This prevents attackers from smuggling `evil.html.png` or
    // `../../etc/passwd` through the upload endpoint.
    const rawName = parsed.name || 'upload';
    const rawBase = path.basename(rawName);
    const baseNoExt = rawBase.replace(/\.[^.]*$/, '');
    const baseName = baseNoExt
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50) || 'upload';
    const ext = EXT_FOR_TYPE[parsed.type];
    if (!ext) {
      // Defense-in-depth: ALLOWED_TYPES already gated this, but if someone
      // widens the set without updating EXT_FOR_TYPE we refuse rather than
      // fall through to an empty extension.
      return Response.json({ error: 'Unsupported file type' }, { status: 400 });
    }
    const filename = `${randomUUID()}-${baseName}${ext}`;
    const filePath = path.join(uploadDir, filename);

    // Defense-in-depth: ensure the resolved path is still inside uploadDir.
    // The sanitizer above should already guarantee this, but we verify.
    const resolvedUploadDir = path.resolve(uploadDir);
    const resolvedFilePath = path.resolve(filePath);
    if (!resolvedFilePath.startsWith(resolvedUploadDir + path.sep)) {
      return Response.json({ error: 'Invalid filename' }, { status: 400 });
    }

    // link(2) is an atomic exclusive publication: even an impossible UUID
    // collision cannot overwrite another upload. The private temp identity is
    // removed only after the unique final name exists.
    fs.linkSync(parsed.tempPath, filePath);
    publishedPath = filePath;
    fs.unlinkSync(parsed.tempPath);
    tempPath = null;

    const relativePath = `media/dashboard-uploads/${filename}`;
    const mediaUrl = `/api/media/${relativePath}`;

    const response = Response.json({
      success: true,
      path: relativePath,
      url: mediaUrl,
      filename,
      size: parsed.size,
      ...(cleanupToken(relativePath) ? { cleanup_token: cleanupToken(relativePath) } : {}),
    });
    publishedPath = null;
    return response;
  } catch (err) {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch { /* already removed */ }
    if (publishedPath) try { fs.unlinkSync(publishedPath); } catch { /* sweeper handles validated stale temp */ }
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'FILE_TOO_LARGE') return Response.json({ error: 'File too large (max 10 MB)' }, { status: 400 });
    if (message === 'NO_FILE') return Response.json({ error: 'No file provided' }, { status: 400 });
    if (message === 'UNSUPPORTED_FILE_TYPE') return Response.json({ error: 'Unsupported file type. Allowed: JPEG, PNG, GIF, WebP' }, { status: 400 });
    if (message === 'INVALID_MULTIPART') return Response.json({ error: 'Invalid form data' }, { status: 400 });
    console.error('[api/comms/upload] Error:', message);
    return Response.json({ error: 'Upload failed' }, { status: 500 });
  }
}

export function sweepStaleUploadTemps(uploadDir: string, now = Date.now()): number {
  let removed = 0;
  for (const name of fs.readdirSync(uploadDir)) {
    if (!/^\.upload-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(name)) continue;
    const candidate = path.join(uploadDir, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && now - stat.mtimeMs >= 60 * 60 * 1000) {
        fs.unlinkSync(candidate);
        removed += 1;
      }
    } catch { /* raced cleanup or inaccessible entry */ }
  }
  return removed;
}

interface StreamedUpload { tempPath: string; name: string; type: string; size: number }

/** Stream the single file part to an exclusive temp inode with a hard byte cap. */
async function streamMultipartImage(request: NextRequest, uploadDir: string): Promise<StreamedUpload> {
  const contentType = request.headers.get('content-type') ?? '';
  const boundaryMatch = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))$/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 200 || !request.body) throw new Error('INVALID_MULTIPART');
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const reader = request.body.getReader();
  const tempPath = path.join(uploadDir, `.upload-${randomUUID()}.tmp`);
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  let header = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let name = '';
  let type = '';
  let size = 0;
  let headersDone = false;
  let finished = false;
  const write = (bytes: Buffer) => {
    if (size + bytes.length > MAX_SIZE) throw new Error('FILE_TOO_LARGE');
    if (bytes.length) fs.writeSync(fd, bytes);
    size += bytes.length;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = Buffer.from(value);
      if (finished) {
        if (chunk.toString('utf8').trim()) throw new Error('INVALID_MULTIPART');
        continue;
      }
      if (!headersDone) {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf('\r\n\r\n');
        if (end < 0) {
          if (header.length > MAX_HEADER_SIZE) throw new Error('INVALID_MULTIPART');
          continue;
        }
        if (end > MAX_HEADER_SIZE) throw new Error('INVALID_MULTIPART');
        const raw = header.subarray(0, end).toString('utf8');
        if (!raw.startsWith(`--${boundary}\r\n`)) throw new Error('INVALID_MULTIPART');
        const disposition = /content-disposition:\s*form-data;\s*name="file";\s*filename="([^"]*)"/i.exec(raw);
        const mime = /content-type:\s*([^\r\n;]+)/i.exec(raw)?.[1]?.trim().toLowerCase();
        if (!disposition) throw new Error('NO_FILE');
        if (!mime || !ALLOWED_TYPES.has(mime)) throw new Error('UNSUPPORTED_FILE_TYPE');
        name = disposition[1];
        type = mime;
        chunk = header.subarray(end + 4);
        header = Buffer.alloc(0);
        headersDone = true;
      }
      const combined = Buffer.concat([tail, chunk]);
      const boundaryAt = combined.indexOf(delimiter);
      if (boundaryAt >= 0) {
        if (combined.length < boundaryAt + delimiter.length + 2) {
          write(combined.subarray(0, boundaryAt));
          tail = combined.subarray(boundaryAt);
          continue;
        }
        write(combined.subarray(0, boundaryAt));
        const ending = combined.subarray(boundaryAt + delimiter.length).toString('utf8');
        if (!ending.startsWith('--') || ending.slice(2).trim()) throw new Error('INVALID_MULTIPART');
        tail = Buffer.alloc(0);
        finished = true;
      } else {
        const retained = Math.min(combined.length, delimiter.length + 4);
        write(combined.subarray(0, combined.length - retained));
        tail = combined.subarray(combined.length - retained);
      }
    }
    if (!headersDone || !finished) throw new Error(headersDone ? 'INVALID_MULTIPART' : 'NO_FILE');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return { tempPath, name, type, size };
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(tempPath); } catch { /* already removed */ }
    try { await reader.cancel(); } catch { /* stream already ended */ }
    throw error;
  }
}

/** Delete only uploads whose unforgeable cleanup capability was returned by POST. */
export async function DELETE(request: NextRequest) {
  if (request.headers.get('x-cortext-intent') !== 'cleanup-chat-uploads') {
    return Response.json({ error: 'Invalid cleanup intent' }, { status: 400 });
  }
  const secret = cleanupSecret();
  if (!secret) return Response.json({ error: 'Upload cleanup unavailable' }, { status: 503 });
  let body: { uploads?: Array<{ url?: unknown; cleanup_token?: unknown }> };
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid cleanup request' }, { status: 400 }); }
  if (!Array.isArray(body.uploads) || body.uploads.length > 10) return Response.json({ error: 'Invalid cleanup request' }, { status: 400 });
  const uploadDir = path.resolve(getCTXRoot(), 'media', 'dashboard-uploads');
  let removed = 0;
  for (const item of body.uploads) {
    if (typeof item.url !== 'string' || typeof item.cleanup_token !== 'string') continue;
    const prefix = '/api/media/media/dashboard-uploads/';
    if (!item.url.startsWith(prefix)) continue;
    const filename = item.url.slice(prefix.length);
    if (!/^[0-9a-f-]{36}-[A-Za-z0-9_-]{1,50}\.(?:jpg|png|gif|webp)$/.test(filename)) continue;
    const relativePath = `media/dashboard-uploads/${filename}`;
    const expected = cleanupToken(relativePath);
    if (!expected || item.cleanup_token.length !== expected.length
      || !timingSafeEqual(Buffer.from(item.cleanup_token), Buffer.from(expected))) continue;
    const target = path.resolve(uploadDir, filename);
    if (!target.startsWith(`${uploadDir}${path.sep}`)) continue;
    try { fs.unlinkSync(target); removed += 1; } catch { /* absent or already retained */ }
  }
  return Response.json({ removed });
}
