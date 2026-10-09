import { getSms } from '../../services';

export async function sendSms(phoneNumber: string, message: string): Promise<void> {
  await getSms().send(phoneNumber, message);
}
