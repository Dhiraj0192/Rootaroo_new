import { HouseholdMember, User } from '../../database/models';
import * as notificationService from '../../shared/services/notifications';
import { sendEmail, sendAdminAlertEmail } from '../../shared/utils/mailer';
import logger from '../../shared/utils/logger';

export interface Recipient { userId: string; email: string; displayName: string }

export async function getAdminRecipients(householdId: string, excludeUserId?: string): Promise<Recipient[]> {
  const members = await HouseholdMember.findAll({ where: { householdId }, include: [{ model: User, as: 'user', required: false }] });
  const present = members.filter((m) => m.userId !== excludeUserId && m.user);
  const admins = present.filter((m) => m.role === 'admin');
  const chosen = admins.length > 0 ? admins : present.filter((m) => m.role !== 'child');
  return chosen.map((m) => ({ userId: m.userId, email: m.user!.email, displayName: m.user!.displayName }));
}

export async function notifyHouseholdAdmins(
  householdId: string, type: string, title: string, body: string,
  data: Record<string, unknown> = {}, opts: { email?: boolean; excludeUserId?: string } = {},
): Promise<void> {
  try {
    const recipients = await getAdminRecipients(householdId, opts.excludeUserId);
    for (const r of recipients) {
      await notificationService.notifyUser(r.userId, type, title, body, data);
      if (opts.email !== false) {
        await sendEmail(r.email, title, body).catch((err: Error) =>
          logger.warn(`[Billing] email to admin ${r.userId} failed: ${err.message}`));
      }
    }
  } catch (err) {
    logger.error(`[Billing] notifyHouseholdAdmins(${householdId}, ${type}) failed:`, err);
  }
}

export async function alertStaff(subject: string, text: string): Promise<void> {
  try {
    await sendAdminAlertEmail(`[Billing] ${subject}`, text);
  } catch (err) {
    logger.error(`[Billing] staff alert failed (${subject}):`, err);
  }
}
