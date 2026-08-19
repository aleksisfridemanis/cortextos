/**
 * foldToolRuns — the derivation behind AC-T2/T4/T5.
 *
 * The collapsed row is DERIVED from the log on every render, never stored, which
 * is why the summary survives a reload. These tests drive the pure fold; there is
 * no React test harness here and adding one is a forbidden new dependency.
 */
import { describe, it, expect } from 'vitest';
import { foldToolRuns, toolRunSummary, formatTime, type ToolRunRowData } from '../crew-chat';

interface Msg {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
  thread_id?: string;
  kind?: string;
}

function msg(over: Partial<Msg> & { id: string }): Msg {
  return {
    from: 'boris',
    to: 'james',
    priority: 'normal',
    timestamp: '2026-08-19T10:00:00.000Z',
    text: 'x',
    reply_to: null,
    ...over,
  };
}

/** A run of N steps, optionally terminated. */
function run(steps: number, ended: boolean, threadId = 'run-1'): Msg[] {
  const out: Msg[] = [
    msg({ id: 'run-1', kind: 'tool_run', thread_id: threadId, text: 'deploy' }),
  ];
  for (let i = 0; i < steps; i++) {
    out.push(msg({ id: `s${i}`, kind: 'tool_step', reply_to: 'run-1', thread_id: threadId, text: `step ${i}` }));
  }
  if (ended) {
    out.push(msg({ id: 'end-1', kind: 'tool_run_end', reply_to: 'run-1', thread_id: threadId, text: 'done' }));
  }
  return out;
}

/** The number the collapsed summary claims, parsed back out of the label. */
function claimedStepCount(row: ToolRunRowData): number {
  const m = /(\d+) step/.exec(toolRunSummary(row));
  return Number(m?.[1]);
}

describe('foldToolRuns', () => {
  // 10
  it('folds N steps into ONE row', () => {
    const rows = foldToolRuns(run(4, true));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('tool_run');
    // The control AC-T2 asks for: the same run unfolded is N+2 rows.
    expect(run(4, true)).toHaveLength(6);
  });

  // 11
  it('reports running until the terminal record arrives', () => {
    const live = foldToolRuns(run(2, false))[0] as ToolRunRowData;
    expect(toolRunSummary(live)).toBe('⚙ 2 steps · running');

    const settled = foldToolRuns(run(2, true))[0] as ToolRunRowData;
    expect(toolRunSummary(settled)).toBe('⚙ 2 steps · done');
    expect(settled.end?.text).toBe('done');
  });

  it('says "1 step", not "1 steps"', () => {
    const one = foldToolRuns(run(1, false))[0] as ToolRunRowData;
    expect(toolRunSummary(one)).toBe('⚙ 1 step · running');
  });

  // 12
  it('the steps revealed on expand equal the count the summary claimed', () => {
    for (const n of [0, 1, 3, 7]) {
      const row = foldToolRuns(run(n, true))[0] as ToolRunRowData;
      // Compared as numbers, not eyeballed: the expanded list renders row.steps
      // and the collapsed label renders toolRunSummary(row).
      expect(row.steps).toHaveLength(n);
      expect(claimedStepCount(row)).toBe(n);
      expect(claimedStepCount(row)).toBe(row.steps.length);
    }
  });

  // 13 PRESERVE+control
  it('passes a plain inc1 message through untouched', () => {
    // No kind, no thread_id — exactly what every line written before inc2 has.
    const plain = msg({ id: 'm1', text: 'hello' });
    const rows = foldToolRuns([plain]);

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('message');
    // Same object, not a copy: the bubble renderer must see what the server sent.
    expect(rows[0].type === 'message' && rows[0].message).toBe(plain);
  });

  it('keeps plain messages interleaved in order around a run', () => {
    const rows = foldToolRuns([
      msg({ id: 'a', text: 'before' }),
      ...run(2, true),
      msg({ id: 'b', text: 'after' }),
    ]);
    expect(rows.map(r => (r.type === 'message' ? r.message.id : `run:${r.id}`)))
      .toEqual(['a', 'run:run-1', 'b']);
  });

  // 14
  it('groups on thread_id, NOT reply_to', () => {
    // The discriminator: the run root's reply_to points at the message that
    // triggered it, so reply_to and thread_id DISAGREE on the root. Keying on
    // reply_to would file the root under 'trigger' and its steps under 'run-1',
    // splitting one run across two rows.
    const records = [
      msg({ id: 'run-1', kind: 'tool_run', reply_to: 'trigger', thread_id: 'run-1', text: 'deploy' }),
      msg({ id: 's0', kind: 'tool_step', reply_to: 'run-1', thread_id: 'run-1', text: 'build' }),
      msg({ id: 's1', kind: 'tool_step', reply_to: 'run-1', thread_id: 'run-1', text: 'test' }),
    ];
    const rows = foldToolRuns(records);

    expect(rows).toHaveLength(1);
    const row = rows[0] as ToolRunRowData;
    expect(row.id).toBe('run-1');
    expect(row.root?.id).toBe('run-1');
    expect(row.steps).toHaveLength(2);
  });

  it('keeps two runs triggered by the same message as two rows', () => {
    const rows = foldToolRuns([
      msg({ id: 'A', kind: 'tool_run', reply_to: 'trigger', thread_id: 'A' }),
      msg({ id: 'B', kind: 'tool_run', reply_to: 'trigger', thread_id: 'B' }),
    ]);
    expect(rows).toHaveLength(2);
  });

  // 17's UI half — a truncated fetch can deliver steps with no root.
  it('renders a run whose root was truncated away', () => {
    const rows = foldToolRuns([
      msg({ id: 's0', kind: 'tool_step', reply_to: 'run-1', thread_id: 'run-1', text: 'build' }),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as ToolRunRowData;
    expect(row.root).toBeNull();
    expect(row.steps).toHaveLength(1);
  });
});

describe('formatTime', () => {
  // Both polarities. The empty-string arm is the one that mattered: new Date('') gives
  // Invalid Date, whose toLocaleTimeString RETURNS "Invalid Date" rather than throwing,
  // so the try/catch that looked like it handled this never ran.
  it('renders a time for a valid timestamp', () => {
    expect(formatTime('2026-08-19T14:26:57.099Z')).toMatch(/\d{1,2}:\d{2}/);
  });

  it('renders nothing — not the string "Invalid Date" — for an empty timestamp', () => {
    expect(formatTime('')).toBe('');
  });

  it('renders nothing for an unparseable timestamp', () => {
    expect(formatTime('not-a-date')).toBe('');
  });
});
