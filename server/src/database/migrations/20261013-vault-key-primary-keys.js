'use strict';

/**
 * The baseline created vault_keys and vault_document_keys with no primary key
 * or unique index (and FKs that set the column to NULL on delete), so
 * VaultKey.upsert had nothing to conflict on and could insert a second row for
 * the same person, and a deleted document left orphaned wrapped keys behind.
 *
 * Any rows this removes (NULL owners, duplicates) are pre-launch test data
 * only (D1 in docs/TRACKER.md); the newest row per key is the one kept.
 * Every step checks first, so a re-run after a partial failure is safe.
 */

const TABLES = {
  vault_keys: {
    keyColumns: ['user_id'],
    notNull: ['user_id'],
    fks: [
      { name: 'fk_vault_keys_user', column: 'user_id', refTable: 'users', onDelete: 'CASCADE' },
      { name: 'fk_vault_keys_household', column: 'household_id', refTable: 'households', onDelete: 'SET NULL' },
    ],
  },
  vault_document_keys: {
    keyColumns: ['document_id', 'user_id'],
    notNull: ['document_id', 'user_id'],
    fks: [
      { name: 'fk_vault_document_keys_document', column: 'document_id', refTable: 'vault_documents', onDelete: 'CASCADE' },
      { name: 'fk_vault_document_keys_user', column: 'user_id', refTable: 'users', onDelete: 'CASCADE' },
    ],
  },
};

const ID_TYPE = 'CHAR(36) BINARY';

async function rows(queryInterface, sql, replacements) {
  const [result] = await queryInterface.sequelize.query(sql, { replacements });
  return result;
}

async function foreignKeyNames(queryInterface, table) {
  const found = await rows(
    queryInterface,
    `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table],
  );
  return found.map((r) => r.name);
}

// The baseline FKs are auto-named, so look the names up rather than guess.
async function dropAllForeignKeys(queryInterface, table) {
  for (const name of await foreignKeyNames(queryInterface, table)) {
    await queryInterface.sequelize.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``);
  }
}

async function hasPrimaryKey(queryInterface, table) {
  const found = await rows(
    queryInterface,
    `SELECT 1 AS present FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'PRIMARY KEY'`,
    [table],
  );
  return found.length > 0;
}

async function isNullable(queryInterface, table, column) {
  const found = await rows(
    queryInterface,
    `SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return found.length > 0 && found[0].nullable === 'YES';
}

async function setNullability(queryInterface, table, column, nullable) {
  if ((await isNullable(queryInterface, table, column)) === nullable) return;
  await queryInterface.sequelize.query(
    `ALTER TABLE \`${table}\` MODIFY \`${column}\` ${ID_TYPE} ${nullable ? 'NULL' : 'NOT NULL'}`,
  );
}

// Keeps the newest updated_at per key. Rebuilt through a scratch table so that
// exact ties (no row identity to tell them apart) still collapse to one row.
async function dedupe(queryInterface, table, keyColumns) {
  const q = (sql) => queryInterface.sequelize.query(sql);
  const keys = keyColumns.map((c) => `\`${c}\``).join(', ');
  const [{ total }] = await rows(queryInterface, `SELECT COUNT(*) AS total FROM \`${table}\``);
  const [{ distinctKeys }] = await rows(
    queryInterface,
    `SELECT COUNT(*) AS distinctKeys FROM (SELECT 1 FROM \`${table}\` GROUP BY ${keys}) k`,
  );
  if (Number(total) === Number(distinctKeys)) return;

  const scratch = `${table}_dedupe_tmp`;
  const joinOn = keyColumns.map((c) => `t.\`${c}\` = n.\`${c}\``).join(' AND ');
  const valueColumns = (await rows(
    queryInterface,
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME NOT IN (${keyColumns.map(() => '?').join(', ')})`,
    [table, ...keyColumns],
  )).map((r) => r.name);
  const pick = valueColumns.map((c) => `MAX(t.\`${c}\`) AS \`${c}\``).join(', ');

  await q(`DROP TEMPORARY TABLE IF EXISTS \`${scratch}\``);
  await q(
    `CREATE TEMPORARY TABLE \`${scratch}\` AS
     SELECT ${keyColumns.map((c) => `t.\`${c}\``).join(', ')}, ${pick}
     FROM \`${table}\` t
     JOIN (SELECT ${keys}, MAX(updated_at) AS newest FROM \`${table}\` GROUP BY ${keys}) n
       ON ${joinOn} AND t.updated_at <=> n.newest
     GROUP BY ${keyColumns.map((c) => `t.\`${c}\``).join(', ')}`,
  );
  await q(`DELETE FROM \`${table}\``);
  await q(`INSERT INTO \`${table}\` (${[...keyColumns, ...valueColumns].map((c) => `\`${c}\``).join(', ')})
           SELECT ${[...keyColumns, ...valueColumns].map((c) => `\`${c}\``).join(', ')} FROM \`${scratch}\``);
  await q(`DROP TEMPORARY TABLE \`${scratch}\``);
}

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    for (const [table, spec] of Object.entries(TABLES)) {
      // FKs go first: SET NULL ones would otherwise fight the NOT NULL change.
      await dropAllForeignKeys(queryInterface, table);

      for (const column of spec.notNull) {
        await q(`DELETE FROM \`${table}\` WHERE \`${column}\` IS NULL`);
      }
      await dedupe(queryInterface, table, spec.keyColumns);
      for (const column of spec.notNull) {
        await setNullability(queryInterface, table, column, false);
      }

      if (!(await hasPrimaryKey(queryInterface, table))) {
        await q(`ALTER TABLE \`${table}\` ADD PRIMARY KEY (${spec.keyColumns.map((c) => `\`${c}\``).join(', ')})`);
      }

      // Rows whose parent is already gone would make the FK fail to add.
      for (const fk of spec.fks) {
        if (fk.onDelete === 'CASCADE') {
          await q(`DELETE FROM \`${table}\` WHERE \`${fk.column}\` NOT IN (SELECT id FROM \`${fk.refTable}\`)`);
        } else {
          await q(`UPDATE \`${table}\` SET \`${fk.column}\` = NULL WHERE \`${fk.column}\` IS NOT NULL AND \`${fk.column}\` NOT IN (SELECT id FROM \`${fk.refTable}\`)`);
        }
        await q(
          `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${fk.name}\` FOREIGN KEY (\`${fk.column}\`)
           REFERENCES \`${fk.refTable}\` (id) ON DELETE ${fk.onDelete} ON UPDATE CASCADE`,
        );
      }
    }
  },

  // Back to the baseline shape: no primary keys, nullable columns, SET NULL FKs.
  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    for (const [table, spec] of Object.entries(TABLES)) {
      await dropAllForeignKeys(queryInterface, table);

      if (await hasPrimaryKey(queryInterface, table)) {
        await q(`ALTER TABLE \`${table}\` DROP PRIMARY KEY`);
      }
      for (const column of spec.notNull) {
        await setNullability(queryInterface, table, column, true);
      }
      for (const fk of spec.fks) {
        await q(
          `ALTER TABLE \`${table}\` ADD FOREIGN KEY (\`${fk.column}\`)
           REFERENCES \`${fk.refTable}\` (id) ON DELETE SET NULL ON UPDATE CASCADE`,
        );
      }
    }
  },
};
