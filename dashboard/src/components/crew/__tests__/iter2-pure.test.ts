import { describe, it, expect } from 'vitest';
import { clampTextareaHeight, buildMessageText } from '../crew-chat';
import { byRecency } from '../use-crew';
import { formatChatTimestamp } from '../crew-roster';

describe('byRecency', () => {
  it('orders most-recent first with nulls last', () => {
    const input = [
      { name: 'a', lastActivity: '2026-08-19T10:00:00Z' },
      { name: 'b', lastActivity: null },
      { name: 'c', lastActivity: '2026-08-19T12:00:00Z' },
      { name: 'd', lastActivity: '2026-08-19T09:00:00Z' },
    ];
    expect([...input].sort(byRecency).map((x) => x.name)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('keeps two nulls together at the end (stable-neutral compare)', () => {
    const input = [
      { name: 'n1', lastActivity: null },
      { name: 'x', lastActivity: '2026-08-19T10:00:00Z' },
      { name: 'n2', lastActivity: null },
    ];
    const sorted = [...input].sort(byRecency).map((x) => x.name);
    expect(sorted[0]).toBe('x');
    expect(sorted.slice(1).sort()).toEqual(['n1', 'n2']);
  });

  it('returns 0 for equal timestamps', () => {
    expect(byRecency({ lastActivity: 'same' }, { lastActivity: 'same' })).toBe(0);
  });
});

describe('clampTextareaHeight', () => {
  it('returns the scroll height when under the line cap', () => {
    expect(clampTextareaHeight(40, 20, 12, 0)).toBe(40);
  });

  it('clamps to lineHeight * maxLines + padding when over', () => {
    // 20 * 3 + 8 = 68, scrollHeight 500 exceeds it.
    expect(clampTextareaHeight(500, 20, 3, 8)).toBe(68);
  });

  it('adds padding back into the cap (scrollHeight includes padding)', () => {
    expect(clampTextareaHeight(1000, 20, 12, 16)).toBe(20 * 12 + 16);
  });
});

describe('buildMessageText', () => {
  it('joins text and each url on its own line', () => {
    expect(buildMessageText('hi', ['/a.png', '/b.png'])).toBe('hi\n/a.png\n/b.png');
  });

  it('drops empty text so an image-only message has no leading blank line', () => {
    expect(buildMessageText('', ['/a.png'])).toBe('/a.png');
  });

  it('returns just the text when there are no urls', () => {
    expect(buildMessageText('hello', [])).toBe('hello');
  });
});

describe('formatChatTimestamp', () => {
  it('returns empty string for null or invalid input', () => {
    expect(formatChatTimestamp(null)).toBe('');
    expect(formatChatTimestamp('not-a-date')).toBe('');
  });

  it('renders a time-of-day for a same-day timestamp', () => {
    const now = new Date();
    const out = formatChatTimestamp(now.toISOString());
    expect(out).not.toBe('');
    expect(out).not.toBe('Yesterday');
    expect(/\d/.test(out)).toBe(true);
  });

  it('renders "Yesterday" for a timestamp one day back', () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    y.setHours(12, 0, 0, 0);
    expect(formatChatTimestamp(y.toISOString())).toBe('Yesterday');
  });

  it('does not render "Yesterday" for an older timestamp', () => {
    const old = new Date();
    old.setDate(old.getDate() - 10);
    const out = formatChatTimestamp(old.toISOString());
    expect(out).not.toBe('');
    expect(out).not.toBe('Yesterday');
  });
});
