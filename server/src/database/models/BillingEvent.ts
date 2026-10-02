import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

export type BillingEventStatus = 'received' | 'processing' | 'processed' | 'failed' | 'ignored' | 'dead';

class BillingEvent extends Model {
  declare id: CreationOptional<string>;
  declare provider: 'stripe' | 'apple' | 'google';
  declare livemode: boolean;
  declare providerEventId: string;
  declare type: string;
  declare payload: Record<string, unknown>;
  declare status: CreationOptional<BillingEventStatus>;
  declare attempts: CreationOptional<number>;
  declare lockedAt: Date | null;
  declare lastError: string | null;
  declare receivedAt: Date;
  declare processedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingEvent.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    provider: { type: DataTypes.ENUM('stripe', 'apple', 'google'), allowNull: false },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    providerEventId: { type: DataTypes.STRING(255), allowNull: false, unique: true, field: 'provider_event_id' },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.ENUM('received', 'processing', 'processed', 'failed', 'ignored', 'dead'), allowNull: false, defaultValue: 'received' },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lockedAt: { type: DataTypes.DATE, allowNull: true, field: 'locked_at' },
    lastError: { type: DataTypes.TEXT, allowNull: true, field: 'last_error' },
    receivedAt: { type: DataTypes.DATE, allowNull: false, field: 'received_at' },
    processedAt: { type: DataTypes.DATE, allowNull: true, field: 'processed_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_events', paranoid: false },
);

export default BillingEvent;
