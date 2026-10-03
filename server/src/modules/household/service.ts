import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Op } from 'sequelize';
import { Transaction } from 'sequelize';
import { sequelize, Household, HouseholdMember, HouseholdActionRequest, Invitation, User, Conversation, ConversationParticipant } from '../../database/models';
import { ConflictError, NotFoundError, ForbiddenError, AppError } from '../../shared/utils/errors';
import { getSignedUrl, deleteObject } from '../../shared/utils/s3';
import { sendAdminAlertEmail } from '../../shared/utils/mailer';
import { getIO } from '../../shared/utils/socket';
import { withDeadlockRetry } from '../../shared/utils/dbRetry';
import { assertSeatAvailable, clearEntitlementCache } from '../billing/entitlement';
import { onHouseholdDeletionScheduled, onHouseholdDeletionCancelled, onHouseholdPurged, syncBillingEmail, reportDeletionHookFailure } from '../billing/deletion';
import logger from '../../shared/utils/logger';
import * as notificationService from '../../shared/services/notifications';
import type {
  CreateHouseholdBody, HouseholdResponse, InvitationResponse, JoinHouseholdBody,
  MemberResponse, ChangeRoleBody, HouseholdActionRequestType, HouseholdActionRequestStatus,
  HouseholdActionRequestResponse, PendingLeaveRequestResponse,
} from './types';

function generateCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Keep the household's 'household'-type conversation (the "Everyone" chat)
 * in sync with actual membership. No-op if that conversation doesn't exist
 * yet (created lazily, on first use, from the chat module).
 */
async function addToHouseholdConversation(householdId: string, userId: string): Promise<void> {
  const conv = await Conversation.findOne({ where: { householdId, type: 'household' } });
  if (!conv) return;
  const existing = await ConversationParticipant.findOne({ where: { conversationId: conv.id, userId } });
  if (existing) return;
  await ConversationParticipant.create({ id: uuidv4(), conversationId: conv.id, userId });
}

async function removeFromHouseholdConversation(householdId: string, userId: string): Promise<void> {
  const conv = await Conversation.findOne({ where: { householdId, type: 'household' } });
  if (!conv) return;
  await ConversationParticipant.destroy({ where: { conversationId: conv.id, userId } });
}

async function toHouseholdResponse(household: Household, role: string, memberCount: number): Promise<HouseholdResponse> {
  return {
    id: household.id,
    name: household.name,
    // The permanent invite code is a standing credential — non-admin
    // members (children especially) don't need it and shouldn't be able
    // to read or re-share it; only an admin can see/rotate it (F-05).
    inviteCode: role === 'admin' ? household.inviteCode : null,
    memberCount,
    role,
    coverPhotoUrl: await getSignedUrl(household.coverPhotoUrl),
    createdAt: household.createdAt.toISOString(),
    scheduledDeletionAt: household.scheduledDeletionAt ? household.scheduledDeletionAt.toISOString() : null,
  };
}

export async function createHousehold(
  userId: string,
  body: CreateHouseholdBody,
): Promise<HouseholdResponse> {
  const { name } = body;

  // The one-membership-per-user invariant isn't enforced at the schema
  // level (no unique constraint on household_members.user_id alone) —
  // without SERIALIZABLE isolation here, two concurrent calls could both
  // pass the existence check before either commits its insert, letting a
  // user end up with two households (F-13).
  return await sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
    async (transaction) => {
      const existing = await HouseholdMember.findOne({ where: { userId }, transaction });
      if (existing) {
        throw new ConflictError('You already belong to a household. Leave it first to create a new one.');
      }

      const inviteCode = generateCode();
      const household = await Household.create({ id: uuidv4(), name, inviteCode }, { transaction });

      await HouseholdMember.create({
        id: uuidv4(), householdId: household.id, userId, role: 'admin', joinedAt: new Date(),
      }, { transaction });

      await User.update({ role: 'admin' }, { where: { id: userId }, transaction });

      return await toHouseholdResponse(household, 'admin', 1);
    },
  );
}

export async function getHousehold(householdId: string, userId: string): Promise<HouseholdResponse> {
  const household = await Household.findByPk(householdId);
  if (!household) throw new NotFoundError('Household');

  const membership = await HouseholdMember.findOne({ where: { householdId, userId } });
  if (!membership) throw new NotFoundError('Household');

  const memberCount = await HouseholdMember.count({ where: { householdId } });

  return await toHouseholdResponse(household, membership.role, memberCount);
}

