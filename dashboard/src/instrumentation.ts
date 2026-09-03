export function recoveryBlocksStartup(response: { success: boolean; code?: string }, nextPhase?: string): boolean {
  return !response.success && response.code !== 'CREW_RECOVERY_REQUIRED' && !nextPhase;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { IPCClient } = await import('@/lib/ipc-client');
  const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
  const response = await ipc.send({ type: 'reconcile-crew' });
  if (!response.success && response.code === 'CREW_RECOVERY_REQUIRED') {
    console.warn('[dashboard] Crew recovery remains in progress; mutation routes will continue to report retryable status.');
  } else if (recoveryBlocksStartup(response, process.env.NEXT_PHASE)) {
    throw new Error('Crew mutation reconciliation unavailable');
  }
}
