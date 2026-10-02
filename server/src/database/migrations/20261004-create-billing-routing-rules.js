'use strict';

const crypto = require('crypto');
const { defaultRoutingRules } = require('../billingSeeds');

/** Spec 5.7 + 12: which purchase method each platform/country sees. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('billing_routing_rules', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      platform: { type: Sequelize.ENUM('ios', 'android', 'web'), allowNull: false },
      country: { type: Sequelize.STRING(2), allowNull: false },
      method: { type: Sequelize.ENUM('stripe_checkout', 'apple_iap', 'google_play', 'none'), allowNull: false },
      updated_by: { type: Sequelize.STRING(100), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('billing_routing_rules', ['platform', 'country'], { unique: true, name: 'uq_billing_routing_rules_platform_country' });

    const now = new Date();
    await queryInterface.bulkInsert('billing_routing_rules', defaultRoutingRules(process.env.NODE_ENV || 'development').map((r) => ({
      id: crypto.randomUUID(), platform: r.platform, country: r.country, method: r.method,
      updated_by: 'migration', created_at: now, updated_at: now,
    })));
  },

  async down(queryInterface) {
    await queryInterface.dropTable('billing_routing_rules');
  },
};
