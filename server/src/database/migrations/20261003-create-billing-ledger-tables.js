'use strict';

/** Spec 5.6, 5.8-5.10: ledger, price notices, reconciliation, audit log. */
const timestamps = (Sequelize) => ({
  created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
  updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
});

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('billing_transactions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      provider: { type: Sequelize.ENUM('stripe', 'apple', 'google'), allowNull: false },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      type: { type: Sequelize.ENUM('payment', 'failed_payment', 'refund', 'dispute'), allowNull: false },
      status: { type: Sequelize.STRING(32), allowNull: false },
      billing_reason: { type: Sequelize.STRING(40), allowNull: true },
      amount: { type: Sequelize.INTEGER, allowNull: false },
      fee: { type: Sequelize.INTEGER, allowNull: true },
      net: { type: Sequelize.INTEGER, allowNull: true },
      dispute_fee: { type: Sequelize.INTEGER, allowNull: true },
      funds_state: { type: Sequelize.ENUM('none', 'withdrawn', 'reinstated'), allowNull: true },
      currency: { type: Sequelize.CHAR(3), allowNull: false },
      household_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'households', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      user_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      subscription_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'billing_subscriptions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      match_status: { type: Sequelize.ENUM('matched', 'unmatched'), allowNull: false },
      household_name_snapshot: { type: Sequelize.STRING(100), allowNull: true },
      payer_email_snapshot: { type: Sequelize.STRING(255), allowNull: true },
      provider_object_id: { type: Sequelize.STRING(255), allowNull: false },
      provider_invoice_id: { type: Sequelize.STRING(255), allowNull: true },
      provider_charge_id: { type: Sequelize.STRING(255), allowNull: true },
      receipt_url: { type: Sequelize.TEXT, allowNull: true },
      description: { type: Sequelize.STRING(500), allowNull: true },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      last_event_id: { type: Sequelize.STRING(255), allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_transactions', ['provider', 'livemode', 'type', 'provider_object_id'], { unique: true, name: 'uq_billing_transactions_identity' });
    await queryInterface.addIndex('billing_transactions', ['livemode', 'occurred_at'], { name: 'idx_billing_transactions_mode_time' });
    await queryInterface.addIndex('billing_transactions', ['household_id', 'occurred_at'], { name: 'idx_billing_transactions_household_time' });
    await queryInterface.addIndex('billing_transactions', ['user_id'], { name: 'idx_billing_transactions_user' });

    await queryInterface.createTable('billing_price_notices', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      subscription_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'billing_subscriptions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      from_price_id: { type: Sequelize.STRING(255), allowNull: false },
      to_price_set: { type: Sequelize.STRING(32), allowNull: false },
      notice_sent_at: { type: Sequelize.DATE, allowNull: false },
      apply_after: { type: Sequelize.DATE, allowNull: false },
      applied_at: { type: Sequelize.DATE, allowNull: true },
      status: { type: Sequelize.ENUM('scheduled', 'applied', 'skipped', 'failed'), allowNull: false, defaultValue: 'scheduled' },
      reason: { type: Sequelize.STRING(500), allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_price_notices', ['subscription_id', 'to_price_set'], { unique: true, name: 'uq_billing_price_notices_sub_set' });

    await queryInterface.createTable('billing_reconciliation_runs', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      kind: { type: Sequelize.ENUM('daily', 'weekly', 'manual'), allowNull: false },
      started_at: { type: Sequelize.DATE, allowNull: false },
      finished_at: { type: Sequelize.DATE, allowNull: true },
      status: { type: Sequelize.ENUM('running', 'succeeded', 'failed'), allowNull: false, defaultValue: 'running' },
      counts: { type: Sequelize.JSON, allowNull: true },
      ...timestamps(Sequelize),
    });

    await queryInterface.createTable('billing_reconciliation_items', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      run_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'billing_reconciliation_runs', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      livemode: { type: Sequelize.BOOLEAN, allowNull: false },
      kind: { type: Sequelize.STRING(64), allowNull: false },
      entity_type: { type: Sequelize.STRING(32), allowNull: false },
      entity_id: { type: Sequelize.STRING(64), allowNull: true },
      provider_object_id: { type: Sequelize.STRING(255), allowNull: true },
      before: { type: Sequelize.JSON, allowNull: true },
      after: { type: Sequelize.JSON, allowNull: true },
      resolution: { type: Sequelize.ENUM('auto_fixed', 'needs_review', 'resolved', 'ignored'), allowNull: false },
      resolved_by: { type: Sequelize.STRING(100), allowNull: true },
      resolution_note: { type: Sequelize.STRING(1000), allowNull: true },
      resolved_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('billing_reconciliation_items', ['resolution', 'created_at'], { name: 'idx_billing_recon_items_resolution' });
    await queryInterface.addIndex('billing_reconciliation_items', ['kind', 'provider_object_id'], { name: 'idx_billing_recon_items_kind_object' });

    await queryInterface.createTable('admin_audit_log', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      surface: { type: Sequelize.ENUM('admin', 'billing-admin'), allowNull: false },
      key_label: { type: Sequelize.STRING(64), allowNull: false },
      method: { type: Sequelize.STRING(10), allowNull: false },
      path: { type: Sequelize.STRING(500), allowNull: false },
      query: { type: Sequelize.JSON, allowNull: true },
      body_digest: { type: Sequelize.CHAR(64), allowNull: true },
      status_code: { type: Sequelize.INTEGER, allowNull: false },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('admin_audit_log', ['surface', 'created_at'], { name: 'idx_admin_audit_log_surface_time' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('admin_audit_log');
    await queryInterface.dropTable('billing_reconciliation_items');
    await queryInterface.dropTable('billing_reconciliation_runs');
    await queryInterface.dropTable('billing_price_notices');
    await queryInterface.dropTable('billing_transactions');
  },
};
