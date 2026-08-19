import { describe, it, expect } from 'vitest';
import {
  dmRoomId,
  agentRoomId,
  channelRoomId,
  validateRoomId,
  normalizeMember,
} from '../../../src/rooms/id';
import { buildPairKey, type CommsIdentity } from '@/lib/comms-identity';

describe('room ids', () => {
  it('derives the same dm id regardless of argument order', () => {
    expect(dmRoomId('boris', 'nick')).toBe('dm-boris--nick');
    expect(dmRoomId('nick', 'boris')).toBe('dm-boris--nick');
  });

  it('normalizes case and surrounding whitespace before deriving', () => {
    expect(normalizeMember('  Boris ')).toBe('boris');
    expect(dmRoomId('  BORIS ', 'Nick')).toBe(dmRoomId('boris', 'nick'));
  });

  it("dm ids are exactly 'dm-' + the dashboard pair key", () => {
    // The /api/comms/channel/[pair] URL contract depends on this: the room id
    // must stay derivable from the pair the dashboard already routes on.
    const identity: CommsIdentity = {
      agents: new Set(['boris', 'nick']),
      canonicalUser: 'james',
    };
    expect(dmRoomId('boris', 'nick')).toBe('dm-' + buildPairKey('boris', 'nick', identity));
    expect(dmRoomId('james', 'nick')).toBe('dm-' + buildPairKey('james', 'nick', identity));
  });

  it('derives agent and channel ids', () => {
    expect(agentRoomId('Boris')).toBe('agent-boris');
    expect(channelRoomId('build-log')).toBe('ch-build-log');
  });

  it('rejects ids that would escape or split the path', () => {
    expect(() => validateRoomId('../etc')).toThrow();
    expect(() => validateRoomId('..')).toThrow();
    expect(() => validateRoomId('a/b')).toThrow();
    expect(() => validateRoomId('.')).toThrow();
    expect(() => validateRoomId('dm-a--b/../..')).toThrow();
    expect(() => validateRoomId('')).toThrow();
    expect(() => validateRoomId('Dm-Upper')).toThrow();
  });

  it('rejects a traversal attempt smuggled through a member name', () => {
    expect(() => dmRoomId('../../etc/passwd', 'nick')).toThrow();
    expect(() => channelRoomId('../secrets')).toThrow();
  });

  it('refuses an empty member instead of minting a degenerate room', () => {
    // 'dm-boris--' passes ROOM_ID_PATTERN, so an unresolved identity would
    // otherwise create half-empty rooms silently.
    expect(() => dmRoomId('boris', '')).toThrow(/empty/);
    expect(() => dmRoomId('  ', 'nick')).toThrow(/empty/);
    expect(() => agentRoomId('')).toThrow(/empty/);
    expect(() => normalizeMember('')).toThrow(/empty/);
  });

  it('accepts the ids it derives', () => {
    expect(validateRoomId(dmRoomId('boris', 'nick'))).toBe('dm-boris--nick');
  });
});