export async function listUserHouseholds(userId: string): Promise<HouseholdResponse[]> {
  const memberships = await HouseholdMember.findAll({
    where: { userId },
    include: [{ model: Household, as: 'household' }],
  });

  return Promise.all(
    memberships.map(async (m) => {
      const count = await HouseholdMember.count({ where: { householdId: m.householdId } });
      return await toHouseholdResponse(m.household!, m.role, count);
    }),
  );
}

export async function generateInvitation(
  userId: string,
  householdId: string,
): Promise<InvitationResponse> {
  // Verify membership + role
  const membership = await HouseholdMember.findOne({ where: { householdId, userId } });
  if (!membership) throw new NotFoundError('Household');
  if (membership.role === 'child') {
    throw new ForbiddenError('Children cannot generate invitations');
  }

  // Generate unique code
  let code: string;
  let attempts = 0;
  do {
    code = generateCode();
    attempts++;
  } while (await Invitation.findOne({ where: { code } }) && attempts < 5);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const invitation = await Invitation.create({
    id: uuidv4(),
    householdId,
    invitedBy: userId,
    code,
    expiresAt,
  });

  return {
    id: invitation.id,
    code,
    expiresAt: expiresAt.toISOString(),
    shareLink: `rootaroo://join?code=${code}`,
  };
}

/**
 * Rotates the household's permanent invite code. Admin-only — the old
 * code stops working the moment this returns, closing off anyone who saw
 * it previously (a former member, a leaked screenshot, etc.) without any
 * expiry or revocation mechanism otherwise (F-05).
 */
export async function rotateInviteCode(userId: string, householdId: string): Promise<HouseholdResponse> {
  const membership = await getMembership(householdId, userId);
  if (membership.role !== 'admin') {
    throw new ForbiddenError('Only the household admin can rotate the invite code');
  }

  const household = await Household.findByPk(householdId);
  if (!household) throw new NotFoundError('Household');

  household.inviteCode = generateCode();
  await household.save();

  const memberCount = await HouseholdMember.count({ where: { householdId } });
  return await toHouseholdResponse(household, 'admin', memberCount);
}

export async function joinViaCode(userId: string, body: JoinHouseholdBody): Promise<HouseholdResponse> {
  const { code } = body;

  // Same race as createHousehold: the one-membership-per-user invariant
  // has no DB-level unique constraint backing it, so the existence check
  // and the insert must happen inside a single SERIALIZABLE transaction
  // or two concurrent joins could both pass the check (F-13).
  const { household } = await withDeadlockRetry(() => sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
    async (transaction) => {
      const existing = await HouseholdMember.findOne({ where: { userId }, transaction });
      if (existing) {
        throw new ConflictError('You already belong to a household. Leave it first to join another.');
      }

      // First: look up an Invitation record by code
      const invitation = await Invitation.findOne({
        where: { code },
        include: [{ model: Household, as: 'household' }],
        transaction,
      });

      let household: Household;

      if (invitation) {
        if (!invitation.household) {
          throw new AppError(500, 'Invitation references a deleted household');
        }
        if (invitation.expiresAt < new Date()) {
          throw new AppError(410, 'Invitation has expired. Ask the household admin for a new one.');
        }
        if (invitation.acceptedAt) {
          throw new ConflictError('This invitation has already been used.');
        }
        household = invitation.household;
      } else {
        // Fallback: check the household's permanent invite code
        const h = await Household.findOne({ where: { inviteCode: code }, transaction });
        if (!h) {
          throw new NotFoundError('Invitation');
        }
        household = h;
      }

      // Check that the user isn't already a member (double-check)
      const alreadyMember = await HouseholdMember.findOne({
        where: { householdId: household.id, userId },
        transaction,
      });
      if (alreadyMember) {
        throw new ConflictError('You are already a member of this household.');
      }

      // �7.3: seats come from billing_subscriptions inside this transaction,
      // with the household row locked FOR UPDATE (hard cap 10 for everyone).
      await assertSeatAvailable(household.id, transaction);

      // Join
      await HouseholdMember.create({
        id: uuidv4(),
        householdId: household.id,
        userId,
        role: 'member',
        joinedAt: new Date(),
      }, { transaction });

      await User.update({ role: 'member' }, { where: { id: userId }, transaction });

      // Mark invitation as accepted if using an invitation record
      if (invitation && !invitation.acceptedAt) {
        await invitation.update({ acceptedAt: new Date() }, { transaction });
      }

      return { household, invitation };
    },
  ));

  await clearEntitlementCache(household.id);

  // Enrichment, not part of the invariant being protected — fine outside
  // the transaction.
  await addToHouseholdConversation(household.id, userId);

  const memberCount = await HouseholdMember.count({
    where: { householdId: household.id },
  });

  return await toHouseholdResponse(household, 'member', memberCount);
}

