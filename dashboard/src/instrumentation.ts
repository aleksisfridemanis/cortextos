export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { IPCClient } = await import('@/lib/ipc-client');
  const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
  const response = await ipc.send({ type: 'reconcile-crew' });
  if (!response.success && !process.env.NEXT_PHASE) {
    throw new Error('Crew mutation reconciliation unavailable');
  }
}
