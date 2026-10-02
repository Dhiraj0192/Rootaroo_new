import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class BillingCustomer extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare provider: 'stripe' | 'apple' | 'google';
  declare livemode: boolean;
  declare providerCustomerId: string;
  declare billingEmail: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingCustomer.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    householdId: { type: DataTypes.UUID, allowNull: false, field: 'household_id' },
    provider: { type: DataTypes.ENUM('stripe', 'apple', 'google'), allowNull: false },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    providerCustomerId: { type: DataTypes.STRING(255), allowNull: false, field: 'provider_customer_id' },
    billingEmail: { type: DataTypes.STRING(255), allowNull: true, field: 'billing_email' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_customers', paranoid: false },
);

export default BillingCustomer;
