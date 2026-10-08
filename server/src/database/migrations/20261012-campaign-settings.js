'use strict';

const { createTableIfMissing } = require('../migrationHelpers');

/** Admin on/off switches for push campaigns. No seed rows: a missing row means off. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfMissing(queryInterface, 'campaign_settings', {
      key: { type: Sequelize.STRING(64), primaryKey: true },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      updated_by: { type: Sequelize.STRING(64), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('campaign_settings');
  },
};
