import { Model, DataTypes } from 'sequelize';
import sequelize from '../../config/database';

/** An admin on/off switch for push campaigns. No row means off. */
class CampaignSetting extends Model {
  declare key: string;
  declare enabled: boolean;
  declare updatedBy: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

CampaignSetting.init(
  {
    key: { type: DataTypes.STRING(64), primaryKey: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    updatedBy: { type: DataTypes.STRING(64), allowNull: true, field: 'updated_by' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    sequelize,
    tableName: 'campaign_settings',
    timestamps: true,
    paranoid: false,
  }
);

export default CampaignSetting;
