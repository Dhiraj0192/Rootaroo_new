import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

/** One row per user: the emailed code, then (once it is entered) the restore token, both stored hashed. */
class KeyRestoreCode extends Model {
  declare id: CreationOptional<string>;
  declare userId: string;
  /** The phone that asked for the code; the token only works from it. */
  declare deviceId: string;
  /** Null once the code has been spent. */
  declare codeHash: string | null;
  declare expiresAt: Date;
  declare attemptsLeft: number;
  declare restoreTokenHash: string | null;
  declare restoreTokenExpiresAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyRestoreCode.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
    codeHash: { type: DataTypes.STRING(64), allowNull: true, field: 'code_hash' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    attemptsLeft: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5, field: 'attempts_left' },
    restoreTokenHash: { type: DataTypes.STRING(64), allowNull: true, field: 'restore_token_hash' },
    restoreTokenExpiresAt: { type: DataTypes.DATE, allowNull: true, field: 'restore_token_expires_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    sequelize,
    tableName: 'key_restore_codes',
    paranoid: false,
    indexes: [
      { name: 'idx_key_restore_codes_user_id', fields: ['user_id'] },
      { name: 'idx_key_restore_codes_expires_at', fields: ['expires_at'] },
    ],
  },
);

export default KeyRestoreCode;
