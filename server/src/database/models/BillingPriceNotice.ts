import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class BillingPriceNotice extends Model {
  declare id: CreationOptional<string>;
  declare subscriptionId: string;
  declare fromPriceId: string;
  declare toPriceSet: string;
  declare noticeSentAt: Date;
  declare applyAfter: Date;
  declare appliedAt: Date | null;
  declare status: CreationOptional<'scheduled' | 'applied' | 'skipped' | 'failed'>;
  declare reason: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingPriceNotice.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    subscriptionId: { type: DataTypes.UUID, allowNull: false, field: 'subscription_id' },
    fromPriceId: { type: DataTypes.STRING(255), allowNull: false, field: 'from_price_id' },
    toPriceSet: { type: DataTypes.STRING(32), allowNull: false, field: 'to_price_set' },
    noticeSentAt: { type: DataTypes.DATE, allowNull: false, field: 'notice_sent_at' },
    applyAfter: { type: DataTypes.DATE, allowNull: false, field: 'apply_after' },
    appliedAt: { type: DataTypes.DATE, allowNull: true, field: 'applied_at' },
    status: { type: DataTypes.ENUM('scheduled', 'applied', 'skipped', 'failed'), allowNull: false, defaultValue: 'scheduled' },
    reason: { type: DataTypes.STRING(500), allowNull: true },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_price_notices', paranoid: false },
);

export default BillingPriceNotice;
