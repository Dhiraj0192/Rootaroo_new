import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

/** The user's public X25519 key. The private half exists only on the phone that holds it. */
class AccountKey extends Model {
  declare userId: string;
  /** Base64 of the raw 32-byte key. */
  declare publicKey: string;
  declare keyVersion: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

AccountKey.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true, field: 'user_id' },
    publicKey: { type: DataTypes.STRING(64), allowNull: false, field: 'public_key' },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'key_version' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'account_keys', paranoid: false },
);

export default AccountKey;
