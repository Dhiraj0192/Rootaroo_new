import { Model, DataTypes, CreationOptional } from 'sequelize';
import sequelize from '../../config/database';

/** One campaign push that went out; drives the weekly cap and the no-repeat rules. */
class CampaignSend extends Model {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare rule: string;
  declare line: string;
  declare sentAt: Date;
}

CampaignSend.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    rule: { type: DataTypes.STRING(40), allowNull: false },
    line: { type: DataTypes.STRING(255), allowNull: false },
    sentAt: { type: DataTypes.DATE, allowNull: false, field: 'sent_at' },
  },
  {
    sequelize,
    tableName: 'campaign_sends',
    timestamps: false,
    paranoid: false,
    indexes: [{ name: 'idx_campaign_sends_user_sent', fields: ['user_id', 'sent_at'] }],
  }
);

export default CampaignSend;
