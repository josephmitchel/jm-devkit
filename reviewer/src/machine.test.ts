import { describe, expect, it } from 'vitest';

import { checksLockKey, lockHolds, type LockProbe } from './machine.js';

/** A held lock tried from a second connection on a direct address: its own session, and refused. */
const direct: LockProbe = { holderSession: 4101, holderSessionAfter: 4101, secondSession: 4102, secondTook: false };

describe("whether the machine's lock holds on this database address", () => {
  it('holds when a second connection, in a session of its own, is refused the lock', () => {
    expect(lockHolds(direct)).toEqual({ holds: true });
  });

  it('does not hold when the second connection is given a lock that is already held', () => {
    expect(lockHolds({ ...direct, secondTook: true })).toMatchObject({ holds: false });
  });

  it('does not hold when the two connections are one session: a lock asked for twice in a session is given twice', () => {
    expect(lockHolds({ ...direct, secondSession: 4101 })).toMatchObject({ holds: false });
  });

  it('does not hold when the holding connection has changed session, as behind a pooler that shares them', () => {
    expect(lockHolds({ ...direct, holderSessionAfter: 4107 })).toMatchObject({ holds: false });
  });

  it('says why, in words that name the setting to change', () => {
    const proof = lockHolds({ ...direct, secondTook: true });
    expect(proof.holds === false && proof.why).toContain('a second connection was given the lock while it was held');
  });
});

describe("the key of a project's checks lock", () => {
  it('is the same for one project every time, however its name is cased', () => {
    expect(checksLockKey('acme/widgets')).toBe(checksLockKey('acme/widgets'));
    expect(checksLockKey('Acme/Widgets')).toBe(checksLockKey('acme/widgets'));
  });

  it('is apart for two projects', () => {
    expect(checksLockKey('acme/widgets')).not.toBe(checksLockKey('acme/gadgets'));
    expect(checksLockKey('acme/widgets')).not.toBe(checksLockKey('acme/widget'));
  });

  it('is a number Postgres takes as a lock key and shows unchanged: whole, not negative, within 31 bits', () => {
    for (const slug of ['acme/widgets', 'acme/gadgets', 'Zenith/anvils', 'a/b']) {
      const key = checksLockKey(slug);
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(0);
      expect(key).toBeLessThan(2 ** 31);
    }
  });
});
