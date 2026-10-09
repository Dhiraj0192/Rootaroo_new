import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class KeyTransferSession extends Model {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare newDeviceId: string;
  declare newEphemeralPublicKey: string;
  declare oldEphemeralPublicKey: string | null;
  /** Sealed account key; only the new phone can open it. Cleared once the session is done. */
  declare payload: string | null;
  declare status: 'open' | 'sent' | 'done' | 'expired';
  declare expiresAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyTransferSession.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    newDeviceId: { type: DataTypes.UUID, allowNull: false, field: 'new_device_id' },
    newEphemeralPublicKey: { type: DataTypes.STRING(64), allowNull: false, field: 'new_ephemeral_public_key' },
    oldEphemeralPublicKey: { type: DataTypes.STRING(64), allowNull: true, field: 'old_ephemeral_public_key' },
    payload: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM('open', 'sent', 'done', 'expired'), allowNull: false, defaultValue: 'open' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    sequelize,
    tableName: 'key_transfer_sessions',
    paranoid: false,
    indexes: [
      { name: 'idx_key_transfer_user_status', fields: ['user_id', 'status'] },
      { name: 'idx_key_transfer_expires_at', fields: ['expires_at'] },
    ],
  },
);

export default KeyTransferSession;
