import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';
import type { BillingInterval, BillingProvider, SubscriptionStatus } from '../../modules/billing/types';

class BillingSubscription extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare provider: BillingProvider;
  declare livemode: boolean;
  declare providerSubscriptionId: string;
  declare status: SubscriptionStatus;
  declare interval: BillingInterval;
  declare seats: number;
  declare priceId: string | null;
  declare priceSet: string | null;
  declare unitAmount: number | null;
  declare currency: string | null;
  declare currentPeriodStart: Date | null;
  declare currentPeriodEnd: Date | null;
  declare cancelAtPeriodEnd: CreationOptional<boolean>;
  declare canceledAt: Date | null;
  declare endedAt: Date | null;
  declare pendingUpdate: Record<string, unknown> | null;
  declare graceUntil: Date | null;
  declare purchasedByUserId: string | null;
  declare eventWatermark: number | null;
  declare lastSyncedAt: Date | null;
  declare planChangeVersion: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingSubscription.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    householdId: { type: DataTypes.UUID, allowNull: false, field: 'household_id' },
    provider: { type: DataTypes.ENUM('stripe', 'apple', 'google'), allowNull: false },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    providerSubscriptionId: { type: DataTypes.STRING(255), allowNull: false, field: 'provider_subscription_id' },
    status: {
      type: DataTypes.ENUM('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused'),
      allowNull: false,
    },
    interval: { type: DataTypes.ENUM('month', 'year'), allowNull: false },
    seats: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    priceId: { type: DataTypes.STRING(255), allowNull: true, field: 'price_id' },
    priceSet: { type: DataTypes.STRING(32), allowNull: true, field: 'price_set' },
    unitAmount: { type: DataTypes.INTEGER, allowNull: true, field: 'unit_amount' },
    currency: { type: DataTypes.CHAR(3), allowNull: true },
    currentPeriodStart: { type: DataTypes.DATE, allowNull: true, field: 'current_period_start' },
    currentPeriodEnd: { type: DataTypes.DATE, allowNull: true, field: 'current_period_end' },
    cancelAtPeriodEnd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'cancel_at_period_end' },
    canceledAt: { type: DataTypes.DATE, allowNull: true, field: 'canceled_at' },
    endedAt: { type: DataTypes.DATE, allowNull: true, field: 'ended_at' },
    pendingUpdate: { type: DataTypes.JSON, allowNull: true, field: 'pending_update' },
    graceUntil: { type: DataTypes.DATE, allowNull: true, field: 'grace_until' },
    purchasedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'purchased_by_user_id' },
    eventWatermark: { type: DataTypes.BIGINT, allowNull: true, field: 'event_watermark' },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_synced_at' },
    planChangeVersion: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'plan_change_version' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_subscriptions', paranoid: false },
);

export default BillingSubscription;
