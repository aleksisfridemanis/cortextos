'use client';

import { Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CrewRoster } from '@/components/crew/crew-roster';
import { CrewChat, warmRoomCache } from '@/components/crew/crew-chat';
import { useCrew } from '@/components/crew/use-crew';
import { useKeyboardInset } from '@/components/crew/use-keyboard-inset';
import '@/components/crew/crew.css';

function CrewPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get('with');
  const { user, agents, roster, loading, moodFor, onAvatarChanged } = useCrew();
  // The mobile chat is a fixed overlay under the Topbar; pin its height to the
  // visual viewport so the floating chat bar clears the on-screen keyboard.
  const { viewportHeight } = useKeyboardInset();

  const selectedAgent = agents.find((a) => a.name === selected) ?? null;

  function select(name: string) {
    router.replace(`/crew?with=${encodeURIComponent(name)}`, { scroll: false });
  }

  function back() {
    router.replace('/crew', { scroll: false });
  }

  const prefetch = useCallback(
    (name: string) => warmRoomCache([user, name].sort().join('--')),
    [user],
  );

  if (loading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">Waking the crew…</div>;
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
        <div className="min-h-0 flex-1 overflow-hidden md:hidden">
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
