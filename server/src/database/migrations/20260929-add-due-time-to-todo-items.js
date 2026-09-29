'use strict';

const { addColumnIfMissing } = require('../migrationHelpers');

/**
 * Optional time of day for a to-do, so the To-do screen can lay the day out
 * as a timeline. Null means "any time that day". Purely additive.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'todo_items', 'due_time', {
      type: Sequelize.TIME,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('todo_items', 'due_time');
  },
};
