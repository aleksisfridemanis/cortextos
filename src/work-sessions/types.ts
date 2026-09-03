import type { CreateEmployeeInput } from '../agents/create-employee.js';

export const WORK_SESSION_HARNESSES = ['claude-code', 'codex-app-server', 'opencode'] as const;
export type WorkSessionHarness = typeof WORK_SESSION_HARNESSES[number];
export type WorkSessionLifecycle = 'starting' | 'active' | 'stopping' | 'archived' | 'failed';

export type WorkSessionResumeHandle =
  | { runtime: 'claude-code'; session_id: string }
  | { runtime: 'codex-app-server'; thread_id: string }
  | { runtime: 'opencode'; session_id: string };

export interface WorkSessionRecord {
  schema_version: 1;
  kind: 'work_session';
  id: string;
  display_name: string;
  org: string;
  harness: WorkSessionHarness;
  model: string | null;
  requested_cwd: string;
  canonical_cwd: string;
  room_id: string;
  lifecycle: WorkSessionLifecycle;
  resume_handle: WorkSessionResumeHandle | null;
  runtime_owner?: (ProcessIdentity & { mutation_id: string }) | null;
  mutation_id: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  promoted_employee: string | null;
  created_by: string;
}

export interface CreateWorkSessionInput {
  display_name: string;
  org: string;
  harness: WorkSessionHarness;
  requested_cwd: string;
  model?: string;
  initial_request?: string;
  actor: string;
}

export interface WorkSessionLaunchInput {
  id: string;
  mutation_id: string;
  cwd: string;
  model?: string;
  context?: string;
}

export interface WorkSessionRuntimeAdapter {
  startFresh(input: WorkSessionLaunchInput): Promise<{ resume_handle: WorkSessionResumeHandle; runtime_owner: ProcessIdentity & { mutation_id: string } }>;
  resumeExact(handle: WorkSessionResumeHandle, input: WorkSessionLaunchInput): Promise<{ runtime_owner: ProcessIdentity & { mutation_id: string } }>;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  status(): WorkSessionRuntimeStatus;
  getResumeHandle(): WorkSessionResumeHandle | null;
  getRuntimeOwner?(): (ProcessIdentity & { mutation_id: string }) | null;
  reconcileOutputInbox?(): number;
}

export interface WorkSessionRuntimeOutput {
  /** Harness-native completed-item id when available; otherwise adapter generation + sequence. */
  id: string;
  text: string;
  completed_at?: string;
}

export interface WorkSessionRuntimeStatus {
  running: boolean;
  pid: number | null;
  error_code: string | null;
  process_started_at?: string | null;
  ownership?: 'attached' | 'detached' | 'dead' | 'unknown';
}

interface ProcessIdentity { pid: number; started_at: string; process_group_id?: number | null }

export type WorkSessionEmployeeInput = Omit<CreateEmployeeInput, 'working_directory' | 'room_id' | 'telegram_polling'>;
