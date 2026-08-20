'use client';

import { Suspense, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CrewRoster } from '@/components/crew/crew-roster';
import { CrewChat, warmRoomCache } from '@/components/crew/crew-chat';
import { useCrew, shouldTriggerPullRefresh } from '@/components/crew/use-crew';
import { useKeyboardInset } from '@/components/crew/use-keyboard-inset';
import '@/components/crew/crew.css';

// Pull-down distance (px) past the top that fires a roster refresh on mobile.
const PULL_THRESHOLD = 64;

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Late one?';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good arvo';
  return 'Good evening';
}

function CrewAppInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get('with');
  const { user, agents, roster, loading, moodFor, onAvatarChanged, refresh } = useCrew();
  // Pull-to-refresh: the clientY where a top-anchored drag began, else null.
  const pullStartRef = useRef<number | null>(null);

  // iOS keyboard fix: 100dvh does NOT shrink when the on-screen keyboard opens,
  // which buries the chat bar behind it. Pin the app's height to the visual
  // viewport instead (see useKeyboardInset for the full rationale).
  const { viewportHeight: viewportH } = useKeyboardInset();

  const selectedAgent = agents.find((a) => a.name === selected) ?? null;
  const workingCount = roster.filter((r) => r.mood !== 'resting').length;

  function select(name: string) {
    router.replace(`/crew-app?with=${encodeURIComponent(name)}`, { scroll: false });
  }

  function back() {
    router.replace('/crew-app', { scroll: false });
  }

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

  return (
    <div
      className="relative flex h-dvh flex-col overflow-hidden bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
      style={viewportH !== null ? { height: `${viewportH}px` } : undefined}
    >
      {/* Ambient glow behind the roster — decorative only. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72"
        style={{
          background:
            'radial-gradient(70% 100% at 50% 0%, rgba(52, 211, 153, 0.10) 0%, transparent 70%)',
        }}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Waking the crew…
        </div>
      ) : selectedAgent ? (
        <div className="relative min-h-0 flex-1">
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
        <div className="relative flex min-h-0 flex-1 flex-col px-4 pt-6">
          <div className="mb-4">
            <h1 className="text-2xl font-bold tracking-tight">{greeting()}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {workingCount > 0
                ? `${workingCount} of your crew ${workingCount === 1 ? 'is' : 'are'} up and about`
                : 'the whole crew is resting'}
            </p>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto pb-4"
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
        </div>
      )}
    </div>
  );
}

export function CrewAppClient() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
          Waking the crew…
        </div>
      }
    >
      <CrewAppInner />
    </Suspense>
  );
}