export async function updateCoverPhoto(
  userId: string,
  householdId: string,
  coverPhotoUrl: string | null,
): Promise<HouseholdResponse> {
  const membership = await getMembership(householdId, userId);
  if (membership.role !== 'admin') {
    throw new ForbiddenError('Only admins can change the household cover photo');
  }

  const household = await Household.findByPk(householdId);
  if (!household) throw new NotFoundError('Household');

  const previousKey = household.coverPhotoUrl;
  household.coverPhotoUrl = coverPhotoUrl;
  await household.save();

  // Best-effort cleanup of the object this replaces — without it, every
  // re-upload/removal orphans the previous S3 object permanently (F-16).
  // Only ever an S3 key here (never a raw external URL), same assumption
  // getSignedUrl already makes elsewhere in this file.
  if (previousKey && previousKey !== coverPhotoUrl) {
    deleteObject(previousKey).catch((e: Error) =>
      logger.warn('[Household] Failed to delete previous cover photo:', e.message),
    );
  }

  const memberCount = await HouseholdMember.count({ where: { householdId } });
  return await toHouseholdResponse(household, membership.role, memberCount);
}

export async function removeCoverPhoto(userId: string, householdId: string): Promise<HouseholdResponse> {
  return updateCoverPhoto(userId, householdId, null);
}

// ── Member Management ──

async function getMembership(householdId: string, userId: string): Promise<HouseholdMember> {
  const membership = await HouseholdMember.findOne({ where: { householdId, userId } });
  if (!membership) throw new NotFoundError('Household');
  return membership;
}

export async function removeMember(
  adminUserId: string,
  householdId: string,
  targetUserId: string,
): Promise<void> {
  const membership = await getMembership(householdId, adminUserId);
  if (membership.role !== 'admin') {
    throw new ForbiddenError('Only admins can remove members');
  }
  if (targetUserId === adminUserId) {
    throw new AppError(400, 'Use the leave endpoint to remove yourself');
  }

  const target = await HouseholdMember.findOne({ where: { householdId, userId: targetUserId } });
  if (!target) throw new NotFoundError('Member');
  if (target.role === 'admin') {
    throw new ForbiddenError('Cannot remove another admin. Transfer their role first.');
  }

  await target.destroy();
  await removeFromHouseholdConversation(householdId, targetUserId);
  await clearEntitlementCache(householdId);
}

/**
 * Actually removes the member. Not called directly from user action anymore
 * — only from approveActionRequest, once Rootaroo approves a pending
 * 'leave' request (see requestLeaveHousehold below).
 */
export async function leaveHousehold(userId: string, householdId: string): Promise<void> {
  const membership = await getMembership(householdId, userId);
  if (membership.role === 'admin') {
    throw new ForbiddenError(
      'Transfer admin role to another member before leaving the household.',
    );
  }
  await membership.destroy();
  await User.update({ role: 'member' }, { where: { id: userId } });
  await removeFromHouseholdConversation(householdId, userId);
  await clearEntitlementCache(householdId);
}

export async function transferAdmin(
  userId: string,
  householdId: string,
  newAdminId: string,
): Promise<HouseholdResponse> {
  const membership = await getMembership(householdId, userId);
  if (membership.role !== 'admin') {
    throw new ForbiddenError('Only admins can transfer the admin role');
  }
  if (newAdminId === userId) {
    throw new AppError(400, 'You are already the admin');
  }

  const newAdmin = await HouseholdMember.findOne({ where: { householdId, userId: newAdminId } });
  if (!newAdmin) throw new NotFoundError('Member');

  await membership.update({ role: 'member' });
  await newAdmin.update({ role: 'admin' });

  await User.update({ role: 'member' }, { where: { id: userId } });
  await User.update({ role: 'admin' }, { where: { id: newAdminId } });
  void syncBillingEmail(householdId).catch(() => undefined);

  const memberCount = await HouseholdMember.count({ where: { householdId } });
  const household = await Household.findByPk(householdId);
  if (!household) throw new AppError(500, 'Household no longer exists');
  return await toHouseholdResponse(household, 'member', memberCount);
}

