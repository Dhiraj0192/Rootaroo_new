import {
  generateInvitation, joinViaCode, removeMember, leaveHousehold, transferAdmin, changeMemberRole, listMembers,
  cancelHouseholdDeletion, rotateInviteCode, getHousehold,
  createHousehold, updateCoverPhoto, removeCoverPhoto,
  requestLeaveHousehold, requestHouseholdDeletion, approveActionRequest, rejectActionRequest,
  getMyPendingActionRequest, getPendingLeaveRequestForAdmin, approveLeaveRequest, rejectLeaveRequest,
} from '../service';
import * as models from '../../../database/models';

jest.mock('../../../shared/utils/s3', () => ({
  getSignedUrl: jest.fn(() => Promise.resolve(null)),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));
import { deleteObject } from '../../../shared/utils/s3';

jest.mock('../../../shared/utils/mailer', () => ({
  sendAdminAlertEmail: jest.fn().mockResolvedValue(undefined),
}));
import { sendAdminAlertEmail } from '../../../shared/utils/mailer';

jest.mock('../../../database/models', () => {
  return {
    sequelize: {
      transaction: jest.fn((optionsOrCb: any, maybeCb?: any) => {
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        return cb({});
      }),
    },
    Household: { create: jest.fn(), findByPk: jest.fn(), findOne: jest.fn() },
    HouseholdMember: { create: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), count: jest.fn(), destroy: jest.fn() },
    HouseholdActionRequest: { create: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), findByPk: jest.fn() },
    Invitation: { create: jest.fn(), findOne: jest.fn(), count: jest.fn() },
    User: { update: jest.fn(), findByPk: jest.fn() },
    // Conversation sync is a no-op in these tests (no household-conversation
    // exists yet) — addToHouseholdConversation/removeFromHouseholdConversation
    // just `return` when Conversation.findOne resolves falsy, so a bare mock
    // (undefined by default) is enough to exercise that early-return path.
    Conversation: { findOne: jest.fn() },
    ConversationParticipant: { findOne: jest.fn(), create: jest.fn(), destroy: jest.fn() },
  };
});

jest.mock('../../../shared/services/notifications', () => ({
  notifyHousehold: jest.fn().mockResolvedValue(undefined),
  notifyUser: jest.fn().mockResolvedValue(undefined),
}));
import { notifyUser } from '../../../shared/services/notifications';

jest.mock('../../billing/entitlement', () => ({
  assertSeatAvailable: jest.fn().mockResolvedValue(undefined),
  clearEntitlementCache: jest.fn().mockResolvedValue(undefined),
}));
import { assertSeatAvailable, clearEntitlementCache } from '../../billing/entitlement';
jest.mock('../../billing/deletion', () => ({
  onHouseholdDeletionScheduled: jest.fn().mockResolvedValue(undefined),
  onHouseholdDeletionCancelled: jest.fn().mockResolvedValue(undefined),
  onHouseholdPurged: jest.fn().mockResolvedValue(undefined),
  syncBillingEmail: jest.fn().mockResolvedValue(undefined),
  reportDeletionHookFailure: jest.fn().mockResolvedValue(undefined),
}));
import { onHouseholdDeletionScheduled, onHouseholdDeletionCancelled, syncBillingEmail, reportDeletionHookFailure } from '../../billing/deletion';
import { PaymentRequiredError } from '../../billing/errors';

const userId = '550e8400-e29b-41d4-a716-446655440001';
const otherUserId = '660e8400-e29b-41d4-a716-446655440002';
const householdId = '550e8400-e29b-41d4-a716-446655440003';

function fakeHousehold(overrides: any = {}) {
  return {
    id: householdId,
    name: 'Test Family',
    inviteCode: 'A1B2C3D4',
    createdAt: new Date('2026-07-04'),
    ...overrides,
  };
}

function fakeMembership(overrides: any = {}) {
  return {
    householdId,
    userId,
    role: 'admin',
    joinedAt: new Date(),
    household: fakeHousehold(),
    ...overrides,
  };
}

