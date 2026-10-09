import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class Device extends Model {
  declare id: CreationOptional<string>;
  declare userId: string;
  /** Client-generated UUID the app keeps on the phone; never sent back out. */
  declare deviceKey: string;
  declare name: string;
  declare platform: 'ios' | 'android' | 'web' | null;
  declare appVersion: string | null;
  declare lastSeenAt: Date;
  declare revokedAt: Date | null;
  /** At most one device per user is true: the phone holding the account private key. */
  declare holdsAccountKey: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Device.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    deviceKey: { type: DataTypes.STRING(64), allowNull: false, field: 'device_key' },
    name: { type: DataTypes.STRING(100), allowNull: false },
    platform: { type: DataTypes.ENUM('ios', 'android', 'web'), allowNull: true },
    appVersion: { type: DataTypes.STRING(32), allowNull: true, field: 'app_version' },
    lastSeenAt: { type: DataTypes.DATE, allowNull: false, field: 'last_seen_at' },
    revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
    holdsAccountKey: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'holds_account_key' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    sequelize,
    tableName: 'devices',
    // Removal is revokedAt, not a soft delete; the table has no deleted_at.
    paranoid: false,
    indexes: [
      { name: 'uq_devices_user_device_key', fields: ['user_id', 'device_key'], unique: true },
      { name: 'idx_devices_user_id', fields: ['user_id'] },
    ],
  }
);

export default Device;
