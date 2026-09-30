'use strict';

const { addColumnIfMissing } = require('../migrationHelpers');

/**
 * Who created each to-do, so the To-do screen can show "Assigned by".
 * Nullable: rows created before this have no recorded creator.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'todo_items', 'created_by', {
      type: Sequelize.CHAR(36).BINARY,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('todo_items', 'created_by');
  },
};
