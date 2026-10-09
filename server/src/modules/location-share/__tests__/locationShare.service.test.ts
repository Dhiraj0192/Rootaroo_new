jest.mock('../../../database/models', () => ({
  LocationShare: { create: jest.fn(), findAll: jest.fn(), findByPk: jest.fn(), update: jest.fn() },
  HouseholdMember: { findAll: jest.fn() },
  User: { findByPk: jest.fn() },
}));
jest.mock('../../../shared/utils/household', () => ({ getUserHousehold: jest.fn(async () => 'h1') }));
jest.mock('../../../shared/services/notifications', () => ({ notifyUser: jest.fn().mockResolvedValue(undefined) }));

const emitted: Array<{ room: string; event: string }> = [];
jest.mock('../../../shared/utils/socket', () => ({
  getIO: jest.fn(() => ({ to: (room: string) => ({ emit: (event: string) => emitted.push({ room, event }) }) })),
}));

import { Op } from 'sequelize';
import { LocationShare, HouseholdMember, User } from '../../../database/models';
import { notifyUser } from '../../../shared/services/notifications';
import {
  startShare, updateShareLocation, stopShare, listShares, endExpiredShares, audienceOf, MAX_SHARE_MINUTES, endSharesForMember,
} from '../service';
import { AppError, ForbiddenError, NotFoundError } from '../../../shared/utils/errors';

const NOW = new Date('2026-10-08T10:00:00Z');
const MIN = 60_000;

function share(overrides: Record<string, unknown> = {}) {
  const s: Record<string, unknown> = {
    id: 's1', householdId: 'h1', sharerId: 'me', viewerIds: null, pingRequestId: null,
    startedAt: NOW, expiresAt: new Date(NOW.getTime() + 60 * MIN), endedAt: null,
    latitude: 27.7, longitude: 85.3, accuracy: 10, locationUpdatedAt: NOW,
    sharer: { id: 'me', displayName: 'Asha Rao', avatarUrl: null },
    save: jest.fn().mockResolvedValue(undefined),
    get: jest.fn((k: string) => (k === 'sharer' ? s.sharer : undefined)),
    ...overrides,
  };
  return s;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  emitted.length = 0;
  (HouseholdMember.findAll as jest.Mock).mockResolvedValue([{ userId: 'me' }, { userId: 'ravi' }, { userId: 'mina' }]);
  (User.findByPk as jest.Mock).mockResolvedValue({ id: 'me', displayName: 'Asha Rao', avatarUrl: null });
  (LocationShare.update as jest.Mock).mockResolvedValue([1]);
  (LocationShare.findAll as jest.Mock).mockResolvedValue([]);
});
afterEach(() => jest.useRealTimers());

describe('audienceOf', () => {
  it('is every other member when shared with everyone', () => {
    expect(audienceOf({ sharerId: 'me', viewerIds: null } as never, ['me', 'ravi', 'mina'])).toEqual(['ravi', 'mina']);
  });
  it('is the chosen people who are still in the household', () => {
    expect(audienceOf({ sharerId: 'me', viewerIds: ['mina', 'gone'] } as never, ['me', 'ravi', 'mina'])).toEqual(['mina']);
  });
});

