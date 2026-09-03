import { describe, expect, it } from 'vitest';
import { recoveryBlocksStartup } from '../instrumentation';

describe('dashboard startup Crew recovery', () => {
  it('allows bounded in-progress recovery but blocks daemon unavailability', () => {
    expect(recoveryBlocksStartup({ success: false, code: 'CREW_RECOVERY_REQUIRED' })).toBe(false);
    expect(recoveryBlocksStartup({ success: false, code: 'IPC_TIMEOUT' })).toBe(true);
    expect(recoveryBlocksStartup({ success: true })).toBe(false);
  });
});
