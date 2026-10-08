'use strict';

const { createTableIfMissing, addIndexIfMissing, addColumnIfMissing } = require('../migrationHelpers');

/** Push campaigns: a log of what was sent (cap + no-repeat) and the "Tips and nudges" opt-out. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfMissing(queryInterface, 'campaign_sends', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      user_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
      },
      rule: { type: Sequelize.STRING(40), allowNull: false },
      line: { type: Sequelize.STRING(255), allowNull: false },
      sent_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndexIfMissing(queryInterface, 'campaign_sends', ['user_id', 'sent_at'], { name: 'idx_campaign_sends_user_sent' });
    await addColumnIfMissing(queryInterface, 'notification_preferences', 'tips', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('notification_preferences', 'tips');
    await queryInterface.dropTable('campaign_sends');
  },
};
