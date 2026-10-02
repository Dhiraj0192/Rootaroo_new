import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

export type ReviewResolution = 'auto_fixed' | 'needs_review' | 'resolved' | 'ignored';

class BillingReconciliationItem extends Model {
  declare id: CreationOptional<string>;
  declare runId: string | null;
  declare livemode: boolean;
  declare kind: string;
  declare entityType: string;
  declare entityId: string | null;
  declare providerObjectId: string | null;
  declare before: unknown;
  declare after: unknown;
  declare resolution: ReviewResolution;
  declare resolvedBy: string | null;
  declare resolutionNote: string | null;
  declare resolvedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BillingReconciliationItem.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    runId: { type: DataTypes.UUID, allowNull: true, field: 'run_id' },
    livemode: { type: DataTypes.BOOLEAN, allowNull: false },
    kind: { type: DataTypes.STRING(64), allowNull: false },
    entityType: { type: DataTypes.STRING(32), allowNull: false, field: 'entity_type' },
    entityId: { type: DataTypes.STRING(64), allowNull: true, field: 'entity_id' },
    providerObjectId: { type: DataTypes.STRING(255), allowNull: true, field: 'provider_object_id' },
    before: { type: DataTypes.JSON, allowNull: true },
    after: { type: DataTypes.JSON, allowNull: true },
    resolution: { type: DataTypes.ENUM('auto_fixed', 'needs_review', 'resolved', 'ignored'), allowNull: false },
    resolvedBy: { type: DataTypes.STRING(100), allowNull: true, field: 'resolved_by' },
    resolutionNote: { type: DataTypes.STRING(1000), allowNull: true, field: 'resolution_note' },
    resolvedAt: { type: DataTypes.DATE, allowNull: true, field: 'resolved_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  { sequelize, tableName: 'billing_reconciliation_items', paranoid: false },
);

export default BillingReconciliationItem;
