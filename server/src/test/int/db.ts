import { QueryTypes } from 'sequelize';
import sequelize from '../../config/database';
import redis from '../../config/redis';

export async function resetDb(): Promise<void> {
  const rows = await sequelize.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND LOWER(table_name) <> 'sequelizemeta' AND table_type = 'BASE TABLE'",
    { type: QueryTypes.SELECT },
  );
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const { name } of rows) await sequelize.query(`TRUNCATE TABLE \`${name}\``);
  } finally {
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  if (redis.status === 'ready') {
    const keys = await redis.keys('billing:*');
    if (keys.length) await redis.del(...keys);
  }
}

export async function closeIntResources(): Promise<void> {
  await sequelize.close();
  redis.disconnect();
}
