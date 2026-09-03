import { describe, it, expect } from 'vitest';
import { copyPayload, deliveryStateLabel, draftKey, messageIsFromCrewTarget, parsePersistedLifecycleIntents, parsePersistedSendIntent, promotionMutationKey, restoredLifecycleActionLabel, retainedSendMutationId, sendIntentKey, shouldRefocus, shouldRetainMutationId, shouldSpeakMessage, workSessionIntentStorageKey, workSessionLifecycleAction, workSessionSendRequestBody } from '../crew-chat';
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

describe('Work Session message identity and delivery state', () => {
  const session = { kind: 'work_session' as const, name: 'Mutable display', targetId: 'ws-stable' };
  it('classifies runtime output by stable target id', () => {
    expect(messageIsFromCrewTarget(session, 'ws-stable')).toBe(true);
    expect(messageIsFromCrewTarget(session, 'Mutable display')).toBe(false);
    expect(shouldSpeakMessage(session, 'ws-stable')).toBe(true);
    expect(shouldSpeakMessage(session, 'Mutable display')).toBe(false);
  });
  it('does not render uncertain delivery as confirmed', () => {
    expect(deliveryStateLabel('pending')).toBe('sending');
    expect(deliveryStateLabel('indeterminate')).toBe('delivery unknown');
    expect(deliveryStateLabel('delivered')).toBe('');
  });
  it('retains the original mutation id for the same unknown send outcome', () => {
    const pending = { id: 'original-id', target: 'ws-stable', intentKey: 'stable-intent' };
    expect(retainedSendMutationId(pending, 'ws-stable', 'stable-intent', () => 'new-id')).toBe('original-id');
    expect(retainedSendMutationId(pending, 'ws-stable', 'different', () => 'new-id')).toBe('new-id');
  });
  it('retains only in-progress unknown IDs and requires a new ID after terminal indeterminate delivery', () => {
    expect(shouldRetainMutationId('MUTATION_OUTCOME_UNKNOWN')).toBe(true);
    expect(shouldRetainMutationId('MUTATION_PENDING')).toBe(true);
    expect(shouldRetainMutationId('DELIVERY_RETRY_REQUIRED')).toBe(false);
  });
  it('binds attachment sends before timestamped upload URLs can change', () => {
    const file = { name: 'screen.png', size: 42, type: 'image/png', lastModified: 7 };
    expect(sendIntentKey('ws-stable', 'inspect', [file])).toBe(sendIntentKey('ws-stable', 'inspect', [{ ...file }]));
    expect(sendIntentKey('ws-stable', 'inspect', [file])).not.toContain('/api/media/');
  });
  it('includes the exact promotion Employee payload in the lifecycle binding', () => {
    expect(promotionMutationKey('ws-stable', { name: 'ada', org: 'platform', runtime: 'claude-code' }))
      .not.toBe(promotionMutationKey('ws-stable', { name: 'grace', org: 'platform', runtime: 'claude-code' }));
  });
  it('scopes persisted mutation state to the authenticated principal and target', () => {
    expect(workSessionIntentStorageKey('owner:alice', 'ws-one')).not.toBe(workSessionIntentStorageKey('owner:bob', 'ws-one'));
    expect(workSessionIntentStorageKey('owner:alice', 'ws-one')).not.toBe(workSessionIntentStorageKey('owner:alice', 'ws-two'));
    const send = {
      version: 1 as const, principal: 'owner:alice', target: 'ws-one', id: 'mutation-one',
      intentKey: 'pre-upload-binding',
      messageText: 'inspect\n/api/media/exact-opaque.png', state: 'pending' as const,
      requestBody: workSessionSendRequestBody('ws-one', 'inspect\n/api/media/exact-opaque.png', 'parent-1'),
      uploads: [{ url: '/api/media/exact-opaque.png', cleanup_token: 'secret-capability' }],
    };
    const boundSend = { ...send, requestDigest: JSON.stringify(send.requestBody) };
    const raw = JSON.stringify({ send: boundSend });
    expect(parsePersistedSendIntent(raw, 'owner:alice', 'ws-one')).toEqual(boundSend);
    expect(parsePersistedSendIntent(raw, 'owner:bob', 'ws-one')).toBeNull();
    expect(parsePersistedSendIntent(raw, 'owner:alice', 'ws-two')).toBeNull();
    expect(JSON.stringify(parsePersistedSendIntent(raw, 'owner:alice', 'ws-one')!.requestBody))
      .toBe(JSON.stringify(workSessionSendRequestBody('ws-one', send.messageText, 'parent-1')));
    expect(parsePersistedSendIntent(JSON.stringify({ send: { ...boundSend, requestDigest: 'tampered' } }), 'owner:alice', 'ws-one')).toBeNull();
    expect(parsePersistedSendIntent(JSON.stringify({ send: { ...boundSend, requestBody: { ...boundSend.requestBody, reply_to: '../bad' } } }), 'owner:alice', 'ws-one')).toBeNull();
  });
  it('keeps restored lifecycle actions explicitly actionable after lifecycle changes', () => {
    expect(restoredLifecycleActionLabel('stop')).toBe('Resume pending stop');
    expect(restoredLifecycleActionLabel('promote')).toBe('Resume pending promote');
  });
  it('accepts only exact action-specific persisted lifecycle bindings', () => {
    const base = { version: 1, principal: 'owner:alice', target: 'ws-one' };
    const id = '11111111-1111-4111-8111-111111111111';
    expect(parsePersistedLifecycleIntents(JSON.stringify({ ...base, lifecycle: [{ ...base, id, action: 'stop', requestDigest: 'ws-one:stop' }] }), base.principal, base.target)).toHaveLength(1);
    const employee = { name: 'ada', org: 'platform', runtime: 'codex-app-server' };
    expect(parsePersistedLifecycleIntents(JSON.stringify({ ...base, lifecycle: [{ ...base, id, action: 'promote', employee, requestDigest: promotionMutationKey(base.target, employee) }] }), base.principal, base.target)).toHaveLength(1);
    for (const lifecycle of [
      [{ ...base, id: 'not-a-uuid', action: 'stop', requestDigest: 'ws-one:stop' }],
      [{ ...base, id, action: 'stop', requestDigest: 'ws-one:resume' }],
      [{ ...base, id, action: 'resume', requestDigest: 'ws-one:resume', employee }],
      [{ ...base, id, action: 'stop', requestDigest: 'ws-one:stop', unexpected: true }],
      [{ ...base, id, action: 'promote', employee: { ...employee, actor: 'forged' }, requestDigest: promotionMutationKey(base.target, employee) }],
    ]) expect(parsePersistedLifecycleIntents(JSON.stringify({ ...base, lifecycle }), base.principal, base.target)).toBeNull();
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