describe('startShare', () => {
  it('caps shares at 8 hours', () => {
    expect(MAX_SHARE_MINUTES).toBe(480);
  });

  it('creates a share, ends any earlier one, and tells the audience', async () => {
    (LocationShare.create as jest.Mock).mockImplementation(async (v) => share(v));
    (LocationShare.findByPk as jest.Mock).mockImplementation(async () => share());
    const res = await startShare('me', { durationMinutes: 60, viewerIds: null, latitude: 27.7, longitude: 85.3, accuracy: 10 });
    expect(LocationShare.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sharerId: 'me', endedAt: null }) }),
    );
    expect(LocationShare.create).toHaveBeenCalledWith(expect.objectContaining({
      householdId: 'h1', sharerId: 'me', viewerIds: null, startedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60 * MIN), latitude: 27.7, longitude: 85.3, accuracy: 10,
    }), undefined);
    expect(emitted.filter((e) => e.event === 'location:share-started').map((e) => e.room).sort()).toEqual(['user:me', 'user:mina', 'user:ravi']);
    expect(notifyUser).toHaveBeenCalledWith('ravi', 'location_share_started', 'Asha is sharing their location', 'For 1 hour', { type: 'location_share_started', shareId: expect.any(String) });
    expect(notifyUser).not.toHaveBeenCalledWith('me', expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect(res.sharer.displayName).toBe('Asha Rao');
  });

  it("ends the sharer's earlier share and tells its audience before creating the new one", async () => {
    const old = share({ id: 'old', viewerIds: null });
    (LocationShare.findAll as jest.Mock).mockResolvedValue([old]);
    (LocationShare.create as jest.Mock).mockImplementation(async (v) => {
      // the old share's end must already have gone out
      expect(emitted.filter((e) => e.event === 'location:share-ended').length).toBeGreaterThan(0);
      return share(v);
    });
    (LocationShare.findByPk as jest.Mock).mockImplementation(async () => share());
    await startShare('me', { durationMinutes: 30, viewerIds: ['mina'], latitude: 1, longitude: 2 });
    expect(old.endedAt).toEqual(NOW);
    expect(old.latitude).toBeNull();
    expect(old.longitude).toBeNull();
    expect(old.accuracy).toBeNull();
    expect(old.save).toHaveBeenCalled();
    const ended = emitted.filter((e) => e.event === 'location:share-ended').map((e) => e.room);
    expect(ended).toEqual(expect.arrayContaining(['user:ravi', 'user:mina']));
  });

  it('only tells the chosen people', async () => {
    (LocationShare.create as jest.Mock).mockImplementation(async (v) => share(v));
    (LocationShare.findByPk as jest.Mock).mockImplementation(async () => share({ viewerIds: ['mina'] }));
    await startShare('me', { durationMinutes: 15, viewerIds: ['mina'], latitude: 1, longitude: 2 });
    expect((notifyUser as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['mina']);
    expect(notifyUser).toHaveBeenCalledWith('mina', 'location_share_started', expect.any(String), 'For 15 minutes', expect.anything());
  });

  it('rejects viewers outside the household or the sharer themselves', async () => {
    await expect(startShare('me', { durationMinutes: 15, viewerIds: ['stranger'], latitude: 1, longitude: 2 })).rejects.toBeInstanceOf(AppError);
    await expect(startShare('me', { durationMinutes: 15, viewerIds: ['me'], latitude: 1, longitude: 2 })).rejects.toBeInstanceOf(AppError);
    await expect(startShare('me', { durationMinutes: 15, viewerIds: [], latitude: 1, longitude: 2 })).rejects.toBeInstanceOf(AppError);
    expect(LocationShare.create).not.toHaveBeenCalled();
  });

  it('refuses more than 8 hours even if validation was bypassed', async () => {
    await expect(startShare('me', { durationMinutes: 481, viewerIds: null, latitude: 1, longitude: 2 })).rejects.toBeInstanceOf(AppError);
  });
});

