'use strict';

/** Monotonic counter of applied plan changes; part of the Stripe idempotency key (plan.ts). */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('billing_subscriptions', 'plan_change_version', {
      type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('billing_subscriptions', 'plan_change_version');
  },
};
