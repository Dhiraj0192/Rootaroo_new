'use strict';

const { addColumnIfMissing, addIndexIfMissing } = require('../migrationHelpers');

/**
 * Outlook Calendar sync switched from Microsoft Graph OAuth (needs an Azure
 * app registration the client couldn't complete) to a one-way ICS
 * subscription feed — no OAuth, no Azure app. Each connected user gets a
 * random opaque token that's part of the public, unauthenticated feed URL
 * Outlook polls on its own schedule.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'calendar_sync_states', 'outlook_feed_token', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await addIndexIfMissing(queryInterface, 'calendar_sync_states', ['outlook_feed_token'], {
      unique: true,
      name: 'calendar_sync_states_outlook_feed_token_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('calendar_sync_states', 'calendar_sync_states_outlook_feed_token_unique');
    await queryInterface.removeColumn('calendar_sync_states', 'outlook_feed_token');
  },
};
