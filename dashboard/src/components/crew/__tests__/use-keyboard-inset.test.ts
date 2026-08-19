import { describe, it, expect } from 'vitest';
import {
  isKeyboardOpen,
  KEYBOARD_MIN_INSET,
  NO_KEYBOARD_INSET,
} from '../use-keyboard-inset';

describe('isKeyboardOpen — threshold derivation', () => {
  it('is closed when the viewport equals the layout (no shrink)', () => {
    expect(isKeyboardOpen(844, 844)).toBe(false);
  });

  it('is closed for a shrink at or below the threshold (browser chrome, not a keyboard)', () => {
    // Exactly the threshold is NOT open — the comparison is strictly greater than.
    expect(isKeyboardOpen(844, 844 - KEYBOARD_MIN_INSET)).toBe(false);
    expect(isKeyboardOpen(844, 844 - (KEYBOARD_MIN_INSET - 1))).toBe(false);
  });

  it('is open once the shrink exceeds the threshold (positive control)', () => {
    // A ~300px keyboard is well past the threshold.
    expect(isKeyboardOpen(844, 544)).toBe(true);
    expect(isKeyboardOpen(844, 844 - (KEYBOARD_MIN_INSET + 1))).toBe(true);
  });
});

describe('NO_KEYBOARD_INSET — SSR / no-visualViewport safe return', () => {
  it('reports no measurement and a closed keyboard', () => {
    // This constant is the hook's initial state and its return when
    // window.visualViewport is absent (SSR or an unsupported browser), so the
    // layout falls back to CSS height instead of a bad numeric height.
    expect(NO_KEYBOARD_INSET).toEqual({ viewportHeight: null, keyboardOpen: false });
  });
});
