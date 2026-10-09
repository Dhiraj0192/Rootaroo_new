'use strict';

const { addColumnIfMissing } = require('../migrationHelpers');

/** Set when the "starting soon" push is claimed, so overlapping cron runs send it once. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'calendar_events', 'reminder_sent_at', {
      type: Sequelize.DATE, allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('calendar_events', 'reminder_sent_at');
  },
};