function fakeInvitation(overrides: any = {}) {
  return {
    id: 'inv-001',
    householdId,
    invitedBy: userId,
    code: 'INVITE99',
    email: null,
    expiresAt: new Date(Date.now() + 7 * 86400000),
    acceptedAt: null,
    household: fakeHousehold(),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('Household Service — Invitations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateInvitation', () => {
    it('should return invitation code and share link for an admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership());
      (models.Invitation.findOne as jest.Mock).mockResolvedValue(null); // code not taken
      (models.Invitation.create as jest.Mock).mockResolvedValue(fakeInvitation());

      const result = await generateInvitation(userId, householdId);

      expect(result.code).toBeTruthy();
      expect(result.code.length).toBe(8);
      expect(result.shareLink).toContain('rootaroo://join?code=');
      expect(result.expiresAt).toBeTruthy();
      expect(models.Invitation.create).toHaveBeenCalledWith(
        expect.objectContaining({ householdId, invitedBy: userId }),
      );
    });

    it('should throw ForbiddenError for child role', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(
        fakeMembership({ role: 'child' }),
      );

      await expect(generateInvitation(userId, householdId))
        .rejects.toThrow('Children cannot generate invitations');
    });

    it('should throw NotFoundError if user is not a member', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);

      await expect(generateInvitation(userId, householdId))
        .rejects.toThrow('Household not found');
    });
  });

  describe('createHousehold', () => {
    it('should create a household and make the caller its admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValueOnce(null);
      (models.Household.create as jest.Mock).mockResolvedValue(fakeHousehold());
      (models.HouseholdMember.create as jest.Mock).mockResolvedValue({});

      const result = await createHousehold(userId, { name: 'Test Family' });

      expect(result.role).toBe('admin');
      expect(result.memberCount).toBe(1);
      expect(models.User.update).toHaveBeenCalledWith({ role: 'admin' }, expect.objectContaining({ where: { id: userId } }));
    });

    it('should reject if the user already belongs to a household (F-13 race guard)', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValueOnce(fakeMembership());

      await expect(createHousehold(userId, { name: 'Another Family' }))
        .rejects.toThrow('You already belong to a household');
      expect(models.Household.create).not.toHaveBeenCalled();
    });
  });

  describe('joinViaCode', () => {
    function arrangeValidInvite() {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValueOnce(null);
      (models.Invitation.findOne as jest.Mock).mockResolvedValue(fakeInvitation());
      (models.HouseholdMember.count as jest.Mock).mockResolvedValue(2);
      (models.HouseholdMember.create as jest.Mock).mockResolvedValue({});
    }

    it('checks seats inside the join transaction and clears the entitlement cache', async () => {
      arrangeValidInvite();
      await joinViaCode(otherUserId, { code: 'INVITE99' });
      expect(assertSeatAvailable).toHaveBeenCalledWith(householdId, expect.anything());
      expect(clearEntitlementCache).toHaveBeenCalledWith(householdId);
    });

    it('propagates 402 SEAT_LIMIT and creates no membership', async () => {
      (models.HouseholdMember.create as jest.Mock).mockClear();
      arrangeValidInvite();
      (assertSeatAvailable as jest.Mock).mockRejectedValueOnce(new PaymentRequiredError('SEAT_LIMIT', 'full'));
      await expect(joinViaCode(otherUserId, { code: 'INVITE99' })).rejects.toMatchObject({ statusCode: 402, code: 'SEAT_LIMIT' });
      expect(models.HouseholdMember.create).not.toHaveBeenCalled();
    });

    it('should add user as member and mark invitation accepted', async () => {
      const inv = fakeInvitation();
      (models.HouseholdMember.findOne as jest.Mock)
        .mockResolvedValueOnce(null);  // user not in any household
      (models.Invitation.findOne as jest.Mock).mockResolvedValue(inv);
      (models.HouseholdMember.count as jest.Mock).mockResolvedValue(2);
      (models.HouseholdMember.create as jest.Mock).mockResolvedValue({});

      const result = await joinViaCode(otherUserId, { code: 'INVITE99' });

      expect(result).toMatchObject({
        name: 'Test Family',
        role: 'member',
        memberCount: 2,
      });
      expect(inv.update).toHaveBeenCalledWith(
        expect.objectContaining({ acceptedAt: expect.any(Date) }),
        expect.anything(),
      );
    });

    it('should throw ConflictError if user already in a household', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership());

      await expect(joinViaCode(userId, { code: 'INVITE99' }))
        .rejects.toThrow('You already belong to a household');
    });

    it('should throw NotFoundError for invalid code', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);
      (models.Invitation.findOne as jest.Mock).mockResolvedValue(null);
      (models.Household.findOne as jest.Mock).mockResolvedValue(null);

      await expect(joinViaCode(otherUserId, { code: 'BADCODE' }))
        .rejects.toThrow('Invitation not found');
    });

    it('should throw 410 for expired invitation', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);
      (models.Invitation.findOne as jest.Mock).mockResolvedValue(
        fakeInvitation({ expiresAt: new Date('2024-01-01') }),
      );

      await expect(joinViaCode(otherUserId, { code: 'EXPIRED' }))
        .rejects.toThrow('Invitation has expired');
    });

    it('should throw ConflictError for already used invitation', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);
      (models.Invitation.findOne as jest.Mock).mockResolvedValue(
        fakeInvitation({ acceptedAt: new Date('2026-07-03') }),
      );

      await expect(joinViaCode(otherUserId, { code: 'USED' }))
        .rejects.toThrow('This invitation has already been used');
    });
  });
});

