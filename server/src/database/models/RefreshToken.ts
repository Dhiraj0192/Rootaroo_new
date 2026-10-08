import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';
import type User from './User';

class RefreshToken extends Model {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare token: string;
  declare deviceId: string | null;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare user?: User;
}

RefreshToken.init(
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
    token: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    deviceId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'device_id',
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'expires_at',
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'revoked_at',
    },
    createdAt: {
      type: DataTypes.DATE,
      field: 'created_at',
    },
  },
  {
    sequelize,
    tableName: 'refresh_tokens',
    timestamps: true,
    paranoid: false,
    indexes: [
      { fields: ['token'] },
      { name: 'idx_refresh_user_created', fields: ['user_id', 'created_at'] },
    ],
  }
);

export default RefreshToken;
