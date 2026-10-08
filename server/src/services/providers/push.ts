import logger from '../../shared/utils/logger';
import type { PushProvider } from '../types';

// expoPush pulls in the DB models; require it on first use so selecting the log
// provider (and every unit test's default init) never touches the database.
// Sync require keeps send() calling through in the same tick as before.
const expo = (): typeof import('../../shared/utils/expoPush') =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../shared/utils/expoPush');

export const expoPush: PushProvider = {
  name: 'expo',
  send: (tokens, title, body, data, opts) => expo().sendExpoPush(tokens, title, body, data, opts),
  checkReceipts: (now) => expo().checkPushReceipts(now),
};

export const logPush: PushProvider = {
  name: 'log',
  async send(tokens, title) {
    logger.info(`[Push:log] ${tokens.length} token(s) title=${title}`);
  },
  async checkReceipts() {
    return { checked: 0, removedTokens: 0 };
  },
};
