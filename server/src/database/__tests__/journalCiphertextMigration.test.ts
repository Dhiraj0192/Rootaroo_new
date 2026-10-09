// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = require('../migrations/20261015-journal-ciphertext');

type Columns = Record<string, Record<string, unknown>>;

/** A tiny fake queryInterface that tracks the schema, so re-runs behave like they would on a real database. */
function fake(initial: Columns) {
  const tables: Columns = JSON.parse(JSON.stringify(initial));
  const queries: string[] = [];
  const qi: any = {
    sequelize: { query: jest.fn(async (sql: string) => { queries.push(sql); }) },
    describeTable: jest.fn(async (t: string) => tables[t]),
    removeColumn: jest.fn(async (t: string, c: string) => { delete tables[t][c]; }),
    addColumn: jest.fn(async (t: string, c: string) => { tables[t][c] = {}; }),
    renameColumn: jest.fn(async (t: string, from: string, to: string) => { tables[t][to] = tables[t][from]; delete tables[t][from]; }),
  };
  return { qi, tables, queries };
}

const Sequelize = { TEXT: Object.assign(() => 'TEXT', {}), TINYINT: 'TINYINT', STRING: () => 'STRING', JSON: 'JSON', ENUM: () => 'ENUM' };

const OLD = {
  journal_entries: { id: {}, content: {}, mood: {}, tags: {} },
  journal_media: { id: {}, media_url: {}, thumbnail_url: {}, media_type: {} },
};
const NEW = {
  journal_entries: { id: {}, ciphertext: {}, sealed_key: {}, format: {} },
  journal_media: { id: {}, blob_key: {}, thumbnail_key: {} },
};

describe('journal ciphertext migration', () => {
  it('deletes the old plaintext rows on the first run', async () => {
    const { qi, queries } = fake(OLD);
    await migration.up(qi, Sequelize);
    expect(queries).toEqual(['DELETE FROM journal_media', 'DELETE FROM journal_entries']);
  });

  it('never deletes rows when run again on the new schema (ciphertext must survive)', async () => {
    const { qi, queries } = fake(NEW);
    await migration.up(qi, Sequelize);
    expect(queries).toEqual([]);
  });

  it('after a partial failure it only clears the table that still has the old columns', async () => {
    const { qi, queries } = fake({
      journal_entries: { id: {}, ciphertext: {}, sealed_key: {}, format: {} },
      journal_media: { id: {}, media_url: {}, thumbnail_url: {}, media_type: {} },
    });
    await migration.up(qi, Sequelize);
    expect(queries).toEqual(['DELETE FROM journal_media']);
  });

  it('down() deletes the (unrestorable) rows only while the new columns exist', async () => {
    const first = fake(NEW);
    await migration.down(first.qi, Sequelize);
    expect(first.queries).toEqual(['DELETE FROM journal_media', 'DELETE FROM journal_entries']);

    const again = fake(OLD);
    await migration.down(again.qi, Sequelize);
    expect(again.queries).toEqual([]);
  });
});
