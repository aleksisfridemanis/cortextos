import { createConnection } from 'net';
import { homedir } from 'os';
import { join } from 'path';

export type ExecutionLogStatusFilter = 'all' | 'success' | 'failure';

// ---------------------------------------------------------------------------
// Fleet Health types (Subtask 4.4)
// ---------------------------------------------------------------------------

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

export interface CronHealthRow {
  agent: string;
  org: string;
  cronName: string;
  state: CronHealthState;
  reason: string;
  lastFire: number | null;
  expectedIntervalMs: number;
  gapMs: number | null;
  successRate24h: number;
  firesLast24h: number;
  nextFire: string;
}

export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

export interface FleetHealthResponse {
  rows: CronHealthRow[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

export interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

/** Paginated response for list-cron-executions IPC command (Subtask 4.3). */
export interface CronExecutionLogPage {
  entries: CronExecutionLogEntry[];
  total: number;
  hasMore: boolean;
}

export interface IPCRequest {
  type:
    | 'status'
    | 'create-employee'
    | 'context-review'
    | 'context-owner-decision'
    | 'reconcile-crew'
    | 'list-work-sessions'
    | 'create-work-session'
    | 'stop-work-session'
    | 'resume-work-session'
    | 'inject-work-session'
    | 'promote-work-session'
    | 'start-employee-mutation'
    | 'start-agent'
    | 'stop-agent'
    | 'restart-agent'
    | 'wake'
    | 'list-agents'
    | 'list-all-crons'
    | 'list-cron-executions'
    | 'reload-crons'
    | 'fire-cron'
    | 'inject-agent'
    | 'add-cron'
    | 'update-cron'
    | 'remove-cron'
    | 'fleet-health';
  agent?: string;
  data?: Record<string, unknown>;
  mutation_id?: string;
  source?: string;
}

export interface IPCResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

function getIpcPath(instanceId: string = 'default'): string {
  if (process.env.CORTEXT_PLAYWRIGHT_FAKE_IPC === '1' && process.env.CORTEXT_PLAYWRIGHT_IPC_PATH) {
    return process.env.CORTEXT_PLAYWRIGHT_IPC_PATH;
  }
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return join(homedir(), '.cortextos', instanceId, 'daemon.sock');
}

export function ipcRequestDeadline(request: IPCRequest): number {
  return request.mutation_id ? 70_000 : 5_000;
}

export class IPCClient {
  private socketPath: string;

  constructor(instanceId: string = 'default') {
    this.socketPath = getIpcPath(instanceId);
  }

  async send(request: IPCRequest, timeoutMs?: number): Promise<IPCResponse> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        socket.write(JSON.stringify(request));
      });

      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid response from daemon'));
        }
      });

      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          resolve({
            success: false,
            error: 'Daemon is not running. Start it with: cortextos start',
          });
        } else {
          reject(err);
        }
      });

      const deadline = timeoutMs ?? ipcRequestDeadline(request);
      socket.setTimeout(deadline, () => {
        resolve({
          success: false,
          error: 'Mutation outcome is not yet known; retry with the same mutation id',
          code: request.mutation_id ? 'MUTATION_OUTCOME_UNKNOWN' : 'IPC_TIMEOUT',
          ...(request.mutation_id ? { data: { mutation_id: request.mutation_id } } : {}),
        });
        socket.destroy();
      });
    });
  }

  async isDaemonRunning(): Promise<boolean> {
    try {
      const response = await this.send({ type: 'status' });
      return response.success;
    } catch {
      return false;
    }
  }
}
