'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const Redis = require('ioredis');

const client = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  lazyConnect: true,
});

client
  .connect()
  .then(() => client.ping())
  .then((r) => { console.log(`redis: ${r}`); return client.quit(); })
  .catch((err) => { console.log(`redis: UNAVAILABLE (${err.message})`); process.exit(2); });
