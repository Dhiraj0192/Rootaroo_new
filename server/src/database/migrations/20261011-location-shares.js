'use strict';

const { createTableIfMissing, addIndexIfMissing } = require('../migrationHelpers');

/**
 * Location sharing gets its own table (up to 8 h, chosen audience, one live
 * position per share) and replaces the live-share columns on ping_requests.
 */
const OLD_PING_COLUMNS = ['share_duration_minutes', 'share_expires_at', 'live_latitude', 'live_longitude', 'live_updated_at'];

module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfMissing(queryInterface, 'location_shares', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      household_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'households', key: 'id' }, onDelete: 'CASCADE',
      },
      sharer_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
      },
      viewer_ids: { type: Sequelize.JSON, allowNull: true },
      ping_request_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'ping_requests', key: 'id' }, onDelete: 'SET NULL',
      },
      started_at: { type: Sequelize.DATE, allowNull: false },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      ended_at: { type: Sequelize.DATE, allowNull: true },
      // Null once the share ends: only the live position is ever kept.
      latitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
      longitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
      accuracy: { type: Sequelize.FLOAT, allowNull: true },
      location_updated_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await addIndexIfMissing(queryInterface, 'location_shares', ['household_id', 'ended_at'], { name: 'idx_location_shares_household_ended' });
    await addIndexIfMissing(queryInterface, 'location_shares', ['sharer_id', 'ended_at'], { name: 'idx_location_shares_sharer_ended' });
    await addIndexIfMissing(queryInterface, 'location_shares', ['expires_at'], { name: 'idx_location_shares_expires_at' });

    // Decision D1 (docs/TRACKER.md): pre-launch, so any live-share data on ping
    // requests is test data and is dropped rather than copied across.
    const columns = await queryInterface.describeTable('ping_requests');
    for (const column of OLD_PING_COLUMNS) {
      if (columns[column]) await queryInterface.removeColumn('ping_requests', column);
    }
  },

  async down(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('ping_requests');
    const specs = {
      share_duration_minutes: Sequelize.INTEGER,
      share_expires_at: Sequelize.DATE,
      live_latitude: Sequelize.DECIMAL(10, 7),
      live_longitude: Sequelize.DECIMAL(10, 7),
      live_updated_at: Sequelize.DATE,
    };
    for (const [column, type] of Object.entries(specs)) {
      if (!columns[column]) await queryInterface.addColumn('ping_requests', column, { type, allowNull: true });
    }
    await queryInterface.dropTable('location_shares');
  },
};
