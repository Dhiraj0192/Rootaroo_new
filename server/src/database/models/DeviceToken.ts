import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class DeviceToken extends Model {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare token: string;
  declare deviceId: string | null;
  declare platform: 'ios' | 'android' | 'web';
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

DeviceToken.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'user_id',
    },
    // VARCHAR, not TEXT — real device push tokens (FCM/Expo) are well
    // under this length, and the unique index below requires an
    // indexable column type (MySQL rejects a key on TEXT/BLOB without an
    // explicit prefix length).
    token: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    deviceId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'device_id',
    },
    platform: {
      type: DataTypes.ENUM('ios', 'android', 'web'),
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      field: 'created_at',
    },
    updatedAt: {
      type: DataTypes.DATE,
      field: 'updated_at',
    },
  },
  {
    sequelize,
    tableName: 'device_tokens',
    indexes: [
      { name: 'idx_device_tokens_user_id', fields: ['user_id'] },
      { name: 'idx_device_tokens_token', fields: ['token'], unique: true },
    ],
  }
);

export default DeviceToken;