describe('Household Service — Member Management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('removeMember', () => {
    it('should allow admin to remove a member', async () => {
      (models.HouseholdMember.findOne as jest.Mock)
        .mockResolvedValueOnce({ role: 'admin' }) // admin membership
        .mockResolvedValueOnce({ role: 'member', destroy: jest.fn().mockResolvedValue(undefined) }); // target membership

      await expect(removeMember(userId, householdId, otherUserId)).resolves.toBeUndefined();
    });

    it('should throw ForbiddenError if requester is not an admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'member' });

      await expect(removeMember(userId, householdId, otherUserId))
        .rejects.toThrow('Only admins can remove members');
    });

    it('should throw error if admin tries to remove self', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'admin' });

      await expect(removeMember(userId, householdId, userId))
        .rejects.toThrow('Use the leave endpoint to remove yourself');
    });

    it('should throw NotFoundError if target is not a member', async () => {
      (models.HouseholdMember.findOne as jest.Mock)
        .mockResolvedValueOnce({ role: 'admin' })
        .mockResolvedValueOnce(null);

      await expect(removeMember(userId, householdId, otherUserId))
        .rejects.toThrow('Member not found');
    });

    it('should throw ForbiddenError if target is another admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock)
        .mockResolvedValueOnce({ role: 'admin' })
        .mockResolvedValueOnce({ role: 'admin' });

      await expect(removeMember(userId, householdId, otherUserId))
        .rejects.toThrow('Cannot remove another admin');
    });
  });

  describe('leaveHousehold', () => {
    it('should allow a member to leave', async () => {
      const destroy = jest.fn().mockResolvedValue(undefined);
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'member', destroy });

      await expect(leaveHousehold(userId, householdId)).resolves.toBeUndefined();
      expect(destroy).toHaveBeenCalled();
    });

    it('should throw ForbiddenError if admin tries to leave without transferring', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'admin' });

      await expect(leaveHousehold(userId, householdId))
        .rejects.toThrow('Transfer admin role to another member before leaving');
    });

    it('should throw NotFoundError if not a member', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);

      await expect(leaveHousehold(userId, householdId))
        .rejects.toThrow('Household not found');
    });
  });

  describe('transferAdmin', () => {
    it('should transfer admin role to another member', async () => {
      const adminMembership = { role: 'admin', update: jest.fn() };
      const targetMembership = { role: 'member', userId: otherUserId, update: jest.fn() };
      (models.HouseholdMember.findOne as jest.Mock)
        .mockResolvedValueOnce(adminMembership)
        .mockResolvedValueOnce(targetMembership);
      (models.HouseholdMember.count as jest.Mock).mockResolvedValue(3);
      (models.Household.findByPk as jest.Mock).mockResolvedValue(fakeHousehold());

      const result = await transferAdmin(userId, householdId, otherUserId);

      expect(adminMembership.update).toHaveBeenCalledWith({ role: 'member' });
      expect(targetMembership.update).toHaveBeenCalledWith({ role: 'admin' });
      expect(result.role).toBe('member');
      expect(syncBillingEmail).toHaveBeenCalledWith(householdId);
    });

    it('should throw ForbiddenError if requester is not admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'member' });

      await expect(transferAdmin(userId, householdId, otherUserId))
        .rejects.toThrow('Only admins can transfer the admin role');
    });

    it('should throw error if transferring to self', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'admin' });

      await expect(transferAdmin(userId, householdId, userId))
        .rejects.toThrow('You are already the admin');
    });

    it('should throw NotFoundError if target is not a member', async () => {
      (models.HouseholdMember.findOne as jest.Mock)
        .mockResolvedValueOnce({ role: 'admin' })
        .mockResolvedValueOnce(null);

      await expect(transferAdmin(userId, householdId, otherUserId))
        .rejects.toThrow('Member not found');
    });
  });

  describe('changeMemberRole', () => {
    const body = { role: 'member' as const };

    it('should change a member role and return updated member', async () => {
      const update = jest.fn();
      (models.HouseholdMember.findOne as jest.Mock)
        .mockResolvedValueOnce({ role: 'admin' }) // admin membership
        .mockResolvedValueOnce({ // target membership with user included
          userId: otherUserId,
          role: 'child',
          joinedAt: new Date(),
          update,
          user: { displayName: 'Other User', email: 'other@test.com', avatarUrl: null, avatarEmoji: null },
        });

      const result = await changeMemberRole(userId, householdId, otherUserId, body);

      expect(update).toHaveBeenCalledWith({ role: 'member' });
      expect(result.role).toBe('member');
      expect(result.userId).toBe(otherUserId);
    });

    it('should throw ForbiddenError if requester is not admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'member' });

      await expect(changeMemberRole(userId, householdId, otherUserId, body))
        .rejects.toThrow('Only admins can change roles');
    });

    it('should throw error if changing own role', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'admin' });

      await expect(changeMemberRole(userId, householdId, userId, body))
        .rejects.toThrow('Use the transfer endpoint to change your own role');
    });

    it('should reject promoting a member to admin (single-admin model, F-12)', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'admin' });

      await expect(changeMemberRole(userId, householdId, otherUserId, { role: 'admin' }))
        .rejects.toThrow('Use the transfer endpoint to make another member admin');
      expect(models.User.update).not.toHaveBeenCalled();
    });
  });

  describe('listMembers', () => {
    it('should return sorted member list with user info', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'admin' });
      (models.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        {
          userId: userId,
          role: 'admin',
          joinedAt: new Date('2026-07-01'),
          user: { displayName: 'Admin User', email: 'admin@test.com', avatarUrl: null, avatarEmoji: null },
        },
        {
          userId: otherUserId,
          role: 'member',
          joinedAt: new Date('2026-07-02'),
          user: { displayName: 'Other User', email: 'other@test.com', avatarUrl: null, avatarEmoji: null },
        },
      ]);

      const result = await listMembers(householdId, userId);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('admin');
      expect(result[1].role).toBe('member');
      expect(result[0].displayName).toBe('Admin User');
    });

    it('should throw NotFoundError if user is not a member', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);

      await expect(listMembers(householdId, userId))
        .rejects.toThrow('Household not found');
    });
  });

  describe('requestLeaveHousehold', () => {
    it('should create a pending leave request and notify the household admin in-app (not email Rootaroo)', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'member' }));
      (models.HouseholdActionRequest.findOne as jest.Mock).mockResolvedValue(null);
      (models.HouseholdActionRequest.create as jest.Mock).mockResolvedValue({ id: 'req-1' });
      (models.User.findByPk as jest.Mock).mockResolvedValue({ id: userId, displayName: 'Test User', email: 'test@test.com' });

      await requestLeaveHousehold(userId, householdId);

      expect(models.HouseholdActionRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({ householdId, requestedBy: userId, type: 'leave' }),
      );
      expect(notifyUser).toHaveBeenCalledWith(
        userId, 'leave_request', 'Leave request', expect.stringContaining('wants to leave'),
        expect.objectContaining({ type: 'leave_request', requestId: 'req-1', householdId }),
      );
      expect(sendAdminAlertEmail).not.toHaveBeenCalled();
      // The membership itself must not be touched yet — only on approval.
      expect(models.HouseholdMember.destroy).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenError if the admin tries to request leaving', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));

      await expect(requestLeaveHousehold(userId, householdId))
        .rejects.toThrow('Transfer admin role to another member');
      expect(models.HouseholdActionRequest.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictError if a leave request is already pending', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'member' }));
      (models.HouseholdActionRequest.findOne as jest.Mock).mockResolvedValue({ id: 'existing', status: 'pending' });

      await expect(requestLeaveHousehold(userId, householdId))
        .rejects.toThrow('already pending review');
      expect(models.HouseholdActionRequest.create).not.toHaveBeenCalled();
    });
  });

  describe('household-admin review of a leave request', () => {
    function fakeLeaveRequest(overrides: any = {}) {
      return {
        id: 'req-9',
        householdId,
        requestedBy: otherUserId,
        type: 'leave',
        status: 'pending',
        reviewerNote: null,
        reviewedAt: null,
        createdAt: new Date('2026-08-01'),
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    describe('getPendingLeaveRequestForAdmin', () => {
      it("returns the pending leave request with the requester's name", async () => {
        (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
        (models.HouseholdActionRequest.findOne as jest.Mock).mockResolvedValue(fakeLeaveRequest());
        (models.User.findByPk as jest.Mock).mockResolvedValue({ displayName: 'Leaving Member' });

        const result = await getPendingLeaveRequestForAdmin(userId, householdId);

        expect(result).toEqual(expect.objectContaining({ id: 'req-9', requestedByName: 'Leaving Member' }));
      });

      it('returns null when there is no pending leave request', async () => {
        (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
        (models.HouseholdActionRequest.findOne as jest.Mock).mockResolvedValue(null);

        const result = await getPendingLeaveRequestForAdmin(userId, householdId);

        expect(result).toBeNull();
      });

      it('throws ForbiddenError for a non-admin caller', async () => {
        (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'member' }));

        await expect(getPendingLeaveRequestForAdmin(userId, householdId))
          .rejects.toThrow('Only the household admin');
      });
    });

    describe('approveLeaveRequest', () => {
      it('removes the member, marks the request approved, and notifies the requester', async () => {
        const destroy = jest.fn().mockResolvedValue(undefined);
        (models.HouseholdMember.findOne as jest.Mock)
          .mockResolvedValueOnce(fakeMembership({ role: 'admin' })) // caller-is-admin check
          .mockResolvedValueOnce({ role: 'member', destroy }); // leaveHousehold's own membership lookup
        (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(fakeLeaveRequest());

        await approveLeaveRequest(userId, householdId, 'req-9');

        expect(destroy).toHaveBeenCalled();
        expect(notifyUser).toHaveBeenCalledWith(
          otherUserId, 'leave_response', 'Leave request approved', expect.any(String),
          expect.objectContaining({ approved: true }),
        );
      });

      it('throws ForbiddenError for a non-admin caller', async () => {
        (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'member' }));

        await expect(approveLeaveRequest(userId, householdId, 'req-9'))
          .rejects.toThrow('Only the household admin');
      });

      it("throws NotFoundError when the request doesn't belong to this household", async () => {
        (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
        (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(
          fakeLeaveRequest({ householdId: 'some-other-household' }),
        );

        await expect(approveLeaveRequest(userId, householdId, 'req-9')).rejects.toThrow('Leave request');
      });
    });

    describe('rejectLeaveRequest', () => {
      it('marks the request rejected and notifies the requester', async () => {
        (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
        const request = fakeLeaveRequest();
        (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(request);

        await rejectLeaveRequest(userId, householdId, 'req-9', 'not now');

        expect(request.status).toBe('rejected');
        expect(request.reviewerNote).toBe('not now');
        expect(notifyUser).toHaveBeenCalledWith(
          otherUserId, 'leave_response', 'Leave request declined', expect.any(String),
          expect.objectContaining({ approved: false }),
        );
      });
    });
  });

  describe('requestHouseholdDeletion', () => {
    it('should create a pending delete request and email the admin alert', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
      (models.HouseholdActionRequest.findOne as jest.Mock).mockResolvedValue(null);
      (models.Household.findByPk as jest.Mock).mockResolvedValue(fakeHousehold());
      (models.HouseholdActionRequest.create as jest.Mock).mockResolvedValue({ id: 'req-2' });
      (models.User.findByPk as jest.Mock).mockResolvedValue({ id: userId, displayName: 'Admin User', email: 'admin@test.com' });

      await requestHouseholdDeletion(userId, householdId);

      expect(models.HouseholdActionRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({ householdId, requestedBy: userId, type: 'delete' }),
      );
      expect(sendAdminAlertEmail).toHaveBeenCalled();
    });

    it('should throw ForbiddenError for a non-admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'member' }));

      await expect(requestHouseholdDeletion(userId, householdId))
        .rejects.toThrow('Only the household admin can request deletion');
      expect(models.HouseholdActionRequest.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictError if a delete request is already pending', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
      (models.HouseholdActionRequest.findOne as jest.Mock).mockResolvedValue({ id: 'existing', status: 'pending' });

      await expect(requestHouseholdDeletion(userId, householdId))
        .rejects.toThrow('already pending review');
      expect(models.HouseholdActionRequest.create).not.toHaveBeenCalled();
    });
  });

  describe('getMyPendingActionRequest', () => {
    it('should return the pending request when one exists', async () => {
      const pending = {
        id: 'req-3', householdId, requestedBy: userId, type: 'leave', status: 'pending',
        reviewerNote: null, reviewedAt: null, createdAt: new Date('2026-08-01'),
      };
      (models.HouseholdActionRequest.findOne as jest.Mock).mockResolvedValue(pending);

      const result = await getMyPendingActionRequest(userId, householdId);

      expect(result).toMatchObject({ id: 'req-3', type: 'leave', status: 'pending' });
    });

    it('should return null when there is no pending request', async () => {
      (models.HouseholdActionRequest.findOne as jest.Mock).mockResolvedValue(null);

      const result = await getMyPendingActionRequest(userId, householdId);

      expect(result).toBeNull();
    });
  });

  describe('approveActionRequest', () => {
    function fakeRequest(overrides: any = {}) {
      return {
        id: 'req-4',
        householdId,
        requestedBy: userId,
        type: 'leave',
        status: 'pending',
        reviewerNote: null,
        reviewedAt: null,
        createdAt: new Date('2026-08-01'),
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    it('should execute leaveHousehold and mark the request approved for a leave request', async () => {
      const request = fakeRequest({ type: 'leave' });
      (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(request);
      const destroy = jest.fn().mockResolvedValue(undefined);
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ role: 'member', destroy });

      await approveActionRequest('req-4');

      expect(destroy).toHaveBeenCalled();
      expect(request.status).toBe('approved');
      expect(request.save).toHaveBeenCalled();
    });

    it('should schedule deletion and mark the request approved for a delete request', async () => {
      const request = fakeRequest({ type: 'delete' });
      (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(request);
      const household = fakeHousehold({ scheduledDeletionAt: null, save: jest.fn().mockResolvedValue(undefined) });
      (models.Household.findByPk as jest.Mock).mockResolvedValue(household);

      await approveActionRequest('req-4', 'looks fine');

      expect(household.scheduledDeletionAt).toBeInstanceOf(Date);
      expect(household.save).toHaveBeenCalled();
      expect(request.status).toBe('approved');
      expect(request.reviewerNote).toBe('looks fine');
      expect(onHouseholdDeletionScheduled).toHaveBeenCalledWith(request.householdId);
    });

    it('raises a review item (via reportDeletionHookFailure) when the scheduled hook fails', async () => {
      const request = fakeRequest({ type: 'delete' });
      (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(request);
      (models.Household.findByPk as jest.Mock).mockResolvedValue(fakeHousehold({ scheduledDeletionAt: null, save: jest.fn().mockResolvedValue(undefined) }));
      const boom = new Error('stripe down');
      (onHouseholdDeletionScheduled as jest.Mock).mockRejectedValueOnce(boom);

      await approveActionRequest('req-4');
      await new Promise((r) => setImmediate(r));

      expect(reportDeletionHookFailure).toHaveBeenCalledWith(request.householdId, 'scheduled', boom);
    });

    it('should throw NotFoundError for an unknown request id', async () => {
      (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(null);

      await expect(approveActionRequest('missing')).rejects.toThrow('Request not found');
    });

    it('should reject re-approving an already-reviewed request', async () => {
      (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(fakeRequest({ status: 'approved' }));

      await expect(approveActionRequest('req-4')).rejects.toThrow('already reviewed');
    });
  });

  describe('rejectActionRequest', () => {
    it('should mark the request rejected with zero side effects', async () => {
      const request = {
        id: 'req-5', householdId, requestedBy: userId, type: 'delete', status: 'pending',
        reviewerNote: null, reviewedAt: null, createdAt: new Date(),
        save: jest.fn().mockResolvedValue(undefined),
      };
      (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(request);

      await rejectActionRequest('req-5', 'not needed');

      expect(request.status).toBe('rejected');
      expect(request.reviewerNote).toBe('not needed');
      expect(models.HouseholdMember.destroy).not.toHaveBeenCalled();
      expect(models.Household.findByPk).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError for an unknown request id', async () => {
      (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue(null);

      await expect(rejectActionRequest('missing')).rejects.toThrow('Request not found');
    });

    it('should reject re-rejecting an already-reviewed request', async () => {
      (models.HouseholdActionRequest.findByPk as jest.Mock).mockResolvedValue({ status: 'rejected' });

      await expect(rejectActionRequest('req-5')).rejects.toThrow('already reviewed');
    });
  });

  describe('cancelHouseholdDeletion', () => {
    it('should clear scheduledDeletionAt for an admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
      const household = fakeHousehold({ scheduledDeletionAt: new Date(), save: jest.fn() });
      (models.Household.findByPk as jest.Mock).mockResolvedValue(household);

      await cancelHouseholdDeletion(userId, householdId);

      expect(household.scheduledDeletionAt).toBeNull();
      expect(household.save).toHaveBeenCalled();
      expect(onHouseholdDeletionCancelled).toHaveBeenCalledWith(householdId);
    });

    it('raises a review item (via reportDeletionHookFailure) when the cancelled hook fails', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
      (models.Household.findByPk as jest.Mock).mockResolvedValue(fakeHousehold({ scheduledDeletionAt: new Date(), save: jest.fn() }));
      const boom = new Error('stripe down');
      (onHouseholdDeletionCancelled as jest.Mock).mockRejectedValueOnce(boom);

      await cancelHouseholdDeletion(userId, householdId);
      await new Promise((r) => setImmediate(r));

      expect(reportDeletionHookFailure).toHaveBeenCalledWith(householdId, 'cancelled', boom);
    });

    it('should throw ForbiddenError for a non-admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'member' }));

      await expect(cancelHouseholdDeletion(userId, householdId))
        .rejects.toThrow('Only the household admin can cancel a scheduled deletion');
    });
  });

  describe('Cover photo (F-16)', () => {
    beforeEach(() => { jest.clearAllMocks(); });

    it('should delete the previous cover photo object after replacing it', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
      const household = fakeHousehold({ coverPhotoUrl: 'household-covers/old-key.jpg', save: jest.fn().mockResolvedValue(undefined) });
      (models.Household.findByPk as jest.Mock).mockResolvedValue(household);
      (models.HouseholdMember.count as jest.Mock).mockResolvedValue(1);

      await updateCoverPhoto(userId, householdId, 'household-covers/new-key.jpg');

      expect(household.coverPhotoUrl).toBe('household-covers/new-key.jpg');
      expect(deleteObject).toHaveBeenCalledWith('household-covers/old-key.jpg');
    });

    it('should not attempt to delete anything when there was no previous cover photo', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
      const household = fakeHousehold({ coverPhotoUrl: null, save: jest.fn().mockResolvedValue(undefined) });
      (models.Household.findByPk as jest.Mock).mockResolvedValue(household);
      (models.HouseholdMember.count as jest.Mock).mockResolvedValue(1);

      await updateCoverPhoto(userId, householdId, 'household-covers/new-key.jpg');

      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('should delete the object on removal (removeCoverPhoto)', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
      const household = fakeHousehold({ coverPhotoUrl: 'household-covers/old-key.jpg', save: jest.fn().mockResolvedValue(undefined) });
      (models.Household.findByPk as jest.Mock).mockResolvedValue(household);
      (models.HouseholdMember.count as jest.Mock).mockResolvedValue(1);

      await removeCoverPhoto(userId, householdId);

      expect(household.coverPhotoUrl).toBeNull();
      expect(deleteObject).toHaveBeenCalledWith('household-covers/old-key.jpg');
    });
  });

  describe('Invite code visibility and rotation (F-05)', () => {
    it('should hide the invite code from a non-admin member', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'member' }));
      (models.Household.findByPk as jest.Mock).mockResolvedValue(fakeHousehold());
      (models.HouseholdMember.count as jest.Mock).mockResolvedValue(2);

      const result = await getHousehold(householdId, userId);

      expect(result.inviteCode).toBeNull();
    });

    it('should include the invite code for an admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
      (models.Household.findByPk as jest.Mock).mockResolvedValue(fakeHousehold());
      (models.HouseholdMember.count as jest.Mock).mockResolvedValue(2);

      const result = await getHousehold(householdId, userId);

      expect(result.inviteCode).toBe('A1B2C3D4');
    });

    it('should rotate the invite code for an admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'admin' }));
      const household = fakeHousehold({ save: jest.fn().mockResolvedValue(undefined) });
      (models.Household.findByPk as jest.Mock).mockResolvedValue(household);
      (models.HouseholdMember.count as jest.Mock).mockResolvedValue(1);

      const result = await rotateInviteCode(userId, householdId);

      expect(household.save).toHaveBeenCalled();
      expect(result.inviteCode).toBe(household.inviteCode);
      expect(result.inviteCode).not.toBe('A1B2C3D4');
    });

    it('should reject rotation from a non-admin', async () => {
      (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(fakeMembership({ role: 'member' }));

      await expect(rotateInviteCode(userId, householdId))
        .rejects.toThrow('Only the household admin can rotate the invite code');
    });
  });
});
