'use strict';

const { createTableIfMissing, addColumnIfMissing, addIndexIfMissing } = require('../migrationHelpers');

/**
 * W10: account key, QR device transfer and guess-capped backup (docs/e2e/device-transfer.md).
 *
 * Decision D1 (docs/TRACKER.md): pre-launch vault data is test data, so the old
 * per-household vault rows are deleted here. The vault_* tables themselves are NOT
 * dropped yet: the current app still uses them until the mobile switch to the account
 * key lands. S3 objects under vault/ are not touched by a migration; clear them by hand.
 */
const now = (Sequelize) => ({ type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') });

module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfMissing(queryInterface, 'account_keys', {
      user_id: {
        type: Sequelize.UUID, primaryKey: true,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
      },
      public_key: { type: Sequelize.STRING(64), allowNull: false },
      key_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: now(Sequelize),
      updated_at: now(Sequelize),
    });

    await addColumnIfMissing(queryInterface, 'devices', 'holds_account_key', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
    });

    await createTableIfMissing(queryInterface, 'key_transfer_sessions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      user_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
      },
      new_device_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'devices', key: 'id' }, onDelete: 'CASCADE',
      },
      new_ephemeral_public_key: { type: Sequelize.STRING(64), allowNull: false },
      old_ephemeral_public_key: { type: Sequelize.STRING(64), allowNull: true },
      payload: { type: Sequelize.TEXT, allowNull: true },
      status: { type: Sequelize.ENUM('open', 'sent', 'done', 'expired'), allowNull: false, defaultValue: 'open' },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      created_at: now(Sequelize),
      updated_at: now(Sequelize),
    });
    await addIndexIfMissing(queryInterface, 'key_transfer_sessions', ['user_id', 'status'], { name: 'idx_key_transfer_user_status' });
    await addIndexIfMissing(queryInterface, 'key_transfer_sessions', ['expires_at'], { name: 'idx_key_transfer_expires_at' });

    await createTableIfMissing(queryInterface, 'key_backups', {
      user_id: {
        type: Sequelize.UUID, primaryKey: true,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
      },
      kind: { type: Sequelize.ENUM('password', 'recovery_code'), allowNull: false },
      salt: { type: Sequelize.STRING(64), allowNull: false },
      kdf: { type: Sequelize.JSON, allowNull: false },
      verifier: { type: Sequelize.STRING(255), allowNull: false },
      stored_blob: { type: Sequelize.TEXT, allowNull: false },
      attempts_left: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 10 },
      created_at: now(Sequelize),
      updated_at: now(Sequelize),
    });

    await createTableIfMissing(queryInterface, 'key_restore_codes', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      user_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
      },
      device_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'devices', key: 'id' }, onDelete: 'CASCADE',
      },
      code_hash: { type: Sequelize.STRING(64), allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      attempts_left: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 5 },
      restore_token_hash: { type: Sequelize.STRING(64), allowNull: true },
      restore_token_expires_at: { type: Sequelize.DATE, allowNull: true },
      created_at: now(Sequelize),
      updated_at: now(Sequelize),
    });
    await addIndexIfMissing(queryInterface, 'key_restore_codes', ['user_id'], { name: 'idx_key_restore_codes_user_id' });
    await addIndexIfMissing(queryInterface, 'key_restore_codes', ['expires_at'], { name: 'idx_key_restore_codes_expires_at' });

    // Child rows first.
    for (const table of ['vault_document_keys', 'vault_documents', 'vault_keys']) {
      await queryInterface.sequelize.query(`DELETE FROM ${table}`);
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('key_restore_codes');
    await queryInterface.dropTable('key_backups');
    await queryInterface.dropTable('key_transfer_sessions');
    await queryInterface.removeColumn('devices', 'holds_account_key');
    await queryInterface.dropTable('account_keys');
    // The deleted vault rows are not restored.
  },
};
