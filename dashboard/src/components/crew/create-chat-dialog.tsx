'use client';

import { useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const CREW_EMPLOYEE_HARNESSES = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex-app-server', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
] as const;

export type CreateChatKind = 'employee' | 'work_session';
export type EmployeeHarness = typeof CREW_EMPLOYEE_HARNESSES[number]['value'];

export interface CreateChatState {
  kind: CreateChatKind;
  name: string;
  org: string;
  harness: EmployeeHarness;
  model: string;
  workingDirectory: string;
  initialRequest: string;
}

export function initialCreateChatState(): CreateChatState {
  return { kind: 'employee', name: '', org: '', harness: 'claude-code', model: '', workingDirectory: '', initialRequest: '' };
}

export function buildCreateChatRequest(state: CreateChatState, mutationId: string) {
  if (state.kind === 'employee') {
    return {
      endpoint: '/api/agents' as const,
      headers: { 'content-type': 'application/json', 'x-cortext-intent': 'create-employee', 'x-cortext-mutation-id': mutationId },
      body: {
        name: state.name,
        org: state.org,
        runtime: state.harness,
        model: state.model || undefined,
        working_directory: state.workingDirectory || undefined,
        telegram_polling: false,
      },
    };
  }
  return {
    endpoint: '/api/work-sessions' as const,
    headers: { 'content-type': 'application/json', 'x-cortext-intent': 'create-work-session', 'x-cortext-mutation-id': mutationId },
    body: {
      display_name: state.name,
      org: state.org,
      harness: state.harness,
      model: state.model || undefined,
      requested_cwd: state.workingDirectory,
      ...(state.initialRequest ? { initial_request: state.initialRequest } : {}),
    },
  };
}

export function createChatRequestKey(state: CreateChatState): string {
  const request = buildCreateChatRequest(state, 'binding');
  return JSON.stringify({ endpoint: request.endpoint, body: request.body });
}

export function retainedCreateMutationId(
  pending: { mutationId: string; requestKey: string } | null,
  requestKey: string,
  create: () => string,
): string {
  return pending?.requestKey === requestKey ? pending.mutationId : create();
}

const PENDING_CODES = new Set(['MUTATION_OUTCOME_UNKNOWN', 'MUTATION_PENDING', 'RECOVERY_REQUIRED', 'CREW_RECOVERY_REQUIRED']);

export function CreateChatDialog({ onCreated }: { onCreated?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CreateChatState>(initialCreateChatState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browseEntries, setBrowseEntries] = useState<Array<{ name: string; kind: string; canonical_path: string | null; warning: string | null }>>([]);
  const pendingCreateRef = useRef<{ mutationId: string; requestKey: string } | null>(null);
  const valid = useMemo(() => state.name.length > 0 && state.org.length > 0
    && (state.kind === 'employee' || state.workingDirectory.length > 0), [state]);

  async function browse() {
    const response = await fetch(`/api/work-sessions/browse?path=${encodeURIComponent(state.workingDirectory || '/')}`);
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { setError(value.error ?? 'Unable to browse host'); return; }
    setState(current => ({ ...current, workingDirectory: value.canonical_path }));
    setBrowseEntries(Array.isArray(value.entries) ? value.entries : []);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const requestKey = createChatRequestKey(state);
      const mutationId = retainedCreateMutationId(pendingCreateRef.current, requestKey, () => crypto.randomUUID());
      pendingCreateRef.current = { mutationId, requestKey };
      const request = buildCreateChatRequest(state, mutationId);
      const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) });
      const payload = await response.json().catch(() => ({})) as { error?: string; code?: string; employee?: { name?: string }; session?: { id?: string } };
      if (!response.ok) {
        if (!PENDING_CODES.has(payload.code ?? '')) pendingCreateRef.current = null;
        throw new Error(payload.error || 'Unable to create chat');
      }
      pendingCreateRef.current = null;
      const id = payload.employee?.name ?? payload.session?.id ?? state.name;
      setOpen(false);
      setState(initialCreateChatState());
      onCreated?.(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create chat');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button aria-label="Create chat" size="icon" />}><Plus /></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create chat</DialogTitle>
          <DialogDescription>Create a durable Employee or a resumable project Work Session.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Chat kind">
            {(['employee', 'work_session'] as const).map(kind => (
              <Button key={kind} type="button" variant={state.kind === kind ? 'default' : 'outline'} onClick={() => setState(current => ({ ...current, kind }))}>
                {kind === 'employee' ? 'Employee' : 'Work Session'}
              </Button>
            ))}
          </div>
          <div className="space-y-2"><Label htmlFor="crew-name">{state.kind === 'employee' ? 'Employee name' : 'Session name'}</Label><Input id="crew-name" maxLength={64} required value={state.name} onChange={event => setState(current => ({ ...current, name: event.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor="crew-org">Organization</Label><Input id="crew-org" required value={state.org} onChange={event => setState(current => ({ ...current, org: event.target.value }))} /></div>
          <div className="space-y-2">
            <Label htmlFor="crew-harness">Harness</Label>
            <select id="crew-harness" className="h-8 w-full rounded-lg border bg-background px-2.5 text-sm" value={state.harness} onChange={event => setState(current => ({ ...current, harness: event.target.value as EmployeeHarness }))}>
              {CREW_EMPLOYEE_HARNESSES.map(harness => <option key={harness.value} value={harness.value}>{harness.label}</option>)}
            </select>
          </div>
          {state.kind === 'work_session' && <div className="space-y-2"><Label htmlFor="crew-request">Initial request <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="crew-request" value={state.initialRequest} onChange={event => setState(current => ({ ...current, initialRequest: event.target.value }))} /></div>}
          <div className="space-y-2"><Label htmlFor="crew-model">Model <span className="font-normal text-muted-foreground">(harness default when blank)</span></Label><Input id="crew-model" value={state.model} onChange={event => setState(current => ({ ...current, model: event.target.value }))} /></div>
          <div className="space-y-2">
            <Label htmlFor="crew-directory">Working directory {state.kind === 'employee' ? '(optional)' : ''}</Label>
            <div className="flex gap-2"><Input id="crew-directory" required={state.kind === 'work_session'} placeholder="/absolute/project/path" value={state.workingDirectory} onChange={event => setState(current => ({ ...current, workingDirectory: event.target.value }))} />{state.kind === 'work_session' && <Button type="button" variant="outline" onClick={browse}>Browse</Button>}</div>
            {state.kind === 'work_session' && browseEntries.length > 0 && <div className="max-h-36 overflow-y-auto rounded border p-1" aria-label="Host directories">{browseEntries.filter(entry => entry.kind === 'directory' && entry.canonical_path).map(entry => <button className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted" type="button" key={entry.name} onClick={() => setState(current => ({ ...current, workingDirectory: entry.canonical_path! }))}>{entry.name}{entry.warning ? ' ⚠' : ''}</button>)}</div>}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="submit" disabled={!valid || submitting}>{submitting ? 'Creating…' : 'Create'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
