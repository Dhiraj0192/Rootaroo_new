import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class JournalMedia extends Model {
  declare id: CreationOptional<string>;
  declare entryId: string;
  /** S3 key of the encrypted photo. */
  declare blobKey: string;
  /** S3 key of the encrypted thumbnail. */
  declare thumbnailKey: string | null;
  declare sizeBytes: number | null;
  declare createdAt: CreationOptional<Date>;
}

JournalMedia.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    entryId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'entry_id',
    },
    blobKey: {
      type: DataTypes.STRING(500),
      allowNull: false,
      field: 'blob_key',
    },
    thumbnailKey: {
      type: DataTypes.STRING(500),
      allowNull: true,
      field: 'thumbnail_key',
    },
    sizeBytes: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'file_size_bytes',
    },
    createdAt: {
      type: DataTypes.DATE,
      field: 'created_at',
    },
  },
  {
    sequelize,
    tableName: 'journal_media',
    timestamps: true,
    paranoid: false,
  }
);

export default JournalMedia;
