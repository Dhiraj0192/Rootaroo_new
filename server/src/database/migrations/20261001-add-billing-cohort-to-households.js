'use strict';

const { addColumnIfMissing } = require('../migrationHelpers');

/** Spec 5.1: per-household billing cohort; 'test' bypasses the paywall and uses a Stripe sandbox. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'households', 'billing_cohort', {
      type: Sequelize.ENUM('live', 'test'),
      allowNull: false,
      defaultValue: 'live',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('households', 'billing_cohort');
  },
};
