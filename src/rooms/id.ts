/**
 * Room id derivation.
 *
 * Ids are DERIVED from participants, never allocated — two processes that
 * never talk to each other still agree on the id for a conversation. Every
 * id is a single path segment, so it is validated against a strict allowlist
 * BEFORE it is joined onto CTX_ROOT.
 *
 * The dm- form is deliberately `'dm-' + <dashboard pair key>` so the existing
 * /api/comms/channel/[pair] URL contract keeps working unchanged.
 */

const ROOM_ID_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Normalize a participant name to its canonical, comparable form.
 *
 * @throws on an empty name. `dm-agent--` passes ROOM_ID_PATTERN, so an
 *   unresolved identity would otherwise create degenerate rooms silently.
 */
export function normalizeMember(name: string): string {
  const normalized = (name ?? '').trim().toLowerCase();
  if (!normalized) throw new Error('Invalid room member: name is empty');
  return normalized;
}

/** Room id for a 1:1 conversation. Order-independent. */
export function dmRoomId(a: string, b: string): string {
  const pair = [normalizeMember(a), normalizeMember(b)].sort().join('--');
  return validateRoomId(`dm-${pair}`);
}

/** Room id for an agent-scoped room (its own session feed). */
export function agentRoomId(agent: string): string {
  return validateRoomId(`agent-${normalizeMember(agent)}`);
}

/** Room id for a named multi-member channel. */
export function channelRoomId(slug: string): string {
  return validateRoomId(`ch-${normalizeMember(slug)}`);
}

/**
 * Reject anything that is not a safe single path segment — `..`, `/`, `.`
 * and friends never reach a path join.
 *
 * @throws if the id is not allowlisted.
 */
export function validateRoomId(id: string): string {
  if (!ROOM_ID_PATTERN.test(id)) {
    throw new Error(`Invalid room id '${id}': must match ${ROOM_ID_PATTERN}`);
  }
  return id;
}
