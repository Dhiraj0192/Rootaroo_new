import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class JournalEntry extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare userId: string;
  /** Base64 ciphertext; the server never sees the text, mood, tags or photos inside. */
  declare ciphertext: string;
  /** Base64 per-entry key, sealed to the author's account key. */
  declare sealedKey: string;
  declare format: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

JournalEntry.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    householdId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'household_id',
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'user_id',
    },
    ciphertext: {
      type: DataTypes.TEXT('medium'),
      allowNull: false,
    },
    sealedKey: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'sealed_key',
    },
    format: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
    createdAt: {
      type: DataTypes.DATE,
      field: 'created_at',
    },
    updatedAt: {
      type: DataTypes.DATE,
      field: 'updated_at',
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'deleted_at',
    },
  },
  {
    sequelize,
    tableName: 'journal_entries',
    paranoid: true,
    indexes: [
      { name: 'idx_journal_entries_user_created', fields: ['user_id', 'created_at'] },
    ],
  }
);

export default JournalEntry;
