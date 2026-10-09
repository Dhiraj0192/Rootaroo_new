import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';
import type { CalendarProvider } from './CalendarSyncState';

class CalendarEvent extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare createdBy: string;
  declare title: string;
  declare description: string | null;
  declare eventDate: Date;
  declare startTime: string | null;
  declare endTime: string | null;
  declare isRecurring: boolean;
  declare recurrenceRule: string | null;
  declare googleEventId: string | null;
  declare externalProvider: CalendarProvider | null;
  declare externalEventId: string | null;
  declare reminderSentAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

CalendarEvent.init(
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
    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'created_by',
    },
    title: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    eventDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      field: 'event_date',
    },
    startTime: {
      type: DataTypes.TIME,
      allowNull: true,
      field: 'start_time',
    },
    endTime: {
      type: DataTypes.TIME,
      allowNull: true,
      field: 'end_time',
    },
    isRecurring: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      field: 'is_recurring',
    },
    recurrenceRule: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'recurrence_rule',
    },
    googleEventId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'google_event_id',
    },
    externalProvider: {
      type: DataTypes.ENUM('google', 'outlook', 'apple'),
      allowNull: true,
      field: 'external_provider',
    },
    externalEventId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'external_event_id',
    },
    reminderSentAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'reminder_sent_at',
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
    tableName: 'calendar_events',
    paranoid: true,
    indexes: [
      { name: 'idx_calendar_household_date', fields: ['household_id', 'event_date'] },
      { name: 'idx_calendar_events_external', fields: ['external_provider', 'external_event_id'] },
    ],
  }
);

export default CalendarEvent;
