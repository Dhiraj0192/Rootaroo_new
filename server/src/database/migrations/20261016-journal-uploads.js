'use strict';

const { createTableIfMissing, addIndexIfMissing } = require('../migrationHelpers');

/**
 * Tracks every encrypted journal blob a phone uploads, so each user has a storage quota and
 * uploads that never became part of an entry can be deleted after 24 hours.
 * Blobs uploaded before this migration are not listed: they count toward neither the quota
 * nor the cleanup.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfMissing(queryInterface, 'journal_uploads', {
      key: { type: Sequelize.STRING(500), primaryKey: true },
      user_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
      },
      size_bytes: { type: Sequelize.BIGINT, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      attached_at: { type: Sequelize.DATE, allowNull: true },
    });
    await addIndexIfMissing(queryInterface, 'journal_uploads', ['user_id'], { name: 'idx_journal_uploads_user' });
    await addIndexIfMissing(queryInterface, 'journal_uploads', ['attached_at', 'created_at'], { name: 'idx_journal_uploads_unattached' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('journal_uploads');
  },
};
