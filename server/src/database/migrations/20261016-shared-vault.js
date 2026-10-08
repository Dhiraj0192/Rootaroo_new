'use strict';

const { addColumnIfMissing, addIndexIfMissing, createTableIfMissing } = require('../migrationHelpers');

/**
 * W12: the household vault is shared per file (docs/e2e/vault.md).
 *
 * Decision D1 (docs/TRACKER.md): pre-launch vault files are test data, so every document and
 * wrapped key row is deleted here rather than converted (the server cannot re-encrypt them for
 * the phone). S3 objects under vault/ are not touched by a migration; clear them by hand.
 * File name and type move into one sealed blob (sealed_meta); the per-person RSA key table
 * (vault_keys) is gone, the account key replaces it.
 * Written to be safe to re-run after a partial failure: each step checks before it acts.
 */
const tableExists = async (queryInterface, table) =>
  (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName)).includes(table);
const has = async (queryInterface, table, column) => Boolean((await queryInterface.describeTable(table))[column]);

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('DELETE FROM vault_document_keys');
    await queryInterface.sequelize.query('DELETE FROM vault_documents');

    for (const column of ['name', 'mime_type', 'encrypted_key', 'iv']) {
      if (await has(queryInterface, 'vault_documents', column)) await queryInterface.removeColumn('vault_documents', column);
    }
    await addColumnIfMissing(queryInterface, 'vault_documents', 'sealed_meta', { type: Sequelize.TEXT, allowNull: false });
    await addColumnIfMissing(queryInterface, 'vault_documents', 'scope', {
      type: Sequelize.ENUM('personal', 'household'), allowNull: false, defaultValue: 'personal',
    });
    await addIndexIfMissing(queryInterface, 'vault_documents', ['household_id', 'scope'], { name: 'idx_vault_documents_household_scope' });

    if (await tableExists(queryInterface, 'vault_keys')) await queryInterface.dropTable('vault_keys');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('DELETE FROM vault_document_keys');
    await queryInterface.sequelize.query('DELETE FROM vault_documents');

    // The household foreign key leans on this index; give it a plain one before this goes.
    await addIndexIfMissing(queryInterface, 'vault_documents', ['household_id'], { name: 'idx_vault_documents_household_id' });
    const indexes = await queryInterface.showIndex('vault_documents');
    if (indexes.some((i) => i.name === 'idx_vault_documents_household_scope')) {
      await queryInterface.removeIndex('vault_documents', 'idx_vault_documents_household_scope');
    }
    for (const column of ['sealed_meta', 'scope']) {
      if (await has(queryInterface, 'vault_documents', column)) await queryInterface.removeColumn('vault_documents', column);
    }
    await addColumnIfMissing(queryInterface, 'vault_documents', 'name', { type: Sequelize.STRING(255), allowNull: false });
    await addColumnIfMissing(queryInterface, 'vault_documents', 'mime_type', { type: Sequelize.STRING(100), allowNull: false });
    await addColumnIfMissing(queryInterface, 'vault_documents', 'encrypted_key', { type: Sequelize.TEXT, allowNull: false });
    await addColumnIfMissing(queryInterface, 'vault_documents', 'iv', { type: Sequelize.STRING(64), allowNull: false });

    // Same shape 20261013 left it: user_id primary key, household_id nullable with SET NULL.
    await createTableIfMissing(queryInterface, 'vault_keys', {
      user_id: {
        type: 'CHAR(36) BINARY', allowNull: false, primaryKey: true,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      household_id: {
        type: 'CHAR(36) BINARY', allowNull: true,
        references: { model: 'households', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      public_key: { type: Sequelize.TEXT, allowNull: false },
      private_key_encrypted: { type: Sequelize.TEXT, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
  },
};
