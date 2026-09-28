'use strict';

const { addColumnIfMissing, addIndexIfMissing } = require('../migrationHelpers');

/**
 * Backs the chat unread-message indicator — null means "never read", so an
 * existing participant's whole message history counts as unread until they
 * next open the conversation.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'conversation_participants', 'last_read_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('conversation_participants', 'last_read_at');
  },
};
