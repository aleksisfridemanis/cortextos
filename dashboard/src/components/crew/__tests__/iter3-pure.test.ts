import { describe, it, expect } from 'vitest';
import { copyPayload, shouldRefocus, draftKey, workSessionLifecycleAction } from '../crew-chat';
import { shouldTriggerPullRefresh, resolveInitialSelection } from '../use-crew';
import { prefetchTargets } from '../crew-roster';
import type { RosterEntry } from '../crew-roster';

// A minimal Element stand-in — the pure guard only ever calls `.closest`.
const target = (closestResult: unknown) => ({ closest: () => closestResult }) as unknown as Element;

describe('shouldTriggerPullRefresh', () => {
  it('fires when at the top and dragged past the threshold', () => {
    expect(shouldTriggerPullRefresh(0, 100, 64)).toBe(true);
  });

  it('treats overscroll (negative scrollTop) as the top', () => {
    expect(shouldTriggerPullRefresh(-5, 100, 64)).toBe(true);
  });

  it('does not fire when scrolled away from the top', () => {
    expect(shouldTriggerPullRefresh(20, 100, 64)).toBe(false);
  });

  it('does not fire below the drag threshold', () => {
    expect(shouldTriggerPullRefresh(0, 30, 64)).toBe(false);
  });
});

describe('resolveInitialSelection', () => {
  it('lets an explicit URL param win, even over a stored value', () => {
    expect(resolveInitialSelection('alice', 'bob', ['bob', 'alice'])).toBe('alice');
  });

  it('honours the URL param even when it is not in the known roster', () => {
    expect(resolveInitialSelection('ghost', 'bob', ['bob'])).toBe('ghost');
  });

  it('falls back to a stored value that is still in the roster', () => {
    expect(resolveInitialSelection(null, 'bob', ['bob', 'alice'])).toBe('bob');
  });

  it('drops a stored value that is no longer in the roster', () => {
    expect(resolveInitialSelection(null, 'gone', ['bob'])).toBeNull();
  });

  it('returns null when there is nothing to open', () => {
    expect(resolveInitialSelection(null, null, ['bob'])).toBeNull();
  });
});

describe('copyPayload', () => {
  it('is the whole message text', () => {
    expect(copyPayload({ text: 'hello world' })).toBe('hello world');
  });
});

describe('draftKey', () => {
  it('is namespaced under crew:draft:', () => {
    expect(draftKey('alice')).toBe('crew:draft:alice');
  });

  it('is stable for the same agent', () => {
    expect(draftKey('alice')).toBe(draftKey('alice'));
  });

  it('is distinct across agents', () => {
    expect(draftKey('alice')).not.toBe(draftKey('bob'));
  });
});

describe('shouldRefocus', () => {
  it('never refocuses on a coarse pointer', () => {
    expect(shouldRefocus(target(null), false, true)).toBe(false);
  });

  it('leaves an active text selection alone', () => {
    expect(shouldRefocus(target(null), true, false)).toBe(false);
  });

  it('does not steal a click that landed on its own control', () => {
    expect(shouldRefocus(target({}), false, false)).toBe(false);
  });

  it('refocuses on a plain desktop click on empty surface', () => {
    expect(shouldRefocus(target(null), false, false)).toBe(true);
  });

  it('refocuses when the click target is null', () => {
    expect(shouldRefocus(null, false, false)).toBe(true);
  });
});

describe('workSessionLifecycleAction', () => {
  it('offers only actions the lifecycle API can execute', () => {
    expect(workSessionLifecycleAction('active', false)).toBe('stop');
    expect(workSessionLifecycleAction('archived', true)).toBe('resume');
    expect(workSessionLifecycleAction('failed', true)).toBe('resume');
    expect(workSessionLifecycleAction('failed', false)).toBeNull();
    expect(workSessionLifecycleAction('starting', true)).toBeNull();
    expect(workSessionLifecycleAction('stopping', true)).toBeNull();
  });
});

describe('prefetchTargets', () => {
  const roster = (names: string[]): RosterEntry[] =>
    names.map((name) => ({
      name,
      tagline: '',
      avatarVersion: null,
      lastActivity: null,
      lastPreview: null,
      mood: 'resting',
    }));

  it('returns the first n names in order', () => {
    expect(prefetchTargets(roster(['a', 'b', 'c']), 2)).toEqual(['a', 'b']);
  });

  it('returns all names when n exceeds the length', () => {
    expect(prefetchTargets(roster(['a', 'b']), 5)).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty roster', () => {
    expect(prefetchTargets(roster([]), 2)).toEqual([]);
  });
});