export async function changeMemberRole(
  adminUserId: string,
  householdId: string,
  targetUserId: string,
  body: ChangeRoleBody,
): Promise<MemberResponse> {
  const membership = await getMembership(householdId, adminUserId);
  if (membership.role !== 'admin') {
    throw new ForbiddenError('Only admins can change roles');
  }
  if (targetUserId === adminUserId) {
    throw new AppError(400, 'Use the transfer endpoint to change your own role');
  }
  // Single-admin model: this endpoint can promote/demote between member
  // and child, but never mints a second admin — that would leave removeMember
  // unable to ever offboard the extra admin (it blocks removing any admin
  // target), with no bound on how many could accumulate this way (F-12).
  // The only way to become admin is transferAdmin, which also demotes the
  // caller as part of the same swap.
  if (body.role === 'admin') {
    throw new AppError(400, 'Use the transfer endpoint to make another member admin');
  }

  const target = await HouseholdMember.findOne({
    where: { householdId, userId: targetUserId },
    include: [{ model: User, as: 'user' }],
  });
  if (!target) throw new NotFoundError('Member');
  if (!target.user) throw new AppError(500, 'Member record references a deleted user');

  await target.update({ role: body.role });
  await User.update({ role: body.role }, { where: { id: targetUserId } });
  void syncBillingEmail(householdId).catch(() => undefined);

  return {
    userId: target.userId,
    displayName: target.user.displayName,
    email: target.user.email,
    avatarUrl: await getSignedUrl(target.user.avatarUrl),
    avatarEmoji: target.user.avatarEmoji,
    dateOfBirth: target.user.dateOfBirth,
    role: body.role,
    joinedAt: target.joinedAt.toISOString(),
  };
}

export async function listMembers(
  householdId: string,
  userId: string,
): Promise<MemberResponse[]> {
  await getMembership(householdId, userId);

  const members = await HouseholdMember.findAll({
    where: { householdId },
    include: [{ model: User, as: 'user' }],
    order: [['joinedAt', 'ASC']],
  });

  return Promise.all(members.map(async (m) => ({
    userId: m.userId,
    displayName: m.user!.displayName,
    email: m.user!.email,
    avatarUrl: await getSignedUrl(m.user!.avatarUrl),
    avatarEmoji: m.user!.avatarEmoji,
    dateOfBirth: m.user!.dateOfBirth,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
  })));
}

// ── Household Deletion (admin-only, Rootaroo-approved, 30-day grace) ──
//
// Leaving and deleting a household no longer take effect directly from user
// action — both create a pending HouseholdActionRequest that Rootaroo staff
// review via the admin-only API (modules/admin). Only once approved does
// the underlying action actually run (see approveActionRequest below).

function toActionRequestResponse(request: HouseholdActionRequest): HouseholdActionRequestResponse {
  return {
    id: request.id,
    householdId: request.householdId,
    requestedBy: request.requestedBy,
    type: request.type,
    status: request.status,
    reviewerNote: request.reviewerNote,
    reviewedAt: request.reviewedAt ? request.reviewedAt.toISOString() : null,
    createdAt: request.createdAt.toISOString(),
  };
}

async function assertNoPendingRequest(householdId: string, type: HouseholdActionRequestType): Promise<void> {
  const existing = await HouseholdActionRequest.findOne({
    where: { householdId, type, status: 'pending' },
  });
  if (existing) {
    throw new ConflictError(`A ${type} request for this household is already pending review.`);
  }
}

export async function requestLeaveHousehold(userId: string, householdId: string): Promise<void> {
  const membership = await getMembership(householdId, userId);
  if (membership.role === 'admin') {
    throw new ForbiddenError(
      'Transfer admin role to another member before leaving the household.',
    );
  }

  await assertNoPendingRequest(householdId, 'leave');

  const request = await HouseholdActionRequest.create({
    id: uuidv4(),
    householdId,
    requestedBy: userId,
    type: 'leave',
  });

  // Reviewed by the household's own admin, in-app — not Rootaroo staff.
  const [user, adminMembership] = await Promise.all([
    User.findByPk(userId),
    HouseholdMember.findOne({ where: { householdId, role: 'admin' } }),
  ]);
  if (adminMembership) {
    const requesterName = user?.displayName || 'A member';
    const notifyData = { type: 'leave_request', requestId: request.id, householdId };
    notificationService
      .notifyUser(
        adminMembership.userId,
        'leave_request',
        'Leave request',
        `${requesterName} wants to leave the household`,
        notifyData,
      )
      .catch(() => {});
    try {
      getIO().to(`user:${adminMembership.userId}`).emit('household:leave-request', notifyData);
    } catch {
      /* socket not available (e.g. in tests) — push notification above still covers it */
    }
  }
}

