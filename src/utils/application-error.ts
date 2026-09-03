const PUBLIC_APPLICATION_CODES = new Set([
  'BODY_TOO_LARGE', 'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_SOURCE_UNAVAILABLE', 'CREATE_FAILED',
  'CREW_RECOVERY_REQUIRED', 'CWD_CHANGED', 'CWD_LEASE_CONFLICT', 'CWD_NOT_DIRECTORY',
  'CWD_NOT_FOUND', 'CWD_UNREADABLE', 'DELIVERY_RETRY_REQUIRED', 'EMPLOYEE_NOT_FOUND',
  'EMPLOYEE_RUNTIME_EXITED', 'EMPLOYEE_START_FAILED', 'FORBIDDEN', 'FORGED_SERVER_FIELD',
  'IDEMPOTENCY_CONFLICT', 'INTERNAL_ERROR', 'INVALID_AGENT_NAME', 'INVALID_BODY',
  'INVALID_INPUT', 'INVALID_INTENT', 'INVALID_MESSAGE', 'INVALID_MUTATION_ID', 'INVALID_ORG',
  'INVALID_ROOM', 'INVALID_TRANSITION', 'MODEL_UNSUPPORTED', 'MUTATION_OUTCOME_UNKNOWN',
  'MUTATION_PENDING', 'NOT_FOUND', 'ORG_NOT_FOUND', 'PATH_UNAVAILABLE', 'PATH_UNREADABLE',
  'POLICY_REJECTED', 'PROCESS_IDENTITY_UNAVAILABLE', 'PROMOTION_FAILED', 'RECOVERY_REQUIRED',
  'REGISTRY_CORRUPT', 'RESUME_HANDLE_MISSING', 'RESUME_HANDLE_UNAVAILABLE', 'RUNTIME_REQUEST_REJECTED',
  'RUNTIME_START_FAILED', 'SANDBOX_UNAVAILABLE', 'STALE_PROPOSAL', 'UNAUTHENTICATED',
  'WORK_SESSION_NOT_RUNNING', 'WORK_SESSION_STOP_UNCONFIRMED',
]);

/** Convert any internal exception to a closed, host-path-free protocol code. */
export function closedApplicationErrorCode(error: unknown, fallback = 'INTERNAL_ERROR'): string {
  const candidate = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error ? error.message : '';
  return PUBLIC_APPLICATION_CODES.has(candidate) ? candidate : fallback;
}

/** Derive a safe category from a structured harness rejection without exposing its text. */
export function closedRuntimeErrorCode(error: unknown): string {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const category = typeof value.code === 'string' ? value.code : typeof value.type === 'string' ? value.type : '';
  if (/model|provider/i.test(category)) return 'MODEL_UNSUPPORTED';
  if (/policy|permission|approval/i.test(category)) return 'POLICY_REJECTED';
  if (/sandbox/i.test(category)) return 'SANDBOX_UNAVAILABLE';
  return 'RUNTIME_REQUEST_REJECTED';
}
