import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class TodoItem extends Model {
  declare id: CreationOptional<string>;
  declare householdId: string;
  declare title: string;
  declare dueDate: Date | null;
  declare dueTime: string | null;
  declare assignedTo: string | null;
  declare isCompleted: boolean;
  declare completedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

TodoItem.init(
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
    title: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    dueDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'due_date',
    },
    dueTime: {
      type: DataTypes.TIME,
      allowNull: true,
      field: 'due_time',
    },
    assignedTo: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'assigned_to',
    },
    isCompleted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      field: 'is_completed',
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'completed_at',
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
    tableName: 'todo_items',
    paranoid: true,
  }
);

export default TodoItem;
