import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

export interface ProcessIdentity {
  pid: number;
  started_at: string;
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
print(f'{info.start_tvsec}:{info.start_tvusec}')
`;

function startedAt(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return null;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return startTicks && bootId ? `linux:${bootId}:${startTicks}` : null;
    } catch { return null; }
  }
  if (process.platform === 'darwin') {
    try {
      const value = execFileSync('/usr/bin/python3', ['-c', DARWIN_PROCESS_BIRTH, String(pid)], {
        encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return value ? `darwin:${value}` : null;
    } catch { return null; }
  }
  try {
    const value = execFileSync('/bin/ps', ['-ww', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value ? `${process.platform}:${value}` : null;
  } catch { return null; }
}

export function captureProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const identity = startedAt(pid);
  return identity ? { pid, started_at: identity } : null;
}

export function probeProcessIdentity(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  try { process.kill(identity.pid, 0); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code !== 'EPERM') return 'unknown';
  }
  const observed = startedAt(identity.pid);
  if (!observed) return 'unknown';
  return observed === identity.started_at ? 'alive' : 'dead';
}
