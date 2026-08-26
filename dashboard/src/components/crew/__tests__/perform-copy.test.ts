import { describe, it, expect, vi } from 'vitest';
import { performCopy } from '../crew-chat';

describe('performCopy', () => {
  it('returns false and never writes when the clipboard is absent', async () => {
    // Insecure context: navigator.clipboard is undefined. The old code flashed
    // a checkmark here because `await undefined` resolves.
    const writeText = vi.fn();
    expect(await performCopy(undefined, 'hello')).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns true when the write resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await performCopy({ writeText }, 'hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns false when the write rejects (denied permission)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    expect(await performCopy({ writeText }, 'hello')).toBe(false);
  });
});
