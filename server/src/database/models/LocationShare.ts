import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class LocationShare extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare sharerId: string;
  /** null = everyone else in the household. */
  declare viewerIds: string[] | null;
  declare pingRequestId: string | null;
  declare startedAt: Date;
  declare expiresAt: Date;
  declare endedAt: Date | null;
  // MySQL returns DECIMAL as a string; the service converts. Null once the share has ended.
  declare latitude: number | string | null;
  declare longitude: number | string | null;
  declare accuracy: number | null;
  declare locationUpdatedAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

LocationShare.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    householdId: { type: DataTypes.UUID, allowNull: false, field: 'household_id' },
    sharerId: { type: DataTypes.UUID, allowNull: false, field: 'sharer_id' },
    viewerIds: { type: DataTypes.JSON, allowNull: true, field: 'viewer_ids' },
    pingRequestId: { type: DataTypes.UUID, allowNull: true, field: 'ping_request_id' },
    startedAt: { type: DataTypes.DATE, allowNull: false, field: 'started_at' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    endedAt: { type: DataTypes.DATE, allowNull: true, field: 'ended_at' },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    accuracy: { type: DataTypes.FLOAT, allowNull: true },
    locationUpdatedAt: { type: DataTypes.DATE, allowNull: false, field: 'location_updated_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    sequelize,
    tableName: 'location_shares',
    // Ending a share is endedAt; the table has no deleted_at.
    paranoid: false,
    indexes: [
      { name: 'idx_location_shares_household_ended', fields: ['household_id', 'ended_at'] },
      { name: 'idx_location_shares_sharer_ended', fields: ['sharer_id', 'ended_at'] },
      { name: 'idx_location_shares_expires_at', fields: ['expires_at'] },
    ],
  }
);

export default LocationShare;