export async function requestHouseholdDeletion(userId: string, householdId: string): Promise<void> {
  const membership = await getMembership(householdId, userId);
  if (membership.role !== 'admin') {
    throw new ForbiddenError('Only the household admin can request deletion of the household');
  }

  await assertNoPendingRequest(householdId, 'delete');

  const household = await Household.findByPk(householdId);
  if (!household) throw new NotFoundError('Household');

  const request = await HouseholdActionRequest.create({
    id: uuidv4(),
    householdId,
    requestedBy: userId,
    type: 'delete',
  });

  const user = await User.findByPk(userId);
  await sendAdminAlertEmail(
    'Rootaroo: household deletion request',
    `Request ID: ${request.id}\nHousehold: ${household.name} (${householdId})\nRequested by: ${user?.displayName || userId} (${user?.email || 'unknown'})\nType: delete\n\nApprove: POST /api/v1/admin/requests/${request.id}/approve\nReject: POST /api/v1/admin/requests/${request.id}/reject`,
  ).catch((e: Error) => logger.warn('[Household] Failed to send admin alert email:', e.message));
}

/**
 * The caller's own most recent pending leave/delete request for this
 * household, or null. A given user only ever has one relevant request
 * type for a household (non-admins can only request 'leave', the admin
 * can only request 'delete'), so this single lookup covers both cases.
 */
export async function getMyPendingActionRequest(
  userId: string,
  householdId: string,
): Promise<HouseholdActionRequestResponse | null> {
  const request = await HouseholdActionRequest.findOne({
    where: { householdId, requestedBy: userId, status: 'pending' },
    order: [['createdAt', 'DESC']],
  });
  return request ? toActionRequestResponse(request) : null;
}

export async function listActionRequests(
  status?: HouseholdActionRequestStatus,
): Promise<HouseholdActionRequestResponse[]> {
  const requests = await HouseholdActionRequest.findAll({
    where: status ? { status } : {},
    order: [['createdAt', 'DESC']],
  });
  return requests.map(toActionRequestResponse);
}

export async function approveActionRequest(
  requestId: string,
  reviewerNote?: string,
): Promise<HouseholdActionRequestResponse> {
  let scheduledHouseholdId: string | null = null;
  const result = await sequelize.transaction(async (transaction) => {
    const request = await HouseholdActionRequest.findByPk(requestId, { transaction });
    if (!request) throw new NotFoundError('Request');
    if (request.status !== 'pending') {
      throw new AppError(400, 'Request already reviewed');
    }

    if (request.type === 'leave') {
      await leaveHousehold(request.requestedBy, request.householdId);
    } else {
      const household = await Household.findByPk(request.householdId, { transaction });
      if (!household) throw new NotFoundError('Household');
      household.scheduledDeletionAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await household.save({ transaction });
      scheduledHouseholdId = request.householdId;

      notificationService
        .notifyHousehold(
          request.householdId,
          'household_deletion_scheduled',
          'Household deletion scheduled',
          'An admin has requested this household for deletion — it will be removed in 30 days.',
          { type: 'household_deletion_scheduled', householdId: request.householdId },
          request.requestedBy,
        )
        .catch(() => {});
    }

    request.status = 'approved';
    request.reviewedAt = new Date();
    request.reviewerNote = reviewerNote ?? null;
    await request.save({ transaction });

    return toActionRequestResponse(request);
  });
  if (scheduledHouseholdId) {
    void onHouseholdDeletionScheduled(scheduledHouseholdId).catch((err) => reportDeletionHookFailure(scheduledHouseholdId!, 'scheduled', err));
  }
  return result;
}

export async function rejectActionRequest(
  requestId: string,
  reviewerNote?: string,
): Promise<HouseholdActionRequestResponse> {
  const request = await HouseholdActionRequest.findByPk(requestId);
  if (!request) throw new NotFoundError('Request');
  if (request.status !== 'pending') {
    throw new AppError(400, 'Request already reviewed');
  }

  request.status = 'rejected';
  request.reviewedAt = new Date();
  request.reviewerNote = reviewerNote ?? null;
  await request.save();

  return toActionRequestResponse(request);
}

// ── Household-admin review of a member's leave request ──
//
// Reuses the generic approveActionRequest/rejectActionRequest above (they
// only need a requestId) — these wrappers add the caller-is-this-household's-
// admin check and notify the requester of the outcome, mirroring
// modules/ping/service.ts's respondToPingRequest pattern.

