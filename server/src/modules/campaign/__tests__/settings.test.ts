jest.mock('../../../database/models', () => ({
  CampaignSetting: { findAll: jest.fn(), upsert: jest.fn() },
}));

import { CampaignSetting } from '../../../database/models';
import {
  CAMPAIGN_SETTING_KEYS, getCampaignSettings, setCampaignSetting, enabledRules, signedOutNudgesEnabled,
} from '../settings';
import { RULES } from '../copy';

const rows = (pairs: Array<[string, boolean]>) => pairs.map(([key, enabled]) => ({ key, enabled, updatedAt: new Date('2026-10-08T00:00:00Z'), updatedBy: 'admin-key' }));

beforeEach(() => jest.clearAllMocks());

describe('campaign settings', () => {
  it('has a master switch, one per rule, and one for signed-out nudges', () => {
    expect(CAMPAIGN_SETTING_KEYS).toEqual(['all', ...RULES, 'signed_out_nudges']);
  });

  it('everything is off until someone switches it on', async () => {
    (CampaignSetting.findAll as jest.Mock).mockResolvedValue([]);
    const s = await getCampaignSettings();
    expect(s.all).toBe(false);
    expect(s.signedOutNudges).toBe(false);
    for (const rule of RULES) expect(s.rules[rule]).toBe(false);
    expect(await enabledRules()).toEqual(new Set());
    expect(await signedOutNudgesEnabled()).toBe(false);
  });

  it('a rule sends only when both it and the master switch are on', async () => {
    (CampaignSetting.findAll as jest.Mock).mockResolvedValue(rows([['inactive_3d', true], ['task_due_tomorrow', true]]));
    expect(await enabledRules()).toEqual(new Set());
    (CampaignSetting.findAll as jest.Mock).mockResolvedValue(rows([['all', true], ['inactive_3d', true], ['task_due_tomorrow', false]]));
    expect(await enabledRules()).toEqual(new Set(['inactive_3d']));
  });

  it('signed-out nudges have their own switch, independent of the master', async () => {
    (CampaignSetting.findAll as jest.Mock).mockResolvedValue(rows([['signed_out_nudges', true]]));
    expect(await signedOutNudgesEnabled()).toBe(true);
  });

  it('records who changed a switch', async () => {
    await setCampaignSetting('inactive_7d', true, 'admin-key');
    expect(CampaignSetting.upsert).toHaveBeenCalledWith({ key: 'inactive_7d', enabled: true, updatedBy: 'admin-key' });
  });

  it('rejects unknown keys', async () => {
    await expect(setCampaignSetting('surprise_blast' as never, true, 'admin-key')).rejects.toThrow('Unknown campaign');
    expect(CampaignSetting.upsert).not.toHaveBeenCalled();
  });

  it('fails closed when settings cannot be read', async () => {
    (CampaignSetting.findAll as jest.Mock).mockRejectedValue(new Error('db down'));
    expect(await enabledRules()).toEqual(new Set());
    expect(await signedOutNudgesEnabled()).toBe(false);
  });
});
