import { env } from '../../../config/env';
import { __setServicesForTests } from '../../../services';
import { sendAdminAlertEmail } from '../mailer';

describe('mailer', () => {
  const send = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    env.adminEmail = '';
  });

  describe('sendAdminAlertEmail', () => {
    it('should log and return without sending when ADMIN_EMAIL is unset', async () => {
      __setServicesForTests({ email: { name: 'resend', send } });
      env.adminEmail = '';

      await sendAdminAlertEmail('Subject', 'Body');

      expect(send).not.toHaveBeenCalled();
    });

    it('should log and return without sending when the email provider is log', async () => {
      __setServicesForTests({ email: { name: 'log', send } });
      env.adminEmail = 'admin@rootaroo.com';

      await sendAdminAlertEmail('Subject', 'Body');

      expect(send).not.toHaveBeenCalled();
    });

    it('should send to the admin inbox when both are configured', async () => {
      __setServicesForTests({ email: { name: 'resend', send } });
      env.adminEmail = 'admin@rootaroo.com';

      await sendAdminAlertEmail('Subject', 'Body');

      expect(send).toHaveBeenCalledWith({ to: 'admin@rootaroo.com', subject: 'Subject', text: 'Body' });
    });
  });
});
