'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Review {
  rule_id: string;
  classification: 'framework' | 'ambiguous';
  explanation: string;
  current_default_digest: string;
  preserved_instance_digest: string | null;
  effective_digest: string;
  proposal: string;
  proposal_digest: string;
  audit_status: 'none' | 'applied';
}

export function contextDecisionKey(review: Pick<Review, 'rule_id' | 'proposal_digest'>, decision: string, replacement?: string): string {
  return JSON.stringify({ rule_id: review.rule_id, proposal_digest: review.proposal_digest, decision, replacement: replacement ?? null });
}

export function retainedContextMutationId(
  pending: { mutationId: string; requestKey: string } | null,
  requestKey: string,
  create: () => string,
): string {
  return pending?.requestKey === requestKey ? pending.mutationId : create();
}

export interface PendingContextBinding { mutationId: string; requestKey: string }
interface SessionStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export function pendingContextStorageKey(agentName: string): string { return `crew:pending-context:${agentName}`; }
export function loadPendingContextBinding(storage: SessionStore | null, agentName: string): PendingContextBinding | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(pendingContextStorageKey(agentName)) ?? 'null');
    return value && typeof value.mutationId === 'string' && typeof value.requestKey === 'string' ? value : null;
  } catch { return null; }
}
export function storePendingContextBinding(storage: SessionStore | null, agentName: string, value: PendingContextBinding | null): void {
  if (!storage) return;
  try {
    if (value) storage.setItem(pendingContextStorageKey(agentName), JSON.stringify(value));
    else storage.removeItem(pendingContextStorageKey(agentName));
  } catch { /* storage unavailable */ }
}

const PENDING_CODES = new Set(['MUTATION_OUTCOME_UNKNOWN', 'MUTATION_PENDING', 'RECOVERY_REQUIRED', 'CREW_RECOVERY_REQUIRED']);

export function ContextOwnershipPanel({ agentName }: { agentName: string }) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const restoredPending = typeof window === 'undefined' ? null : loadPendingContextBinding(window.sessionStorage, agentName);
  const pendingDecisionRef = useRef<PendingContextBinding | null>(restoredPending);
  const [pendingMutationId, setPendingMutationId] = useState<string | null>(restoredPending?.mutationId ?? null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/context`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Context review unavailable');
    setReview(body);
  }, [agentName]);

  useEffect(() => { load().catch(cause => setError(cause instanceof Error ? cause.message : 'Context review unavailable')); }, [load]);

  async function decide(decision: 'approve_merge' | 'replace_default' | 'disable_default') {
    if (!review || !window.confirm(`Confirm ${decision.replaceAll('_', ' ')} for ${review.rule_id}?`)) return;
    const replacementInput = decision === 'replace_default' ? window.prompt('Enter the complete replacement safety content') : undefined;
    if (decision === 'replace_default' && !replacementInput) return;
    const replacement = replacementInput ?? undefined;
    const requestKey = contextDecisionKey(review, decision, replacement);
    const mutationId = retainedContextMutationId(pendingDecisionRef.current, requestKey, () => crypto.randomUUID());
    pendingDecisionRef.current = { mutationId, requestKey };
    storePendingContextBinding(window.sessionStorage, agentName, pendingDecisionRef.current);
    setPendingMutationId(mutationId);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/context`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cortext-intent': 'context-owner-decision',
          'x-cortext-mutation-id': mutationId,
        },
        body: JSON.stringify({ decision, rule_id: review.rule_id, proposal_digest: review.proposal_digest, replacement }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (!PENDING_CODES.has(body.code ?? '')) {
          pendingDecisionRef.current = null;
          storePendingContextBinding(window.sessionStorage, agentName, null);
          setPendingMutationId(null);
        }
        throw new Error(body.error ?? 'Context decision rejected');
      }
      pendingDecisionRef.current = null;
      storePendingContextBinding(window.sessionStorage, agentName, null);
      setPendingMutationId(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Context decision rejected');
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Context ownership</CardTitle>
        <CardDescription>Review effective source and provenance before changing a safety default.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert" className="text-sm text-destructive">{error}{pendingMutationId ? <span className="block font-mono text-xs">Pending mutation: {pendingMutationId}</span> : null}</p>}
        {!review ? <p className="text-sm text-muted-foreground">Loading context provenance…</p> : <>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Classification</dt><dd className="font-medium">{review.classification}</dd></div>
            <div><dt className="text-muted-foreground">Audit status</dt><dd className="font-medium">{review.audit_status}</dd></div>
            <div><dt className="text-muted-foreground">Framework digest</dt><dd className="truncate font-mono text-xs">{review.current_default_digest}</dd></div>
            <div><dt className="text-muted-foreground">Effective digest</dt><dd className="truncate font-mono text-xs">{review.effective_digest}</dd></div>
          </dl>
          <p className="text-sm">{review.explanation}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-xs">{review.proposal}</pre>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => decide('approve_merge')}>Approve merge</Button>
            <Button disabled={busy} variant="outline" onClick={() => decide('replace_default')}>Replace default</Button>
            <Button disabled={busy} variant="destructive" onClick={() => decide('disable_default')}>Disable default</Button>
          </div>
        </>}
      </CardContent>
    </Card>
  );
}
