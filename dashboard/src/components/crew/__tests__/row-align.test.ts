import { describe, it, expect } from 'vitest';
import { rowAlignClasses } from '../crew-chat';

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
