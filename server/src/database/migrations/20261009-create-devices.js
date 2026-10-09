'use strict';

const { createTableIfMissing, addIndexIfMissing, addColumnIfMissing } = require('../migrationHelpers');

/**
 * Device registry: each sign-in belongs to a device the user can see and remove.
 * refresh_tokens / device_tokens get a device_id; ON DELETE CASCADE so deleting
 * a device row can never leave a session or push token behind.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfMissing(queryInterface, 'devices', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      user_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
      },
      device_key: { type: Sequelize.STRING(64), allowNull: false },
      name: { type: Sequelize.STRING(100), allowNull: false },
      platform: { type: Sequelize.ENUM('ios', 'android', 'web'), allowNull: true },
      app_version: { type: Sequelize.STRING(32), allowNull: true },
      last_seen_at: { type: Sequelize.DATE, allowNull: false },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await addIndexIfMissing(queryInterface, 'devices', ['user_id', 'device_key'], { unique: true, name: 'uq_devices_user_device_key' });
    await addIndexIfMissing(queryInterface, 'devices', ['user_id'], { name: 'idx_devices_user_id' });

    const deviceRef = { model: 'devices', key: 'id' };
    for (const table of ['refresh_tokens', 'device_tokens']) {
      await addColumnIfMissing(queryInterface, table, 'device_id', {
        type: Sequelize.UUID, allowNull: true, references: deviceRef, onDelete: 'CASCADE',
      });
    }

    // Decision D1 (docs/TRACKER.md): the app is pre-launch, so existing sessions are
    // test data. Dropping the ones with no device forces a fresh sign-in that creates one.
    await queryInterface.sequelize.query('DELETE FROM refresh_tokens WHERE device_id IS NULL');
  },

  async down(queryInterface) {
    // FK columns go before the table they point at.
    await queryInterface.removeColumn('device_tokens', 'device_id');
    await queryInterface.removeColumn('refresh_tokens', 'device_id');
    await queryInterface.dropTable('devices');
  },
};
