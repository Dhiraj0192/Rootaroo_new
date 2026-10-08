import { CampaignSetting } from '../../database/models';
import logger from '../../shared/utils/logger';
import { RULES, type CampaignRule } from './copy';

export const CAMPAIGN_SETTING_KEYS = ['all', ...RULES, 'signed_out_nudges'] as const;
export type CampaignSettingKey = (typeof CAMPAIGN_SETTING_KEYS)[number];

export interface CampaignSettings {
  all: boolean;
  rules: Record<CampaignRule, boolean>;
  signedOutNudges: boolean;
  updated: Record<CampaignSettingKey, { updatedAt: Date; updatedBy: string | null } | null>;
}

/** Everything off. Used when nothing is stored yet and when the table can't be read, so a fault never switches campaigns on. */
function allOff(): CampaignSettings {
  return {
    all: false,
    rules: Object.fromEntries(RULES.map((r) => [r, false])) as Record<CampaignRule, boolean>,
    signedOutNudges: false,
    updated: Object.fromEntries(CAMPAIGN_SETTING_KEYS.map((k) => [k, null])) as CampaignSettings['updated'],
  };
}

export async function getCampaignSettings(): Promise<CampaignSettings> {
  const out = allOff();
  try {
    const rows = await CampaignSetting.findAll();
    for (const row of rows) {
      const key = row.key as CampaignSettingKey;
      if (!CAMPAIGN_SETTING_KEYS.includes(key)) continue;
      out.updated[key] = { updatedAt: row.updatedAt, updatedBy: row.updatedBy };
      if (key === 'all') out.all = row.enabled;
      else if (key === 'signed_out_nudges') out.signedOutNudges = row.enabled;
      else out.rules[key] = row.enabled;
    }
    return out;
  } catch (err) {
    logger.error('[Campaigns] could not read settings; treating everything as off:', err);
    return allOff();
  }
}

export async function setCampaignSetting(key: CampaignSettingKey, enabled: boolean, actor: string): Promise<void> {
  if (!CAMPAIGN_SETTING_KEYS.includes(key)) throw new Error(`Unknown campaign: ${key}`);
  await CampaignSetting.upsert({ key, enabled, updatedBy: actor });
  logger.info(`[Campaigns] ${key} switched ${enabled ? 'on' : 'off'} by ${actor}`);
}

/** Rules that may send: the master switch and the rule's own switch must both be on. */
export async function enabledRules(): Promise<Set<CampaignRule>> {
  const s = await getCampaignSettings();
  if (!s.all) return new Set();
  return new Set(RULES.filter((r) => s.rules[r]));
}

export async function signedOutNudgesEnabled(): Promise<boolean> {
  return (await getCampaignSettings()).signedOutNudges;
}
