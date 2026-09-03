import { createHash, createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface HostPathEntry {
  name: string;
  kind: 'directory' | 'file' | 'other';
  canonical_path: string | null;
  readable: boolean;
  symlink: boolean;
  warning: 'symlink' | 'broken_symlink' | null;
}

interface CursorPayload { directory_digest: string; last_kind: number; last_name: string }
function directoryDigest(directory: string): string { return createHash('sha256').update(directory).digest('hex'); }
function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}
function decodeCursor(cursor: string, secret: string): CursorPayload {
  const [body, signature, extra] = cursor.split('.');
  if (!body || !signature || extra) throw new Error('INVALID_CURSOR');
  const expected = createHmac('sha256', secret).update(body).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { throw new Error('INVALID_CURSOR'); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('INVALID_CURSOR');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('INVALID_CURSOR'); }
  const parsed = value as CursorPayload;
  if (!parsed || typeof parsed.directory_digest !== 'string' || typeof parsed.last_kind !== 'number' || typeof parsed.last_name !== 'string') throw new Error('INVALID_CURSOR');
  return parsed;
}

function sortKey(entry: HostPathEntry): [number, string] { return [entry.kind === 'directory' ? 0 : 1, entry.name]; }
function compareEntry(a: HostPathEntry, b: HostPathEntry): number {
  const [ak, an] = sortKey(a); const [bk, bn] = sortKey(b);
  if (ak !== bk) return ak - bk;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function hostPathAccessMode(kind: 'directory' | 'file'): number {
  return kind === 'directory' ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK;
}

export function browseHostDirectory(requestedPath: string, options: { limit?: number; cursor?: string; secret: string }) {
  if (!path.isAbsolute(requestedPath)) throw new Error('PATH_NOT_ABSOLUTE');
  let canonical: string;
  let stat: fs.Stats;
  try { canonical = fs.realpathSync(requestedPath); stat = fs.statSync(canonical); } catch { throw new Error('PATH_UNAVAILABLE'); }
  if (!stat.isDirectory()) throw new Error('PATH_NOT_DIRECTORY');
  try { fs.accessSync(canonical, hostPathAccessMode('directory')); } catch { throw new Error('PATH_UNREADABLE'); }
  const limit = Math.min(200, Math.max(1, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 100));
  let after: CursorPayload | null = null;
  if (options.cursor) {
    after = decodeCursor(options.cursor, options.secret);
    if (after.directory_digest !== directoryDigest(canonical)) throw new Error('CURSOR_DIRECTORY_MISMATCH');
  }
  const entries: HostPathEntry[] = fs.readdirSync(canonical, { withFileTypes: true }).map((dirent): HostPathEntry => {
    const lexical = path.join(canonical, dirent.name);
    const symlink = dirent.isSymbolicLink();
    let real: string | null = null;
    let target: fs.Stats | null = null;
    let readable = false;
    try {
      real = fs.realpathSync(lexical);
      target = fs.statSync(real);
      fs.accessSync(real, hostPathAccessMode(target.isDirectory() ? 'directory' : 'file'));
      readable = true;
    } catch {}
    const kind: HostPathEntry['kind'] = target?.isDirectory() ? 'directory' : target?.isFile() ? 'file' : 'other';
    const warning: HostPathEntry['warning'] = symlink ? (real ? 'symlink' : 'broken_symlink') : null;
    return {
      name: dirent.name,
      kind,
      canonical_path: real,
      readable,
      symlink,
      warning,
    };
  }).sort(compareEntry);
  const filtered = after ? entries.filter(entry => {
    const [kind, name] = sortKey(entry);
    return kind > after!.last_kind || (kind === after!.last_kind && name > after!.last_name);
  }) : entries;
  const page = filtered.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = filtered.length > page.length && last
    ? encodeCursor({ directory_digest: directoryDigest(canonical), last_kind: sortKey(last)[0], last_name: last.name }, options.secret)
    : null;
  return { canonical_path: canonical, entries: page, next_cursor: nextCursor };
}
