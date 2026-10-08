import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class NotificationPreference extends Model {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare newPost: boolean;
  declare taskAssigned: boolean;
  declare taskCompleted: boolean;
  declare checkIn: boolean;
  declare pingRequest: boolean;
  declare newExpense: boolean;
  declare chatMessage: boolean;
  declare calendarEvent: boolean;
  declare memberJoined: boolean;
  declare tips: boolean;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

NotificationPreference.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      field: 'user_id',
    },
    newPost: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'new_post',
    },
    taskAssigned: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'task_assigned',
    },
    taskCompleted: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'task_completed',
    },
    checkIn: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'check_in',
    },
    pingRequest: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'ping_request',
    },
    newExpense: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'new_expense',
    },
    chatMessage: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'chat_message',
    },
    calendarEvent: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'calendar_event',
    },
    memberJoined: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'member_joined',
    },
    tips: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      field: 'tips',
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
    tableName: 'notification_preferences',
    timestamps: true,
    paranoid: false,
  }
);

export default NotificationPreference;
