'use strict';

const { addColumnIfMissing, addIndexIfMissing } = require('../migrationHelpers');

/**
 * Makes calendar sync multi-provider. `calendar_sync_states` and
 * `calendar_events.google_event_id` were implicitly Google-only (no
 * `provider` column, no discriminated external-id pair) — this adds what
 * Outlook (Graph) and Apple (CalDAV) need to plug into the same sync engine
 * without three duplicated tables. Purely additive: existing Google rows are
 * backfilled to `provider = 'google'` and `external_provider`/
 * `external_event_id` are backfilled from `google_event_id`, so nothing
 * that reads the old columns breaks. The old columns stay in place — not
 * dropped here — as a rollback safety margin; a follow-up migration removes
 * them once Outlook/Apple are live and stable.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ── calendar_sync_states ──
    await addColumnIfMissing(queryInterface, 'calendar_sync_states', 'provider', {
      type: Sequelize.ENUM('google', 'outlook', 'apple'),
      allowNull: false,
      defaultValue: 'google',
    });
    // Every existing row predates this column and is a Google connection —
    // NOT NULL + DEFAULT 'google' above already backfills them correctly,
    // this is just making that explicit/documented rather than relying on
    // the default alone for existing data.
    await queryInterface.sequelize.query(
      "UPDATE `calendar_sync_states` SET `provider` = 'google' WHERE `provider` IS NULL",
    );

    // Only Google rows have a calendar id at connect time today; Outlook
    // will populate `outlook_calendar_id` and Apple has no single "calendar
    // id" concept (it gets a calendar *home URL* instead) — the column can
    // no longer be NOT NULL once non-Google rows exist.
    await queryInterface.changeColumn('calendar_sync_states', 'google_calendar_id', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, 'calendar_sync_states', 'outlook_calendar_id', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    // Apple ID email — not a secret, stored plaintext (unlike the password).
    await addColumnIfMissing(queryInterface, 'calendar_sync_states', 'apple_id', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    // Encrypted at rest via the same getter/setter pattern as access_token/
    // refresh_token (CalendarSyncState model), keyed by env.calendarTokenKek.
    await addColumnIfMissing(queryInterface, 'calendar_sync_states', 'apple_password', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    // Cached CalDAV calendar-home-set URL from service discovery, so
    // reconnects/syncs skip re-discovering it against caldav.icloud.com.
    await addColumnIfMissing(queryInterface, 'calendar_sync_states', 'caldav_calendar_home_url', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });

    await addIndexIfMissing(queryInterface, 'calendar_sync_states', ['user_id', 'provider'], {
      name: 'idx_calendar_sync_states_user_provider',
      unique: true,
    });

    // ── calendar_events ──
    await addColumnIfMissing(queryInterface, 'calendar_events', 'external_provider', {
      type: Sequelize.ENUM('google', 'outlook', 'apple'),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'calendar_events', 'external_event_id', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.sequelize.query(
      "UPDATE `calendar_events` SET `external_provider` = 'google', `external_event_id` = `google_event_id` WHERE `google_event_id` IS NOT NULL",
    );
    await addIndexIfMissing(queryInterface, 'calendar_events', ['external_provider', 'external_event_id'], {
      name: 'idx_calendar_events_external',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('calendar_events', 'idx_calendar_events_external');
    await queryInterface.removeColumn('calendar_events', 'external_event_id');
    await queryInterface.removeColumn('calendar_events', 'external_provider');

    await queryInterface.removeIndex('calendar_sync_states', 'idx_calendar_sync_states_user_provider');
    await queryInterface.removeColumn('calendar_sync_states', 'caldav_calendar_home_url');
    await queryInterface.removeColumn('calendar_sync_states', 'apple_password');
    await queryInterface.removeColumn('calendar_sync_states', 'apple_id');
    await queryInterface.removeColumn('calendar_sync_states', 'outlook_calendar_id');
    await queryInterface.changeColumn('calendar_sync_states', 'google_calendar_id', {
      type: Sequelize.STRING(255),
      allowNull: false,
    });
    await queryInterface.removeColumn('calendar_sync_states', 'provider');
  },
};
