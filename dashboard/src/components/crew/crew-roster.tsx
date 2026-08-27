'use client';

import { useEffect } from 'react';
import { CrewAvatar } from './crew-avatar';
import type { CrewMood } from './crew-critter';

export interface RosterEntry {
  name: string;
  tagline: string;
  avatarVersion: number | null;
  lastActivity: string | null;
  lastPreview: string | null;
  mood: CrewMood;
}

interface CrewRosterProps {
  agents: RosterEntry[];
  selected: string | null;
  onSelect: (name: string) => void;
  /** 'rail' = compact vertical list (desktop sidebar). 'list' = full-width
   *  Telegram-style chat rows (mobile home screen). */
  variant: 'rail' | 'list';
  /** Warm a room's message cache ahead of selection. Called on row hover
   *  (desktop) and for the top rows on mount (mobile). */
  onPrefetch?: (name: string) => void;
}

// How many top rows to warm on mount for the mobile list — the ones a user is
// most likely to open first.
const PREFETCH_TOP_N = 2;

/**
 * The first `n` roster names — the rows warmed on mount. Pure — exported for
 * its own unit test.
 */
export function prefetchTargets(agents: RosterEntry[], n: number): string[] {
  return agents.slice(0, n).map((a) => a.name);
}

/**
 * Telegram-style last-activity stamp: time today, "Yesterday", weekday within
 * the last week, else a short date. Empty string for no/invalid activity.
 * Pure — exported for its own unit test.
 */
export function formatChatTimestamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now.getTime() - d.getTime() < 7 * 86_400_000) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

// Placeholder rows for a cold roster load, matching the 'list' row geometry
// (avatar circle + name bar + preview bar) so the switch to real rows does not
// jump. `crew-skeleton` carries the pulse and is stilled under
// prefers-reduced-motion (crew.css).
const ROSTER_SKELETON_WIDTHS = ['w-24', 'w-20', 'w-28', 'w-16', 'w-24'];

export function RosterSkeleton() {
  return (
    <div className="crew-skeleton" aria-hidden>
      {ROSTER_SKELETON_WIDTHS.map((nameWidth, i) => (
        <div key={i} className="flex w-full items-center gap-3 border-b border-border/60 px-3 py-2.5">
          <div className="h-[52px] w-[52px] shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className={`h-3.5 animate-pulse rounded bg-muted ${nameWidth}`} />
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusDot({ mood }: { mood: CrewMood }) {
  const color =
    mood === 'typing'
      ? 'bg-emerald-400 crew-antenna-pulse'
      : mood === 'active'
        ? 'bg-emerald-400'
        : 'bg-muted-foreground/40';
  return (
    <span
      className={`absolute bottom-0.5 right-0.5 block h-3 w-3 rounded-full border-2 border-background ${color}`}
      aria-hidden
    />
  );
}

/**
 * The crew — every enabled agent as a character. Order is the registry
 * order and never changes with presence; only the status styling moves.
 */
export function CrewRoster({ agents, selected, onSelect, variant, onPrefetch }: CrewRosterProps) {
  // Warm the top rows of the mobile list on mount so the first tap opens
  // without a cold fetch. Deferred to idle so the warm never competes with the
  // roster's own first paint. Desktop rail warms on hover instead (below).
  useEffect(() => {
    if (variant !== 'list' || !onPrefetch) return;
    const run = () => {
      for (const name of prefetchTargets(agents, PREFETCH_TOP_N)) onPrefetch(name);
    };
    const hasRIC = typeof window !== 'undefined' && 'requestIdleCallback' in window;
    const handle: number | ReturnType<typeof setTimeout> = hasRIC
      ? window.requestIdleCallback(run)
      : setTimeout(run, 200);
    return () => {
      if (hasRIC) window.cancelIdleCallback(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    };
  }, [variant, agents, onPrefetch]);

  if (agents.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">No agents enabled.</div>
    );
  }

  if (variant === 'rail') {
    return (
      <div className="flex flex-col gap-1 overflow-y-auto p-2">
        {agents.map((a) => (
          <button
            key={a.name}
            onClick={() => onSelect(a.name)}
            onMouseEnter={() => onPrefetch?.(a.name)}
            className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
              selected === a.name ? 'bg-muted' : 'hover:bg-muted/50'
            }`}
          >
            <div className="relative">
              <CrewAvatar name={a.name} version={a.avatarVersion} mood={a.mood} size={44} />
              <StatusDot mood={a.mood} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium leading-tight">{a.name}</p>
              <p className="truncate text-xs text-muted-foreground">{a.lastPreview ?? a.tagline}</p>
            </div>
            {a.mood === 'typing' && (
              <span className="shrink-0 text-[10px] font-medium text-emerald-500">working…</span>
            )}
          </button>
        ))}
      </div>
    );
  }

  // 'list' — Telegram-style full-width chat rows. Avatar + name + last-message
  // preview + time. No unread badge (shipped as a separate follow-on).
  return (
    <div className="overflow-y-auto">
      {agents.map((a) => (
        <button
          key={a.name}
          onClick={() => onSelect(a.name)}
          onMouseEnter={() => onPrefetch?.(a.name)}
          className="flex w-full items-center gap-3 border-b border-border/60 px-3 py-2.5 text-left transition-colors active:bg-muted/50"
        >
          <div className="relative shrink-0">
            <CrewAvatar name={a.name} version={a.avatarVersion} mood={a.mood} size={52} />
            <StatusDot mood={a.mood} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <p className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">
                {a.name}
              </p>
              {a.lastActivity && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatChatTimestamp(a.lastActivity)}
                </span>
              )}
            </div>
            <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
              {a.lastPreview ?? a.tagline}
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}