export async function getPendingLeaveRequestForAdmin(
  userId: string,
  householdId: string,
): Promise<PendingLeaveRequestResponse | null> {
  const membership = await getMembership(householdId, userId);
  if (membership.role !== 'admin') {
    throw new ForbiddenError('Only the household admin can view leave requests');
  }

  const request = await HouseholdActionRequest.findOne({
    where: { householdId, type: 'leave', status: 'pending' },
    order: [['createdAt', 'DESC']],
  });
  if (!request) return null;

  const requester = await User.findByPk(request.requestedBy);
  return { ...toActionRequestResponse(request), requestedByName: requester?.displayName || null };
}

async function assertCallerIsHouseholdAdmin(userId: string, householdId: string): Promise<void> {
  const membership = await getMembership(householdId, userId);
  if (membership.role !== 'admin') {
    throw new ForbiddenError('Only the household admin can review leave requests');
  }
}

async function getLeaveRequestForHousehold(householdId: string, requestId: string): Promise<HouseholdActionRequest> {
  const request = await HouseholdActionRequest.findByPk(requestId);
  if (!request || request.householdId !== householdId || request.type !== 'leave') {
    throw new NotFoundError('Leave request');
  }
  return request;
}

export async function approveLeaveRequest(
  adminUserId: string,
  householdId: string,
  requestId: string,
): Promise<HouseholdActionRequestResponse> {
  await assertCallerIsHouseholdAdmin(adminUserId, householdId);
  const request = await getLeaveRequestForHousehold(householdId, requestId);

  const result = await approveActionRequest(requestId);

  notificationService
    .notifyUser(
      request.requestedBy,
      'leave_response',
      'Leave request approved',
      'You have left the household.',
      { type: 'leave_response', approved: true, householdId },
    )
    .catch(() => {});

  return result;
}

export async function rejectLeaveRequest(
  adminUserId: string,
  householdId: string,
  requestId: string,
  reviewerNote?: string,
): Promise<HouseholdActionRequestResponse> {
  await assertCallerIsHouseholdAdmin(adminUserId, householdId);
  const request = await getLeaveRequestForHousehold(householdId, requestId);

  const result = await rejectActionRequest(requestId, reviewerNote);

  notificationService
    .notifyUser(
      request.requestedBy,
      'leave_response',
      'Leave request declined',
      'The household admin declined your request to leave.',
      { type: 'leave_response', approved: false, householdId },
    )
    .catch(() => {});

  return result;
}

export async function cancelHouseholdDeletion(userId: string, householdId: string): Promise<void> {
  const membership = await getMembership(householdId, userId);
  if (membership.role !== 'admin') {
    throw new ForbiddenError('Only the household admin can cancel a scheduled deletion');
  }

  const household = await Household.findByPk(householdId);
  if (!household) throw new NotFoundError('Household');

  household.scheduledDeletionAt = null;
  await household.save();
  void onHouseholdDeletionCancelled(householdId).catch((err) => reportDeletionHookFailure(householdId, 'cancelled', err));

  notificationService
    .notifyHousehold(
      householdId,
      'household_deletion_cancelled',
      'Household deletion cancelled',
      'The scheduled deletion of this household has been cancelled.',
      { type: 'household_deletion_cancelled', householdId },
      userId,
    )
    .catch(() => {});
}

async function finalizeHouseholdDeletion(household: Household): Promise<void> {
  // A failure aborts this household's purge for this run; the hourly job retries it.
  await onHouseholdPurged(household.id);
  // Sever every member's access; the household row itself is soft-deleted
  // (paranoid) so its data can still be audited/recovered if needed — same
  // lightweight approach used for account deletion, no cascading purge of
  // owned content (feed posts, tasks, vault docs, etc.).
  await HouseholdMember.destroy({ where: { householdId: household.id } });
  await household.destroy();
}

/**
 * Finalizes every household whose 30-day grace period has elapsed without
 * a human ever confirming it manually. Without this, scheduledDeletionAt
 * is a timestamp nobody reads — the admin's earlier confirm-deletion call
 * was the only path that ever actually deleted anything, so a scheduled
 * household could sit "pending deletion" forever. Run by a cron job.
 */
export async function finalizeDueHouseholdDeletions(): Promise<number> {
  const due = await Household.findAll({
    where: { scheduledDeletionAt: { [Op.lte]: new Date() } },
  });
  for (const household of due) {
    await finalizeHouseholdDeletion(household);
  }
  return due.length;
}
