'use strict';
// Creates the dev database (DB_NAME, default rootaroo_dev) and rootaroo_test if missing, using server/.env credentials.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    ...(process.env.DB_SOCKET ? { socketPath: process.env.DB_SOCKET } : {}),
  });
  for (const name of [process.env.DB_NAME || 'rootaroo_dev', 'rootaroo_test']) {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`database ${name}: ok`);
  }
  await conn.end();
}

main().catch((err) => {
  console.error(`ensure-databases failed: ${err.code || err.message}`);
  process.exit(1);
});
