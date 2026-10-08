import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';
import type { BillingInterval } from '../../modules/billing/types';

export type CheckoutRowStatus = 'creating' | 'open' | 'complete' | 'expired' | 'failed';

class BillingCheckoutSession extends Model {
  declare id: string;
  declare householdId: string;
  declare livemode: boolean;
  declare providerSessionId: string | null;
  declare createdByUserId: string;
  declare interval: BillingInterval;
  declare seats: number;
  declare status: CreationOptional<CheckoutRowStatus>;
  declare url: string | null;
  declare expiresAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingCheckoutSession.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    householdId: { type: DataTypes.UUID, allowNull: false, field: 'household_id' },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    providerSessionId: { type: DataTypes.STRING(255), allowNull: true, unique: true, field: 'provider_session_id' },
    createdByUserId: { type: DataTypes.UUID, allowNull: false, field: 'created_by_user_id' },
    interval: { type: DataTypes.ENUM('month', 'year'), allowNull: false },
    seats: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    status: { type: DataTypes.ENUM('creating', 'open', 'complete', 'expired', 'failed'), allowNull: false, defaultValue: 'creating' },
    url: { type: DataTypes.TEXT, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_checkout_sessions', paranoid: false },
);

export default BillingCheckoutSession;
