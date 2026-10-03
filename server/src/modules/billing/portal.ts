import logger from '../../shared/utils/logger';
import { getBillingConfig, getStripe } from './config';
import type { BillingMode } from './types';

const configIds = new Map<BillingMode, string | null>();

export function __clearPortalCacheForTests(): void { configIds.clear(); }

/** The configuration created by stripe-bootstrap (plan switching off, cancel at period end). */
export async function getPortalConfigurationId(mode: BillingMode): Promise<string | undefined> {
  if (configIds.has(mode)) return configIds.get(mode) ?? undefined;
  const list = await getStripe(mode).billingPortal.configurations.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 500 });
  const mine = list.find((c) => c.metadata?.rootaroo_portal === 'v1');
  if (!mine) logger.warn(`[Billing] no Rootaroo portal configuration in ${mode} mode; run stripe-bootstrap`);
  configIds.set(mode, mine?.id ?? null);
  return mine?.id;
}

export async function createPortalUrl(mode: BillingMode, customerId: string): Promise<string> {
  const configuration = await getPortalConfigurationId(mode);
  const session = await getStripe(mode).billingPortal.sessions.create({
    customer: customerId,
    return_url: `${getBillingConfig().publicBaseUrl}/api/v1/billing/return/portal`,
    ...(configuration ? { configuration } : {}),
  });
  return session.url;
}
