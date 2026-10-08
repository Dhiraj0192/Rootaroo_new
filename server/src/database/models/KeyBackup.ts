import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

export interface KdfParams {
  algorithm: 'argon2id';
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  length: number;
}

/** Password-protected copy of the account key. verifier and storedBlob are the key vault's output, never what the phone sent. */
class KeyBackup extends Model {
  declare userId: string;
  declare kind: 'password' | 'recovery_code';
  declare salt: string;
  declare kdf: KdfParams;
  declare verifier: string;
  declare storedBlob: string;
  declare attemptsLeft: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyBackup.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true, field: 'user_id' },
    kind: { type: DataTypes.ENUM('password', 'recovery_code'), allowNull: false },
    salt: { type: DataTypes.STRING(64), allowNull: false },
    kdf: { type: DataTypes.JSON, allowNull: false },
    verifier: { type: DataTypes.STRING(255), allowNull: false },
    storedBlob: { type: DataTypes.TEXT, allowNull: false, field: 'stored_blob' },
    attemptsLeft: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10, field: 'attempts_left' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'key_backups', paranoid: false },
);

export default KeyBackup;
