import { BillingReconciliationItem } from '../../database/models';

export interface ReviewInput {
  livemode: boolean;
  kind: string;
  entityType: string;
  entityId?: string | null;
  providerObjectId?: string | null;
  before?: unknown;
  after?: unknown;
  runId?: string | null;
}

function fields(input: ReviewInput) {
  return {
    livemode: input.livemode, kind: input.kind, entityType: input.entityType, entityId: input.entityId ?? null,
    providerObjectId: input.providerObjectId ?? null, before: input.before ?? null, after: input.after ?? null, runId: input.runId ?? null,
  };
}

export async function raiseReviewItem(input: ReviewInput): Promise<BillingReconciliationItem> {
  if (input.providerObjectId) {
    const open = await BillingReconciliationItem.findOne({
      where: { kind: input.kind, providerObjectId: input.providerObjectId, livemode: input.livemode, resolution: 'needs_review' },
    });
    if (open) {
      if (input.after !== undefined) await open.update({ after: input.after });
      return open;
    }
  }
  return BillingReconciliationItem.create({ ...fields(input), resolution: 'needs_review' });
}

export async function recordAutoFix(input: ReviewInput): Promise<BillingReconciliationItem> {
  return BillingReconciliationItem.create({ ...fields(input), resolution: 'auto_fixed', resolvedBy: 'system', resolvedAt: new Date() });
}
