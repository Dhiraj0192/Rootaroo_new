jest.mock('../../../database/models', () => ({ HouseholdMember: { findAll: jest.fn() }, User: {} }));
jest.mock('../../../shared/services/notifications', () => ({ notifyUser: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../shared/utils/mailer', () => ({ sendEmail: jest.fn(), sendAdminAlertEmail: jest.fn() }));

import * as models from '../../../database/models';
import { notifyUser } from '../../../shared/services/notifications';
import { sendEmail, sendAdminAlertEmail } from '../../../shared/utils/mailer';
import { getAdminRecipients, notifyHouseholdAdmins, alertStaff } from '../notify';

const m = (userId: string, role: string, email: string | null) => ({ userId, role, user: email ? { email, displayName: userId } : null });

beforeEach(() => jest.clearAllMocks());

describe('notify', () => {
  it('targets admins, excluding a given user and deleted users', async () => {
    (models.HouseholdMember.findAll as jest.Mock).mockResolvedValue([m('a1', 'admin', 'a1@x'), m('a2', 'admin', null), m('u1', 'member', 'u1@x')]);
    expect((await getAdminRecipients('h1')).map((r) => r.userId)).toEqual(['a1']);
  });

  it('falls back to non-child members when no admin remains', async () => {
    (models.HouseholdMember.findAll as jest.Mock).mockResolvedValue([m('a1', 'admin', 'a1@x'), m('u1', 'member', 'u1@x'), m('c1', 'child', 'c1@x')]);
    expect((await getAdminRecipients('h1', 'a1')).map((r) => r.userId)).toEqual(['u1']);
  });

  it('sends in-app and email, and survives email failures', async () => {
    (models.HouseholdMember.findAll as jest.Mock).mockResolvedValue([m('a1', 'admin', 'a1@x')]);
    (sendEmail as jest.Mock).mockRejectedValue(new Error('Resend down'));
    await expect(notifyHouseholdAdmins('h1', 'billing_payment_failed', 'T', 'B', { x: 1 })).resolves.toBeUndefined();
    expect(notifyUser).toHaveBeenCalledWith('a1', 'billing_payment_failed', 'T', 'B', { x: 1 });
    expect(sendEmail).toHaveBeenCalledWith('a1@x', 'T', 'B');
  });

  it('alertStaff prefixes and never throws', async () => {
    (sendAdminAlertEmail as jest.Mock).mockRejectedValue(new Error('x'));
    await expect(alertStaff('dead event', 'details')).resolves.toBeUndefined();
    expect(sendAdminAlertEmail).toHaveBeenCalledWith('[Billing] dead event', 'details');
  });
});
