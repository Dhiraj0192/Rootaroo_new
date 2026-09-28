'use strict';

const { addColumnIfMissing, addIndexIfMissing } = require('../migrationHelpers');

/**
 * The conversations list computes each conversation's unread count with one
 * grouped query filtering chat_messages by conversation_id AND created_at
 * (newer than the reader's last_read_at). chat_messages only had the
 * implicit conversation_id foreign-key index, so every count scanned the
 * conversation's entire history to apply the date filter. Purely additive;
 * doesn't change any query results.
 */
module.exports = {
  async up(queryInterface) {
    await addIndexIfMissing(queryInterface, 'chat_messages', ['conversation_id', 'created_at'], {
      name: 'idx_chat_messages_conversation_created',
    });
  },

  async down(queryInterface) {
    // MySQL may drop the implicit FK index on conversation_id once this
    // composite index covers it; recreate a plain one first so the foreign
    // key still has an index and the removal below is allowed.
    await queryInterface.addIndex('chat_messages', ['conversation_id'], {
      name: 'idx_chat_messages_conversation',
    });
    await queryInterface.removeIndex('chat_messages', 'idx_chat_messages_conversation_created');
  },
};
