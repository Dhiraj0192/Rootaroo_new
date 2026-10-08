'use strict';

const { addColumnIfMissing } = require('../migrationHelpers');

/**
 * W11: the journal stores only ciphertext (docs/e2e/journal.md).
 *
 * Decision D1 (docs/TRACKER.md): pre-launch journal data is test data, so every entry and
 * attachment row is deleted here rather than converted (the server cannot encrypt it for
 * the phone). S3 objects under journal/ are not touched by a migration; clear them by hand.
 * Written to be safe to re-run after a partial failure: each step checks before it acts.
 */
const has = async (queryInterface, table, column) => Boolean((await queryInterface.describeTable(table))[column]);

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('DELETE FROM journal_media');
    await queryInterface.sequelize.query('DELETE FROM journal_entries');

    for (const column of ['content', 'mood', 'tags']) {
      if (await has(queryInterface, 'journal_entries', column)) await queryInterface.removeColumn('journal_entries', column);
    }
    await addColumnIfMissing(queryInterface, 'journal_entries', 'ciphertext', { type: Sequelize.TEXT('medium'), allowNull: false });
    await addColumnIfMissing(queryInterface, 'journal_entries', 'sealed_key', { type: Sequelize.TEXT, allowNull: false });
    await addColumnIfMissing(queryInterface, 'journal_entries', 'format', {
      type: Sequelize.TINYINT, allowNull: false, defaultValue: 1,
    });

    if (await has(queryInterface, 'journal_media', 'media_url')) {
      await queryInterface.renameColumn('journal_media', 'media_url', 'blob_key');
    }
    if (await has(queryInterface, 'journal_media', 'thumbnail_url')) {
      await queryInterface.renameColumn('journal_media', 'thumbnail_url', 'thumbnail_key');
    }
    if (await has(queryInterface, 'journal_media', 'media_type')) {
      await queryInterface.removeColumn('journal_media', 'media_type');
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('DELETE FROM journal_media');
    await queryInterface.sequelize.query('DELETE FROM journal_entries');

    for (const column of ['ciphertext', 'sealed_key', 'format']) {
      if (await has(queryInterface, 'journal_entries', column)) await queryInterface.removeColumn('journal_entries', column);
    }
    await addColumnIfMissing(queryInterface, 'journal_entries', 'content', { type: Sequelize.TEXT, allowNull: true });
    await addColumnIfMissing(queryInterface, 'journal_entries', 'mood', { type: Sequelize.STRING(16), allowNull: true });
    await addColumnIfMissing(queryInterface, 'journal_entries', 'tags', { type: Sequelize.JSON, allowNull: true });

    if (await has(queryInterface, 'journal_media', 'blob_key')) {
      await queryInterface.renameColumn('journal_media', 'blob_key', 'media_url');
    }
    if (await has(queryInterface, 'journal_media', 'thumbnail_key')) {
      await queryInterface.renameColumn('journal_media', 'thumbnail_key', 'thumbnail_url');
    }
    await addColumnIfMissing(queryInterface, 'journal_media', 'media_type', {
      type: Sequelize.ENUM('photo', 'video'), allowNull: false, defaultValue: 'photo',
    });
  },
};
