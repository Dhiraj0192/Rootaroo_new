'use strict';

const { addColumnIfMissing } = require('../migrationHelpers');

/**
 * Records which key vault protected each backup, so the vault can be switched
 * (local secret to AWS KMS) without losing the backups made before the switch.
 * Every existing backup was made by the local vault.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'key_backups', 'vault_provider', {
      type: Sequelize.STRING(16), allowNull: false, defaultValue: 'local',
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('key_backups');
    if (table.vault_provider) await queryInterface.removeColumn('key_backups', 'vault_provider');
  },
};
