'use client';

import { useEffect, useState } from 'react';

export interface KeyboardInset {
  /** Rounded visualViewport height in px, or null when unavailable (SSR / no vv). */
  viewportHeight: number | null;
  /** True once the on-screen keyboard has shrunk the visual viewport past the threshold. */
  keyboardOpen: boolean;
}

/**
 * A shrink smaller than this is browser chrome (URL bar collapse), not a keyboard.
 * iOS/Android soft keyboards eat far more than 120px of height, so this cleanly
 * separates the two without a per-device table.
 */
export const KEYBOARD_MIN_INSET = 120;

/** The SSR / no-visualViewport return. Also the initial state before the first measure. */
export const NO_KEYBOARD_INSET: KeyboardInset = { viewportHeight: null, keyboardOpen: false };

/**
 * Pure threshold derivation, exported for its own unit test — the hook itself
 * cannot be exercised without a React render harness, and adding one is a
 * forbidden new dependency.
 */
export function isKeyboardOpen(layoutHeight: number, viewportHeight: number): boolean {
  return layoutHeight - viewportHeight > KEYBOARD_MIN_INSET;
}

/**
 * Track the visual viewport so a fixed layout can exclude the on-screen keyboard.
 *
 * `100dvh` does NOT shrink when the keyboard opens on iOS, which buries the chat
 * bar behind it; visualViewport reports the true visible area. Also snaps the
 * page scroll back to 0 after each change: iOS pans the whole page upward to
 * reveal the focused input and the pan sticks, stranding fixed chrome.
 *
 * SSR-safe: returns {@link NO_KEYBOARD_INSET} until an effect runs, and never
 * subscribes when visualViewport is absent.
 */
export function useKeyboardInset(): KeyboardInset {
  const [inset, setInset] = useState<KeyboardInset>(NO_KEYBOARD_INSET);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    if (!vv) return;
    const update = () => {
      const height = Math.round(vv.height);
      setInset({ viewportHeight: height, keyboardOpen: isKeyboardOpen(window.innerHeight, height) });
      requestAnimationFrame(() => window.scrollTo(0, 0));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return inset;
}
