'use strict';

/** Spec 5.2-5.5: customers, subscriptions, checkout sessions, webhook events. */
const timestamps = (Sequelize) => ({
  created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
  updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
});
const householdFk = (Sequelize) => ({
  type: Sequelize.UUID, allowNull: false,
  references: { model: 'households', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
});
const PROVIDERS = ['stripe', 'apple', 'google'];
const STATUSES = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused'];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('billing_customers', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      household_id: householdFk(Sequelize),
      provider: { type: Sequelize.ENUM(...PROVIDERS), allowNull: false },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      provider_customer_id: { type: Sequelize.STRING(255), allowNull: false },
      billing_email: { type: Sequelize.STRING(255), allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_customers', ['household_id', 'provider', 'livemode'], { unique: true, name: 'uq_billing_customers_household_mode' });
    await queryInterface.addIndex('billing_customers', ['provider', 'livemode', 'provider_customer_id'], { unique: true, name: 'uq_billing_customers_provider_id' });

    await queryInterface.createTable('billing_subscriptions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      household_id: householdFk(Sequelize),
      provider: { type: Sequelize.ENUM(...PROVIDERS), allowNull: false },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      provider_subscription_id: { type: Sequelize.STRING(255), allowNull: false },
      status: { type: Sequelize.ENUM(...STATUSES), allowNull: false },
      interval: { type: Sequelize.ENUM('month', 'year'), allowNull: false },
      seats: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false },
      price_id: { type: Sequelize.STRING(255), allowNull: true },
      price_set: { type: Sequelize.STRING(32), allowNull: true },
      unit_amount: { type: Sequelize.INTEGER, allowNull: true },
      currency: { type: Sequelize.CHAR(3), allowNull: true },
      current_period_start: { type: Sequelize.DATE, allowNull: true },
      current_period_end: { type: Sequelize.DATE, allowNull: true },
      cancel_at_period_end: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      canceled_at: { type: Sequelize.DATE, allowNull: true },
      ended_at: { type: Sequelize.DATE, allowNull: true },
      pending_update: { type: Sequelize.JSON, allowNull: true },
      grace_until: { type: Sequelize.DATE, allowNull: true },
      purchased_by_user_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      event_watermark: { type: Sequelize.BIGINT, allowNull: true },
      last_synced_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_subscriptions', ['provider', 'livemode', 'provider_subscription_id'], { unique: true, name: 'uq_billing_subscriptions_provider_id' });
    await queryInterface.addIndex('billing_subscriptions', ['household_id', 'livemode', 'status'], { name: 'idx_billing_subscriptions_household_mode_status' });

    await queryInterface.createTable('billing_checkout_sessions', {
      id: { type: Sequelize.UUID, primaryKey: true },
      household_id: householdFk(Sequelize),
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      provider_session_id: { type: Sequelize.STRING(255), allowNull: true, unique: true },
      created_by_user_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      interval: { type: Sequelize.ENUM('month', 'year'), allowNull: false },
      seats: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false },
      status: { type: Sequelize.ENUM('creating', 'open', 'complete', 'expired', 'failed'), allowNull: false, defaultValue: 'creating' },
      url: { type: Sequelize.TEXT, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_checkout_sessions', ['household_id', 'livemode', 'status'], { name: 'idx_billing_checkout_household_mode_status' });

    await queryInterface.createTable('billing_events', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      provider: { type: Sequelize.ENUM(...PROVIDERS), allowNull: false },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      provider_event_id: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.ENUM('received', 'processing', 'processed', 'failed', 'ignored', 'dead'), allowNull: false, defaultValue: 'received' },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      locked_at: { type: Sequelize.DATE, allowNull: true },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      received_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_events', ['status', 'updated_at'], { name: 'idx_billing_events_status_updated' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('billing_events');
    await queryInterface.dropTable('billing_checkout_sessions');
    await queryInterface.dropTable('billing_subscriptions');
    await queryInterface.dropTable('billing_customers');
  },
};
