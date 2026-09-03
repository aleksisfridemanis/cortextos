export function publicWorkSession(value: unknown) {
  const row = value as Record<string, unknown>;
  if (!row || typeof row !== 'object') return value;
  const projected = {
    id: row.id,
    display_name: row.display_name,
    org: row.org,
    harness: row.harness,
    model: row.model,
    room_id: row.room_id,
    lifecycle: row.lifecycle,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_error: row.last_error,
    promoted_employee: row.promoted_employee,
    resumable: ['archived', 'failed'].includes(String(row.lifecycle)) && Boolean(row.resume_handle),
  };
  return Object.fromEntries(Object.entries(projected).filter(([, field]) => field !== undefined));
}
