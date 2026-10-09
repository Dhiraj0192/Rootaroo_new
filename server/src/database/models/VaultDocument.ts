import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class VaultDocument extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare uploadedBy: string;
  /** Base64 of the file name and type, sealed on the phone. The server cannot read it. */
  declare sealedMeta: string;
  declare scope: CreationOptional<'personal' | 'household'>;
  declare sizeBytes: number;
  declare s3Key: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

VaultDocument.init(
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
    uploadedBy: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'uploaded_by',
    },
    sealedMeta: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'sealed_meta',
    },
    scope: {
      type: DataTypes.ENUM('personal', 'household'),
      allowNull: false,
      defaultValue: 'personal',
    },
    sizeBytes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'size_bytes',
    },
    s3Key: {
      type: DataTypes.STRING(500),
      allowNull: false,
      field: 's3_key',
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
    tableName: 'vault_documents',
    timestamps: true,
    paranoid: false, // Hard delete per FR-130
  }
);

export default VaultDocument;