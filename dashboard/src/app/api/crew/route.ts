import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';
import { resolveIdentity } from '@/lib/comms-identity';
import { readPairSummary, readRoomLog } from '@/lib/rooms';
import { findAvatarFile } from '@/lib/crew-avatars';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

export interface CrewMember {
  targetId: string;
  kind: 'employee' | 'work_session';
  name: string;
  org: string;
  enabled: boolean;
  tagline: string;
  /** mtimeMs of the uploaded avatar image, null when the agent has no
   *  custom art yet (the UI renders a generated critter instead). Doubles
   *  as the cache-busting version for /api/avatars/[agent]?v=. */
  avatarVersion: number | null;
  /** ISO timestamp of the last message in this agent's DM room, null when
   *  the conversation is empty. Drives roster sort-by-recency. */
  lastActivity: string | null;
  /** Preview text of that last message, null when empty. */
  lastPreview: string | null;
  roomId?: string;
  lifecycle?: 'starting' | 'active' | 'stopping' | 'archived' | 'failed';
  harness?: 'claude-code' | 'codex-app-server' | 'opencode';
  resumable?: boolean;
}

/**
 * Default one-liners per agent. Overridable without a deploy by editing
 * <ctxRoot>/avatars/cards.json — { "<agent>": { "tagline": "..." } }.
 * Unknown agents fall back to their org name.
 */
const DEFAULT_TAGLINES: Record<string, string> = {
  orchestrator: 'Runs the show',
  analyst: 'Lives in the numbers',
  researcher: 'Down every rabbit hole',
  'inbox-agent': 'Keeps the inbox at zero',
  'aih-agent': 'Minding the AIH community',
  'aih-community': 'Minding the AIH community',
  'seo-agent': 'Feeding the search engines',
  'comms-agent': 'Wordsmith on duty',
  'accountability-coach': 'No excuses. Ever.',
  'pr-agent': 'Polish and press',
  claude: 'Generalist at large',
  codex: 'Ships code quietly',
};

/**
 * GET /api/crew — roster for the companion chat.
 *
 * Returns the canonical user identity (the non-agent side of every
 * comms pair key) plus every enabled agent with its tagline and avatar
 * version. Disabled agents are omitted: a companion you cannot wake is
 * just confusing on this surface.
 */
export async function GET() {
  const ctxRoot = getCTXRoot();
  const identity = resolveIdentity(ctxRoot);

  // Optional per-agent card overrides.
  let cards: Record<string, { tagline?: string }> = {};
  try {
    const raw = fs.readFileSync(path.join(ctxRoot, 'avatars', 'cards.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') cards = parsed;
  } catch {
    /* no overrides */
  }

  const agents: CrewMember[] = [];
  const registryPath = path.join(ctxRoot, 'config', 'enabled-agents.json');
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as Record<
      string,
      { enabled?: boolean; org?: string }
    >;
    for (const [name, entry] of Object.entries(registry)) {
      if (!/^[a-z0-9_-]+$/.test(name)) continue;
      if (!entry?.enabled) continue;

      let avatarVersion: number | null = null;
      const avatarFile = findAvatarFile(ctxRoot, name);
      if (avatarFile) {
        try {
          avatarVersion = Math.round(fs.statSync(avatarFile).mtimeMs);
        } catch {
          /* stat raced a delete — treat as no avatar */
        }
      }

      // Last-message time + preview unioned across every source the chat view
      // reads (room-log tail + bus queues + Telegram outbound log), so the
      // roster summary cannot lag behind the open chat. Tail/stat-bounded;
      // missing sources swallow to {null,null}.
      const tail = readPairSummary(ctxRoot, name, identity.canonicalUser, identity);

      agents.push({
        targetId: name,
        kind: 'employee',
        name,
        org: entry.org ?? '',
        enabled: true,
        tagline:
          cards[name]?.tagline ??
          DEFAULT_TAGLINES[name] ??
          (entry.org ? entry.org.replace(/-/g, ' ') : 'On the crew'),
        avatarVersion,
        lastActivity: tail.lastActivity,
        lastPreview: tail.lastPreview,
      });
    }
  } catch {
    /* registry missing — empty roster */
  }

  try {
    const result = await new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default').send({ type: 'list-work-sessions', source: 'dashboard', data: { actor: `owner:${identity.canonicalUser}` } });
    if (result.success && Array.isArray(result.data)) {
      for (const value of result.data) {
        const session = value as { id?: string; display_name?: string; harness?: CrewMember['harness']; lifecycle?: CrewMember['lifecycle']; room_id?: string; org?: string; resume_handle?: unknown };
        if (!session.id || !session.display_name || !session.room_id || !/^[a-z0-9_-]+$/.test(session.id)) continue;
        const messages = readRoomLog(ctxRoot, session.room_id);
        const last = messages.at(-1);
        agents.push({
          targetId: session.id, kind: 'work_session', name: session.display_name, org: session.org ?? '', enabled: session.lifecycle === 'active',
          tagline: `${session.harness ?? 'native'} Work Session`, avatarVersion: null,
          lastActivity: last?.timestamp ?? null, lastPreview: last?.text ?? null,
          roomId: session.room_id, lifecycle: session.lifecycle, harness: session.harness,
          resumable: ['archived', 'failed'].includes(session.lifecycle ?? '') && Boolean(session.resume_handle),
        });
      }
    }
  } catch { /* daemon unavailable: Employee roster remains usable */ }

  return Response.json({ user: identity.canonicalUser, agents });
}