describe('updateShareLocation', () => {
  it('stores the new position with a conditional update and sends it to the audience only', async () => {
    const s = share();
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(s);
    await updateShareLocation('me', 's1', { latitude: 27.71, longitude: 85.31, accuracy: 8 });
    expect(LocationShare.update).toHaveBeenCalledWith(
      { latitude: 27.71, longitude: 85.31, accuracy: 8, locationUpdatedAt: NOW },
      { where: { id: 's1', sharerId: 'me', endedAt: null, expiresAt: { [Op.gt]: NOW } } },
    );
    expect(emitted.filter((e) => e.event === 'location:update').map((e) => e.room).sort()).toEqual(['user:me', 'user:mina', 'user:ravi']);
  });

  it('only the sharer can update', async () => {
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(share());
    await expect(updateShareLocation('ravi', 's1', { latitude: 1, longitude: 2 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('answers 410 once the share has ended or expired, so the phone stops sending', async () => {
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(share({ endedAt: NOW }));
    await expect(updateShareLocation('me', 's1', { latitude: 1, longitude: 2 })).rejects.toMatchObject({ statusCode: 410 });
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(share({ expiresAt: new Date(NOW.getTime() - 1) }));
    await expect(updateShareLocation('me', 's1', { latitude: 1, longitude: 2 })).rejects.toMatchObject({ statusCode: 410 });
  });

  it('answers 410 and emits nothing when the share ended between the check and the write', async () => {
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(share());
    (LocationShare.update as jest.Mock).mockResolvedValue([0]);
    await expect(updateShareLocation('me', 's1', { latitude: 1, longitude: 2 })).rejects.toMatchObject({ statusCode: 410 });
    expect(emitted.filter((e) => e.event === 'location:update')).toEqual([]);
  });

  it('404s for an unknown share', async () => {
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(null);
    await expect(updateShareLocation('me', 'nope', { latitude: 1, longitude: 2 })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('stopShare', () => {
  it('ends the share and tells everyone who could see it', async () => {
    const s = share();
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(s);
    await stopShare('me', 's1');
    expect(s.endedAt).toEqual(NOW);
    expect(emitted.filter((e) => e.event === 'location:share-ended').map((e) => e.room).sort()).toEqual(['user:me', 'user:mina', 'user:ravi']);
  });

  it('children and adults alike can stop their own share; nobody can stop someone else\'s', async () => {
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(share());
    await expect(stopShare('ravi', 's1')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('listShares', () => {
  it('returns my active share and the active shares I am allowed to see', async () => {
    (LocationShare.findAll as jest.Mock).mockResolvedValue([
      share({ id: 'everyone', sharerId: 'ravi', sharer: { id: 'ravi', displayName: 'Ravi', avatarUrl: null } }),
      share({ id: 'onlyMina', sharerId: 'ravi', viewerIds: ['mina'] }),
      share({ id: 'forMe', sharerId: 'mina', viewerIds: ['me'] }),
      share({ id: 'own', sharerId: 'me' }),
    ]);
    const res = await listShares('me');
    expect(LocationShare.findAll).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ householdId: 'h1', endedAt: null }),
    }));
    expect(res.mine?.id).toBe('own');
    expect(res.visible.map((s) => s.id).sort()).toEqual(['everyone', 'forMe']);
  });
});

describe('endExpiredShares', () => {
  it('closes shares past their expiry and tells their audience', async () => {
    const s = share({ expiresAt: new Date(NOW.getTime() - MIN) });
    (LocationShare.findAll as jest.Mock).mockResolvedValue([s]);
    expect(await endExpiredShares(NOW)).toBe(1);
    expect(s.endedAt).toEqual(s.expiresAt);
    expect(emitted.some((e) => e.event === 'location:share-ended' && e.room === 'user:ravi')).toBe(true);
  });
});

describe('updateShareLocation after leaving the household', () => {
  it('ends the share and answers 410 when the sharer is no longer a member', async () => {
    const s = share();
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(s);
    (HouseholdMember.findAll as jest.Mock).mockResolvedValue([{ userId: 'ravi' }, { userId: 'mina' }]);
    await expect(updateShareLocation('me', 's1', { latitude: 1, longitude: 2 })).rejects.toMatchObject({ statusCode: 410 });
    expect(s.endedAt).toEqual(NOW);
    expect(s.latitude).toBeNull();
    expect(LocationShare.update).not.toHaveBeenCalled();
    expect(emitted.filter((e) => e.event === 'location:update')).toEqual([]);
    expect(emitted.some((e) => e.event === 'location:share-ended' && e.room === 'user:me')).toBe(true);
  });
});

describe('endSharesForMember', () => {
  const tx = () => {
    const hooks: Array<() => void> = [];
    return { hooks, afterCommit: (fn: () => void) => hooks.push(fn) } as any;
  };

  it("ends the person's running shares in that household and announces it after commit", async () => {
    const mine = share({ id: 'mine' });
    (LocationShare.findAll as jest.Mock).mockResolvedValueOnce([mine]).mockResolvedValueOnce([]);
    (LocationShare.findByPk as jest.Mock).mockResolvedValue(mine);
    (HouseholdMember.findAll as jest.Mock).mockResolvedValue([{ userId: 'ravi' }, { userId: 'mina' }]);
    const t = tx();
    await endSharesForMember('me', 'h1', t);
    expect((LocationShare.findAll as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({
      where: { sharerId: 'me', householdId: 'h1', endedAt: null }, transaction: t,
    }));
    expect(mine.endedAt).toEqual(NOW);
    expect(mine.save).toHaveBeenCalledWith({ transaction: t });
    expect(emitted).toEqual([]); // nothing goes out before the membership change commits
    t.hooks.forEach((fn: () => void) => fn());
    for (let i = 0; i < 20; i += 1) await Promise.resolve(); // the suite runs on fake timers
    const ended = emitted.filter((e) => e.event === 'location:share-ended').map((e) => e.room).sort();
    expect(ended).toEqual(['user:me', 'user:mina', 'user:ravi']);
  });

  it('takes away the shares they could see, and leaves shares for other people alone', async () => {
    const forEveryone = share({ id: 'all', sharerId: 'ravi', viewerIds: null });
    const forMe = share({ id: 'mine-to-see', sharerId: 'mina', viewerIds: ['me'] });
    const notForMe = share({ id: 'other', sharerId: 'mina', viewerIds: ['ravi'] });
    (LocationShare.findAll as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([forEveryone, forMe, notForMe]);
    (LocationShare.findByPk as jest.Mock).mockImplementation(async (id: string) => share({ id }));
    await endSharesForMember('me', 'h1');
    const toMe = emitted.filter((e) => e.room === 'user:me' && e.event === 'location:share-ended');
    expect(toMe).toHaveLength(2);
    expect(forEveryone.endedAt).toBeNull();
    expect(emitted.every((e) => e.room === 'user:me')).toBe(true);
  });
});
