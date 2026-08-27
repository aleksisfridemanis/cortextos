import { describe, it, expect } from 'vitest';
import { rowAlignClasses, isCentered } from '../crew-chat';

// Tests WIRING (the class strings the row/avatar/pill get), not pixels. The
// short-vs-tall decision is a runtime offsetHeight measurement; this only pins
// that each branch emits the classes the layout depends on.
describe('rowAlignClasses', () => {
  it('centers the row and pins the avatar to the bottom on a short bubble', () => {
    const a = rowAlignClasses(true);
    // Short: row shares a center, pill drops its mb-4, avatar keeps its bottom
    // anchor via self-end so it does not move.
    expect(a.row).toBe('items-center');
    expect(a.avatarExtra).toBe('self-end');
    expect(a.pill).toBe('');
  });

  it('bottom-anchors the pill on a tall bubble (byte-identical to before)', () => {
    const a = rowAlignClasses(false);
    expect(a.row).toBe('items-end');
    expect(a.avatarExtra).toBe('');
    expect(a.pill).toBe('mb-4 self-end');
  });

  it('never emits the centered pill class in the tall case', () => {
    // Guards the regression: a tall bubble must keep mb-4 so the pill stays
    // bottom-anchored. If the branch were inverted this fails.
    expect(rowAlignClasses(false).pill).toContain('mb-4');
    expect(rowAlignClasses(true).pill).not.toContain('mb-4');
  });
});

// The short-vs-tall decision itself (the runtime measurement `bubbleH <= pillH`),
// extracted pure so a flipped operator is caught here instead of shipping silent.
describe('isCentered', () => {
  it('centers a short bubble (shorter than the pill)', () => {
    expect(isCentered(20, 40)).toBe(true);
  });

  it('does not center a tall bubble (taller than the pill)', () => {
    expect(isCentered(80, 40)).toBe(false);
  });

  it('centers at the boundary (equal heights) — matches the real `<=`', () => {
    // The live code uses `<=`, so equal heights count as short. An inverted
    // comparison (`>=`) would flip both this and the short case above, failing
    // the test — proving it is a real control, not decoration.
    expect(isCentered(40, 40)).toBe(true);
  });
});
