import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

class AdminAuditLog extends Model {
  declare id: CreationOptional<string>;
  declare surface: 'admin' | 'billing-admin';
  declare keyLabel: string;
  declare method: string;
  declare path: string;
  declare query: unknown;
  declare bodyDigest: string | null;
  declare statusCode: number;
  declare ip: string | null;
  declare createdAt: CreationOptional<Date>;
}

AdminAuditLog.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    surface: { type: DataTypes.ENUM('admin', 'billing-admin'), allowNull: false },
    keyLabel: { type: DataTypes.STRING(64), allowNull: false, field: 'key_label' },
    method: { type: DataTypes.STRING(10), allowNull: false },
    path: { type: DataTypes.STRING(500), allowNull: false },
    query: { type: DataTypes.JSON, allowNull: true },
    bodyDigest: { type: DataTypes.CHAR(64), allowNull: true, field: 'body_digest' },
    statusCode: { type: DataTypes.INTEGER, allowNull: false, field: 'status_code' },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
  },
  { sequelize, tableName: 'admin_audit_log', paranoid: false, updatedAt: false },
);

export default AdminAuditLog;
