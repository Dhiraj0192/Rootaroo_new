import { env } from '../../config/env';
import { getEmail } from '../../services';

/** Send an email through the configured provider (see services/). */
export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  await getEmail().send({ to, subject, text });
}

/**
 * Alert Rootaroo's own admin inbox (env.adminEmail) — used for the
 * household leave/delete action-request flow, where a member action needs
 * a human at Rootaroo to review it. Falls back to a console log if the email
 * provider is the log one or ADMIN_EMAIL isn't configured, so the request row
 * is still created either way.
 */
export async function sendAdminAlertEmail(subject: string, text: string): Promise<void> {
  if (!env.adminEmail) {
    console.warn(`[DEV] ADMIN_EMAIL not configured — admin alert not sent: ${subject}\n${text}`);
    return;
  }

  if (getEmail().name === 'log') {
    console.warn(`[DEV] Email provider is log — admin alert for ${env.adminEmail}: ${subject}\n${text}`);
    return;
  }

  await sendEmail(env.adminEmail, subject, text);
}
