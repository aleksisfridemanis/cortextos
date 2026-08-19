import { describe, it, expect } from 'vitest';
import { extractTail } from '../rooms';

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

const base = { id: 'x', from: 'sender', timestamp: '2026-08-19T10:00:00Z', text: 'hello' };

describe('extractTail', () => {
  it('returns nulls for no usable lines', () => {
    expect(extractTail([], false)).toEqual({ lastActivity: null, lastPreview: null });
    expect(extractTail(['', '   '], false)).toEqual({ lastActivity: null, lastPreview: null });
  });

  it('returns the newest ordinary message, walking from the end', () => {
    const lines = [
      line({ ...base, id: 'a', timestamp: '2026-08-19T10:00:00Z', text: 'first' }),
      line({ ...base, id: 'b', timestamp: '2026-08-19T11:00:00Z', text: 'second' }),
    ];
    expect(extractTail(lines, false)).toEqual({
      lastActivity: '2026-08-19T11:00:00Z',
      lastPreview: 'second',
    });
  });

  it('skips kind-bearing tool-run records', () => {
    const lines = [
      line({ ...base, id: 'msg', text: 'real message' }),
      line({ ...base, id: 'run', kind: 'tool_run', text: 'tool run' }),
      line({ ...base, id: 'end', kind: 'tool_run_end', text: 'done' }),
    ];
    expect(extractTail(lines, false).lastPreview).toBe('real message');
  });

  it('drops the first line when the read started mid-file', () => {
    // Newest lines are last; here the only VALID line sits at index 0, so the
    // drop is observable: with the flag it is discarded and nothing valid
    // remains; without it, that line is selected.
    const lines = [line({ ...base, id: 'v', text: 'valid line 0' }), '{ truncated'];
    expect(extractTail(lines, false).lastPreview).toBe('valid line 0');
    expect(extractTail(lines, true)).toEqual({ lastActivity: null, lastPreview: null });
  });

  it('skips corrupt JSON and messages missing required fields', () => {
    const lines = [
      line({ ...base, id: 'good', text: 'good one' }),
      '{ not json',
      line({ from: 'sender', timestamp: '2026-08-19T12:00:00Z', text: 'no id' }),
    ];
    expect(extractTail(lines, false).lastPreview).toBe('good one');
  });

  it('collapses whitespace and truncates the preview', () => {
    const lines = [line({ ...base, text: 'a\n\n  b   c' })];
    expect(extractTail(lines, false).lastPreview).toBe('a b c');
    const long = 'x'.repeat(300);
    expect(extractTail([line({ ...base, text: long })], false, 10).lastPreview).toBe('x'.repeat(10));
  });
});
