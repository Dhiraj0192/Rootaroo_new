import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class BillingReconciliationRun extends Model {
  declare id: CreationOptional<string>;
  declare livemode: boolean;
  declare kind: 'daily' | 'weekly' | 'manual';
  declare startedAt: Date;
  declare finishedAt: Date | null;
  declare status: CreationOptional<'running' | 'succeeded' | 'failed'>;
  declare counts: Record<string, number> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingReconciliationRun.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    kind: { type: DataTypes.ENUM('daily', 'weekly', 'manual'), allowNull: false },
    startedAt: { type: DataTypes.DATE, allowNull: false, field: 'started_at' },
    finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
    status: { type: DataTypes.ENUM('running', 'succeeded', 'failed'), allowNull: false, defaultValue: 'running' },
    counts: { type: DataTypes.JSON, allowNull: true },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_reconciliation_runs', paranoid: false },
);

export default BillingReconciliationRun;
