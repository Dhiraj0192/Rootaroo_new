// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = require('../migrations/20261016-shared-vault');

interface Schema {
  tables: Record<string, Record<string, unknown>>;
  indexes: Record<string, string[]>;
}

/** A tiny fake queryInterface that tracks tables, columns and indexes, so re-runs behave like a real database. */
function fake(initial: Schema) {
  const state: Schema = JSON.parse(JSON.stringify(initial));
  const qi: any = {
    sequelize: { query: jest.fn(async () => undefined) },
    showAllTables: jest.fn(async () => Object.keys(state.tables)),
    describeTable: jest.fn(async (t: string) => state.tables[t]),
    addColumn: jest.fn(async (t: string, c: string) => { state.tables[t][c] = {}; }),
    removeColumn: jest.fn(async (t: string, c: string) => {
      if (!(c in state.tables[t])) throw new Error(`Can't DROP '${c}'; check that column exists`);
      delete state.tables[t][c];
    }),
    showIndex: jest.fn(async (t: string) => (state.indexes[t] ?? []).map((name) => ({ name }))),
    addIndex: jest.fn(async (t: string, _f: string[], o: { name: string }) => { (state.indexes[t] ??= []).push(o.name); }),
    removeIndex: jest.fn(async (t: string, name: string) => { state.indexes[t] = state.indexes[t].filter((n) => n !== name); }),
    createTable: jest.fn(async (t: string) => { state.tables[t] = {}; }),
    dropTable: jest.fn(async (t: string) => {
      if (!(t in state.tables)) throw new Error(`Unknown table '${t}'`);
      delete state.tables[t];
    }),
  };
  return { qi, state };
}

const Sequelize = {
  TEXT: 'TEXT', DATE: 'DATE', literal: (s: string) => s,
  STRING: () => 'STRING', ENUM: () => 'ENUM',
};

const OLD: Schema = {
  tables: {
    vault_documents: { id: {}, household_id: {}, name: {}, mime_type: {}, encrypted_key: {}, iv: {} },
    vault_document_keys: { document_id: {} },
    vault_keys: { user_id: {} },
  },
  indexes: { vault_documents: [] },
};
const NEW_WITHOUT_VAULT_KEYS: Schema = {
  tables: {
    vault_documents: { id: {}, household_id: {}, sealed_meta: {}, scope: {} },
    vault_document_keys: { document_id: {} },
  },
  indexes: { vault_documents: ['idx_vault_documents_household_scope'] },
};

describe('shared vault migration is re-runnable', () => {
  it('up() on the old schema ends on the new one', async () => {
    const { qi, state } = fake(OLD);
    await migration.up(qi, Sequelize);
    expect(Object.keys(state.tables)).not.toContain('vault_keys');
    expect(state.tables.vault_documents).toEqual(expect.objectContaining({ sealed_meta: {}, scope: {} }));
  });

  it('up() after a run that failed past dropTable (vault_keys already gone) completes instead of throwing', async () => {
    const { qi } = fake(NEW_WITHOUT_VAULT_KEYS);
    await expect(migration.up(qi, Sequelize)).resolves.toBeUndefined();
    expect(qi.dropTable).not.toHaveBeenCalled();
  });

  it('up() twice in a row is fine', async () => {
    const { qi } = fake(OLD);
    await migration.up(qi, Sequelize);
    await expect(migration.up(qi, Sequelize)).resolves.toBeUndefined();
  });

  it('deletes the old rows only on the old schema, so a re-run never wipes encrypted files', async () => {
    const old = fake(OLD);
    await migration.up(old.qi, Sequelize);
    expect(old.qi.sequelize.query.mock.calls.map((c: string[]) => c[0])).toEqual(['DELETE FROM vault_document_keys', 'DELETE FROM vault_documents']);
    const again = fake(NEW_WITHOUT_VAULT_KEYS);
    await migration.up(again.qi, Sequelize);
    expect(again.qi.sequelize.query).not.toHaveBeenCalled();
  });

  it('down() on the old schema deletes nothing', async () => {
    const { qi } = fake(OLD);
    await migration.down(qi, Sequelize);
    expect(qi.sequelize.query).not.toHaveBeenCalled();
  });

  it('down() twice in a row is fine, and recreates vault_keys only once', async () => {
    const { qi, state } = fake(NEW_WITHOUT_VAULT_KEYS);
    await migration.down(qi, Sequelize);
    expect(Object.keys(state.tables)).toContain('vault_keys');
    await expect(migration.down(qi, Sequelize)).resolves.toBeUndefined();
    expect(qi.createTable).toHaveBeenCalledTimes(1);
  });
});

export {};
