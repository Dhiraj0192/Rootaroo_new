import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';
import type { ClientPlatform, PurchaseMethod } from '../../modules/billing/types';

class BillingRoutingRule extends Model {
  declare id: CreationOptional<string>;
  declare platform: ClientPlatform;
  declare country: string;
  declare method: PurchaseMethod;
  declare updatedBy: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingRoutingRule.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    platform: { type: DataTypes.ENUM('ios', 'android', 'web'), allowNull: false },
    country: { type: DataTypes.STRING(2), allowNull: false },
    method: { type: DataTypes.ENUM('stripe_checkout', 'apple_iap', 'google_play', 'none'), allowNull: false },
    updatedBy: { type: DataTypes.STRING(100), allowNull: false, field: 'updated_by' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_routing_rules', paranoid: false },
);

export default BillingRoutingRule;
