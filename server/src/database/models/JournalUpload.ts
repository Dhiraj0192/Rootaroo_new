import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

/**
 * One encrypted blob the phone uploaded for a journal entry. It counts toward
 * the user's journal quota from the moment it is stored; `attachedAt` is set
 * when an entry claims it, and the daily cleanup deletes uploads that nobody
 * claimed within 24 hours.
 */
class JournalUpload extends Model {
  /** Storage key, `journal/blobs/<userId>/<uuid>`. */
  declare key: string;
  declare userId: string;
  declare sizeBytes: number;
  declare createdAt: CreationOptional<Date>;
  declare attachedAt: Date | null;
}

JournalUpload.init(
  {
    key: { type: DataTypes.STRING(500), primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    sizeBytes: { type: DataTypes.BIGINT, allowNull: false, field: 'size_bytes' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    attachedAt: { type: DataTypes.DATE, allowNull: true, field: 'attached_at' },
  },
  {
    sequelize,
    tableName: 'journal_uploads',
    timestamps: true,
    updatedAt: false,
    paranoid: false,
  },
);

export default JournalUpload;
