import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

export type LedgerType = 'payment' | 'failed_payment' | 'refund' | 'dispute';
export type FundsState = 'none' | 'withdrawn' | 'reinstated';

class BillingTransaction extends Model {
  declare id: CreationOptional<string>;
  declare provider: 'stripe' | 'apple' | 'google';
  declare livemode: boolean;
  declare type: LedgerType;
  declare status: string;
  declare billingReason: string | null;
  declare amount: number;
  declare fee: number | null;
  declare net: number | null;
  declare disputeFee: number | null;
  declare fundsState: FundsState | null;
  declare currency: string;
  declare householdId: string | null;
  declare userId: string | null;
  declare subscriptionId: string | null;
  declare matchStatus: 'matched' | 'unmatched';
  declare householdNameSnapshot: string | null;
  declare payerEmailSnapshot: string | null;
  declare providerObjectId: string;
  declare providerInvoiceId: string | null;
  declare providerChargeId: string | null;
  declare receiptUrl: string | null;
  declare description: string | null;
  declare occurredAt: Date;
  declare lastEventId: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingTransaction.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    provider: { type: DataTypes.ENUM('stripe', 'apple', 'google'), allowNull: false },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    type: { type: DataTypes.ENUM('payment', 'failed_payment', 'refund', 'dispute'), allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false },
    billingReason: { type: DataTypes.STRING(40), allowNull: true, field: 'billing_reason' },
    amount: { type: DataTypes.INTEGER, allowNull: false },
    fee: { type: DataTypes.INTEGER, allowNull: true },
    net: { type: DataTypes.INTEGER, allowNull: true },
    disputeFee: { type: DataTypes.INTEGER, allowNull: true, field: 'dispute_fee' },
    fundsState: { type: DataTypes.ENUM('none', 'withdrawn', 'reinstated'), allowNull: true, field: 'funds_state' },
    currency: { type: DataTypes.CHAR(3), allowNull: false },
    householdId: { type: DataTypes.UUID, allowNull: true, field: 'household_id' },
    userId: { type: DataTypes.UUID, allowNull: true, field: 'user_id' },
    subscriptionId: { type: DataTypes.UUID, allowNull: true, field: 'subscription_id' },
    matchStatus: { type: DataTypes.ENUM('matched', 'unmatched'), allowNull: false, field: 'match_status' },
    householdNameSnapshot: { type: DataTypes.STRING(100), allowNull: true, field: 'household_name_snapshot' },
    payerEmailSnapshot: { type: DataTypes.STRING(255), allowNull: true, field: 'payer_email_snapshot' },
    providerObjectId: { type: DataTypes.STRING(255), allowNull: false, field: 'provider_object_id' },
    providerInvoiceId: { type: DataTypes.STRING(255), allowNull: true, field: 'provider_invoice_id' },
    providerChargeId: { type: DataTypes.STRING(255), allowNull: true, field: 'provider_charge_id' },
    receiptUrl: { type: DataTypes.TEXT, allowNull: true, field: 'receipt_url' },
    description: { type: DataTypes.STRING(500), allowNull: true },
    occurredAt: { type: DataTypes.DATE, allowNull: false, field: 'occurred_at' },
    lastEventId: { type: DataTypes.STRING(255), allowNull: true, field: 'last_event_id' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_transactions', paranoid: false },
);

export default BillingTransaction;
