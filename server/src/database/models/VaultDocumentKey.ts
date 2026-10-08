import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

/**
 * VaultDocumentKey: one sealed copy of a file's key per person who can open it.
 * Each copy is sealed on a phone to that person's account public key; the server
 * only stores and hands back the sealed bytes. No row means no access (a household
 * file with no row for an adult is "pending" for them).
 */
class VaultDocumentKey extends Model {
  declare documentId: string;
  declare userId: string;
  declare wrappedKey: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

VaultDocumentKey.init(
  {
    documentId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      field: 'document_id',
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      field: 'user_id',
    },
    wrappedKey: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'wrapped_key',
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
    tableName: 'vault_document_keys',
    timestamps: true,
    paranoid: false,
  }
);

export default VaultDocumentKey;
