'use strict';

/**
 * Guards for migrations that may meet a schema built by the old dev-only
 * sequelize.sync() boot (removed 2026-09-28): that created the models' full,
 * current schema without recording anything in sequelize_meta, so plain
 * addColumn/addIndex hit "duplicate" errors there. On a migration-built
 * database these behave exactly like the unguarded calls.
 *
 * Lives outside migrations/ — sequelize-cli runs every file in that folder.
 */

async function addColumnIfMissing(queryInterface, table, column, spec) {
  const columns = await queryInterface.describeTable(table);
  if (columns[column]) return false;
  await queryInterface.addColumn(table, column, spec);
  return true;
}

async function addIndexIfMissing(queryInterface, table, fields, options) {
  const indexes = await queryInterface.showIndex(table);
  if (indexes.some((i) => i.name === options.name)) return;
  await queryInterface.addIndex(table, fields, options);
}

module.exports = { addColumnIfMissing, addIndexIfMissing };
