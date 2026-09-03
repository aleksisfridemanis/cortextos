'use client';

// Shared data layer for the Crew surfaces — the dashboard page (/crew)
// and the standalone phone app (/crew-app) render the same roster,
// presence, and moods from this hook so the two can never disagree.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CrewMood } from './crew-critter';
import type { RosterEntry } from './crew-roster';

// Same window as the Active-now strip on /agents.
const ACTIVE_WINDOW_MS = 90_000;
const PRESENCE_POLL_MS = 7000;
// The roster carries each agent's last-activity/preview, which must track the
// open chat in near-real-time, so it polls on the same 5s cadence as the chat.
const CREW_POLL_MS = 5000;

/**
 * A mobile pull-to-refresh gesture fires when the list is already scrolled to
 * the top and the finger has dragged down past a threshold. Pure — exported
 * for its own unit test.
 */
export function shouldTriggerPullRefresh(
  scrollTop: number,
  dragDeltaY: number,
  threshold: number,
): boolean {
  return scrollTop <= 0 && dragDeltaY > threshold;
}

/**
 * The member to open on a fresh Crew load: an explicit `?with=` URL param wins;
 * otherwise a remembered last selection, but only if that agent is still in the
 * roster (never reopen an agent that has since been disabled); otherwise none.
 * Pure — exported for its own unit test. (Item B3.)
 */
export function resolveInitialSelection(
  urlWith: string | null,
  stored: string | null,
  known: string[],
): string | null {
  if (urlWith) return urlWith;
  if (stored && known.includes(stored)) return stored;
  return null;
}

export interface CrewMember {
  targetId: string;
  kind: 'employee' | 'work_session';
  name: string;
  org: string;
  tagline: string;
  avatarVersion: number | null;
  lastActivity: string | null;
  lastPreview: string | null;
  roomId?: string;
  lifecycle?: 'starting' | 'active' | 'stopping' | 'archived' | 'failed';
  harness?: 'claude-code' | 'codex-app-server' | 'opencode';
}

/**
 * Sort comparator for the roster: most-recently-active first, agents that have
 * never messaged last. ISO timestamps sort correctly under localeCompare, so
 * `b` before `a` gives descending recency. Pure — exported for its own test.
 */
export function byRecency(
  a: { lastActivity: string | null },
  b: { lastActivity: string | null },
): number {
  if (a.lastActivity === b.lastActivity) return 0;
  if (a.lastActivity === null) return 1;
  if (b.lastActivity === null) return -1;
  return b.lastActivity.localeCompare(a.lastActivity);
}

interface PresenceEntry {
  name: string;
  typing: boolean;
  lastOutputAt: number | null;
}

function moodOf(p: PresenceEntry | undefined): CrewMood {
  if (!p) return 'resting';
  if (p.typing) return 'typing';
  if (p.lastOutputAt !== null && Date.now() - p.lastOutputAt < ACTIVE_WINDOW_MS) return 'active';
  return 'resting';
}

export interface CrewState {
  user: string;
  agents: CrewMember[];
  roster: RosterEntry[];
  loading: boolean;
  moodFor: (name: string) => CrewMood;
  onAvatarChanged: (name: string, version: number | null) => void;
  /** Re-fetch the roster now — wired to mobile pull-to-refresh. */
  refresh: () => void;
}

export function useCrew(): CrewState {
  const [user, setUser] = useState('');
  const [agents, setAgents] = useState<CrewMember[]>([]);
  const [presence, setPresence] = useState<Map<string, PresenceEntry>>(new Map());
  const [loading, setLoading] = useState(true);
  // Clear the spinner only on the first roster load; later polls refresh in
  // place without flashing back to a loading state.
  const loadedRef = useRef(false);
  // Guards a late /api/crew response from calling setState after unmount.
  const cancelledRef = useRef(false);

  // Roster — polled while the tab is visible so avatars, taglines and
  // last-activity stay fresh; avatar versions also update in place after uploads.
  const fetchCrew = useCallback(async () => {
    try {
      const r = await fetch('/api/crew');
      if (!r.ok) return;
      const data = await r.json();
      if (cancelledRef.current) return;
      setUser(data.user ?? 'user');
      setAgents(Array.isArray(data.agents) ? data.agents : []);
      // Clear the skeleton only after a successful load — a failed/pending
      // first fetch keeps loading=true so the poll retries under the skeleton.
      if (!loadedRef.current) {
        loadedRef.current = true;
        setLoading(false);
      }
    } catch {
      /* keep last snapshot */
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    fetchCrew();
    let interval: ReturnType<typeof setInterval> | null = null;
    function start() {
      if (interval === null) interval = setInterval(fetchCrew, CREW_POLL_MS);
    }
    function stop() {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') start();
    function onVis() {
      if (document.visibilityState === 'visible') {
        fetchCrew();
        start();
      } else {
        stop();
      }
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelledRef.current = true;
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchCrew]);

  // Presence — polled while the tab is visible.
  const fetchPresence = useCallback(async () => {
    try {
      const r = await fetch('/api/agents/presence');
      if (!r.ok) return;
      const data = await r.json();
      const map = new Map<string, PresenceEntry>();
      for (const p of data.agents ?? []) map.set(p.name, p);
      setPresence(map);
    } catch {
      /* keep last snapshot */
    }
  }, []);

  useEffect(() => {
    fetchPresence();
    let interval: ReturnType<typeof setInterval> | null = null;
    function start() {
      if (interval === null) interval = setInterval(fetchPresence, PRESENCE_POLL_MS);
    }
    function stop() {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') start();
    function onVis() {
      if (document.visibilityState === 'visible') {
        fetchPresence();
        start();
      } else {
        stop();
      }
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchPresence]);

  const roster: RosterEntry[] = useMemo(
    () =>
      agents
        .map((a) => ({
          targetId: a.targetId,
          kind: a.kind,
          name: a.name,
          tagline: a.tagline,
          avatarVersion: a.avatarVersion,
          lastActivity: a.lastActivity,
          lastPreview: a.lastPreview,
          mood: moodOf(presence.get(a.name)),
          lifecycle: a.lifecycle,
        }))
        .sort(byRecency),
    [agents, presence],
  );

  const moodFor = useCallback(
    (name: string) => moodOf(presence.get(name)),
    [presence],
  );

  const onAvatarChanged = useCallback((name: string, version: number | null) => {
    setAgents((prev) => prev.map((a) => (a.name === name ? { ...a, avatarVersion: version } : a)));
  }, []);

  return { user, agents, roster, loading, moodFor, onAvatarChanged, refresh: fetchCrew };
}
