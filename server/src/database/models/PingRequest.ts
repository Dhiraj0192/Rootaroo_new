import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

export type PingRequestStatus = 'pending' | 'fulfilled' | 'declined' | 'expired';

class PingRequest extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare requesterId: string;
  declare targetUserId: string;
  declare status: PingRequestStatus;
  declare note: string | null;
  declare checkInId: string | null;
  declare respondedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

PingRequest.init(
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
    requesterId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'requester_id',
    },
    targetUserId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'target_user_id',
    },
    status: {
      type: DataTypes.ENUM('pending', 'fulfilled', 'declined', 'expired'),
      allowNull: false,
      defaultValue: 'pending',
    },
    note: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    checkInId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'check_in_id',
    },
    respondedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'responded_at',
    },
    createdAt: {
      type: DataTypes.DATE,
      field: 'created_at',
    },
  },
  {
    sequelize,
    tableName: 'ping_requests',
    timestamps: true,
    updatedAt: false,
    paranoid: false,
  }
);

export default PingRequest;
