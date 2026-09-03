import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface ProcessIdentity {
  pid: number;
  started_at: string;
  process_group_id?: number | null;
}

const DARWIN_PROCESS_BIRTH = String.raw`
import ctypes, sys
class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ('flags', ctypes.c_uint32), ('status', ctypes.c_uint32),
        ('xstatus', ctypes.c_uint32), ('pid', ctypes.c_uint32),
        ('ppid', ctypes.c_uint32), ('uid', ctypes.c_uint32),
        ('gid', ctypes.c_uint32), ('ruid', ctypes.c_uint32),
        ('rgid', ctypes.c_uint32), ('svuid', ctypes.c_uint32),
        ('svgid', ctypes.c_uint32), ('rfu_1', ctypes.c_uint32),
        ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32),
        ('nfiles', ctypes.c_uint32), ('pgid', ctypes.c_uint32),
        ('pjobc', ctypes.c_uint32), ('e_tdev', ctypes.c_uint32),
        ('e_tpgid', ctypes.c_uint32), ('nice', ctypes.c_int32),
        ('start_tvsec', ctypes.c_uint64), ('start_tvusec', ctypes.c_uint64),
    ]
info = ProcBsdInfo()
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
size = libproc.proc_pidinfo(int(sys.argv[1]), 3, 0, ctypes.byref(info), ctypes.sizeof(info))
if size != ctypes.sizeof(info) or not info.start_tvsec:
    raise SystemExit(1)
print(f'{info.start_tvsec}:{info.start_tvusec}:{info.pgid}')
`;

function nativeIdentity(pid: number): ProcessIdentity | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return null;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      const processGroupId = Number(fields[2]);
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return startTicks && bootId ? {
        pid, started_at: `linux:${bootId}:${startTicks}`,
        process_group_id: Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : null,
      } : null;
    } catch { return null; }
  }
  if (process.platform === 'darwin') {
    try {
      const value = execFileSync('/usr/bin/python3', ['-c', DARWIN_PROCESS_BIRTH, String(pid)], {
        encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const [seconds, microseconds, group] = value.split(':');
      const processGroupId = Number(group);
      return seconds && microseconds ? {
        pid, started_at: `darwin:${seconds}:${microseconds}`,
        process_group_id: Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : null,
      } : null;
    } catch { return null; }
  }
  if (process.platform === 'win32') {
    try {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) return null;
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const command = '$p=Get-Process -Id ([int]$args[0]) -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)';
      const value = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command, String(pid)], {
        encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      }).trim();
      return /^\d+$/.test(value) ? { pid, started_at: `win32:${value}`, process_group_id: null } : null;
    } catch { return null; }
  }
  try {
    const value = execFileSync('/bin/ps', ['-ww', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value ? { pid, started_at: `${process.platform}:${value}`, process_group_id: null } : null;
  } catch { return null; }
}

export function captureProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  return nativeIdentity(pid);
}

export function probeProcessIdentity(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  try { process.kill(identity.pid, 0); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code !== 'EPERM') return 'unknown';
  }
  const observed = nativeIdentity(identity.pid)?.started_at ?? null;
  if (!observed) return 'unknown';
  return observed === identity.started_at ? 'alive' : 'dead';
}

export function probeProcessGroup(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  if (process.platform === 'win32') return probeProcessIdentity(identity);
  const observed = nativeIdentity(identity.pid);
  if (observed && observed.started_at !== identity.started_at) return 'dead';
  const groupId = identity.process_group_id ?? observed?.process_group_id;
  // Never signal or certify a shared process group. Native PTY leaders are
  // session/group leaders; a different PGID cannot safely identify their tree.
  if (groupId !== identity.pid) return 'unknown';
  try { process.kill(-groupId, 0); return 'alive'; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

export function signalProcessTree(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error('WORK_SESSION_STOP_UNCONFIRMED');
    execFileSync(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(identity.pid), '/T', '/F'], {
      timeout: 5_000, stdio: 'ignore', windowsHide: true,
    });
    return;
  }
  const observed = nativeIdentity(identity.pid);
  if (!observed || observed.started_at !== identity.started_at) throw new Error('WORK_SESSION_STOP_UNCONFIRMED');
  const groupId = identity.process_group_id ?? observed.process_group_id;
  if (groupId !== identity.pid) throw new Error('WORK_SESSION_STOP_UNCONFIRMED');
  // Retain a group discovered from a legacy receipt so post-signal probes can
  // still verify descendants after the leader itself has exited.
  identity.process_group_id = groupId;
  process.kill(-groupId, signal);
}
