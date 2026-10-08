import dotenv from 'dotenv';
import { execSync } from 'child_process';
import path from 'path';

export default async function globalSetup(): Promise<void> {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env.impl') });
  const dbName = process.env.DB_NAME_TEST || 'rootaroo_test';
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to migrate ${dbName}`);
  execSync('npx sequelize-cli db:migrate', {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, NODE_ENV: 'test', DB_NAME: dbName },
    stdio: 'inherit',
  });
}
