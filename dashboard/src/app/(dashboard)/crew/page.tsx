'use client';

import { Suspense, useCallback, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CrewRoster, RosterSkeleton } from '@/components/crew/crew-roster';
import { CrewChat, warmRoomCache } from '@/components/crew/crew-chat';
import { useCrew, resolveInitialSelection, shouldTriggerPullRefresh } from '@/components/crew/use-crew';
import { useKeyboardInset } from '@/components/crew/use-keyboard-inset';
import '@/components/crew/crew.css';

// Pull-down distance (px) past the top that fires a roster refresh on mobile.
const PULL_THRESHOLD = 64;

function CrewPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get('with');
  const { user, agents, roster, loading, moodFor, onAvatarChanged, refresh } = useCrew();
  // The mobile chat is a fixed overlay under the Topbar; pin its height to the
  // visual viewport so the floating chat bar clears the on-screen keyboard.
  const { viewportHeight } = useKeyboardInset();
  // One-shot restore of the last-selected member (see effect below).
  const restoredRef = useRef(false);
  // Pull-to-refresh: the clientY where a top-anchored drag began, else null.
  const pullStartRef = useRef<number | null>(null);

  const selectedAgent = agents.find((a) => a.name === selected) ?? null;

  function select(name: string) {
    try {
      sessionStorage.setItem('crew:last-with', name);
    } catch {
      /* ignore */
    }
    router.replace(`/crew?with=${encodeURIComponent(name)}`, { scroll: false });
  }

  function back() {
    try {
      sessionStorage.removeItem('crew:last-with');
    } catch {
      /* ignore */
    }
    router.replace('/crew', { scroll: false });
  }

  // On a fresh load with no `?with=`, reopen the remembered member if they are
  // still in the roster. Runs once, after the roster has loaded so the
  // still-enabled check is meaningful, and never competes with roster polling.
  useEffect(() => {
    if (restoredRef.current || loading) return;
    restoredRef.current = true;
    if (selected) return;
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem('crew:last-with');
    } catch {
      /* ignore */
    }
    const resolved = resolveInitialSelection(selected, stored, agents.map((a) => a.name));
    if (resolved) {
      router.replace(`/crew?with=${encodeURIComponent(resolved)}`, { scroll: false });
    }
  }, [loading, selected, agents, router]);

  const prefetch = useCallback(
    (name: string) => warmRoomCache([user, name].sort().join('--')),
    [user],
  );

  function onListTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    pullStartRef.current = e.currentTarget.scrollTop <= 0 ? (e.touches[0]?.clientY ?? null) : null;
  }
  function onListTouchMove(e: React.TouchEvent<HTMLDivElement>) {
    if (pullStartRef.current === null) return;
    const delta = (e.touches[0]?.clientY ?? 0) - pullStartRef.current;
    if (shouldTriggerPullRefresh(e.currentTarget.scrollTop, delta, PULL_THRESHOLD)) {
      pullStartRef.current = null;
      refresh();
    }
  }
  function onListTouchEnd() {
    pullStartRef.current = null;
  }

  if (loading) {
    return (
      <div className="md:max-w-[290px]">
        <RosterSkeleton />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-136px)] flex-col gap-3 md:h-[calc(100dvh-86px)]">
      {/* Desktop: rail + chat side by side. */}
      <div className="hidden min-h-0 flex-1 gap-3 md:grid md:grid-cols-[290px_1fr]">
        <div className="min-h-0 overflow-hidden rounded-xl border bg-muted/10">
          <CrewRoster
            agents={roster}
            selected={selected}
            onSelect={select}
            variant="rail"
            onPrefetch={prefetch}
          />
        </div>
        {selectedAgent ? (
          <CrewChat
            agent={selectedAgent}
            user={user}
            mood={moodFor(selectedAgent.name)}
            onAvatarChanged={(v) => onAvatarChanged(selectedAgent.name, v)}
          />
        ) : (
          <div className="flex items-center justify-center rounded-xl border bg-muted/10 text-sm text-muted-foreground">
            Pick a crew member to start chatting
          </div>
        )}
      </div>

      {/* Mobile: roster screen in flow, or full-screen floating chat overlaid
          under the kept Topbar (which carries the nav hamburger). */}
      {selectedAgent ? (
        <div
          className="fixed inset-x-0 top-12 bottom-0 z-40 overflow-hidden md:hidden"
          style={viewportHeight !== null ? { height: `${viewportHeight - 48}px` } : undefined}
        >
          <CrewChat
            agent={selectedAgent}
            user={user}
            mood={moodFor(selectedAgent.name)}
            onBack={back}
            onAvatarChanged={(v) => onAvatarChanged(selectedAgent.name, v)}
            frameless
          />
        </div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto md:hidden"
          onTouchStart={onListTouchStart}
          onTouchMove={onListTouchMove}
          onTouchEnd={onListTouchEnd}
        >
          <CrewRoster
            agents={roster}
            selected={null}
            onSelect={select}
            variant="list"
            onPrefetch={prefetch}
          />
        </div>
      )}
    </div>
  );
}

export default function CrewPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-sm text-muted-foreground">Waking the crew…</div>}>
      <CrewPageInner />
    </Suspense>
  );
}
