import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app';
import { env } from './config/env';
import { testDatabaseConnection } from './config/database';
import { setupAssociations } from './database/models';
import './config/redis';
import { startGroceryArchiveJob } from './jobs/grocery-archive';
import { startEventReminderJob } from './jobs/event-reminder';
import { startCalendarSyncJob } from './jobs/calendar-sync';
import { startOverduePointsReductionJob } from './jobs/overdue-points';
import { startPurgeScheduledDeletionsJob } from './jobs/purge-scheduled-deletions';
import { startPingExpiryJob } from './jobs/ping-expiry';
import { startBillingEventSweepJob } from './jobs/billing-event-sweep';
import { startBillingCheckoutSweepJob } from './jobs/billing-checkout-sweep';
import { startBillingReconcileJobs } from './jobs/billing-reconcile';
import { startBillingPriceNoticesJob } from './jobs/billing-price-notices';
import { setIO } from './shared/utils/socket';
import {
  socketAuthMiddleware,
  setupSocketConnectionHandlers,
} from './shared/middleware/socketAuth';
import { registerChatSocket } from './socket/chatSocket';
import logger from './shared/utils/logger';
import { assertBillingConfigAtStartup } from './modules/billing/config';
import { assertNoUploadsInProduction } from './shared/middleware/uploads';
import { startCatalogBustSubscriber } from './modules/billing/catalog';

// Optional infra (Redis cache/rate-limit store, etc.) must never take the
// whole API down. ioredis and its consumers (e.g. rate-limit-redis) can
// reject a command while Redis is unreachable/reconnecting; without this,
// an unhandled rejection from that background activity crashes the entire
// Node process on Node 15+.
process.on('unhandledRejection', (reason) => {
  logger.error('[Server] Unhandled promise rejection (continuing):', reason);
});

const server = http.createServer(app);

// ── Socket.io Setup ──
const io = new SocketIOServer(server, {
  cors: {
    origin: env.corsOrigins,
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── Socket.io Security ──
// 1. JWT auth middleware — rejects unauthenticated connections
socketAuthMiddleware(io);

// 2. Connection handler — room joining, household access, token refresh
setupSocketConnectionHandlers(io);

// 3. Feature-specific handlers (chat, typing, presence, etc.)
registerChatSocket(io);

// Make io accessible to route handlers
app.set('io', io);
setIO(io);

// ── Start Server ──
async function start(): Promise<void> {
  try {
    assertBillingConfigAtStartup();
    startCatalogBustSubscriber();
    assertNoUploadsInProduction(app, env.nodeEnv);
    // Connect to MySQL
    await testDatabaseConnection();

    // Set up model associations
    setupAssociations();

    // Schema comes from migrations only (`npm run db:migrate`, also run by
    // `npm start`/`npm run dev`) — never sequelize.sync(), which built dev
    // schemas the migrations didn't know about and broke db:migrate.

    // Redis is already connecting (config/redis.ts handles it)
    // No need to await — it connects asynchronously

    // Start scheduled jobs
    startGroceryArchiveJob();
    startEventReminderJob();
    startCalendarSyncJob();
    startOverduePointsReductionJob();
    startPurgeScheduledDeletionsJob();
    startPingExpiryJob();
    startBillingEventSweepJob();
    startBillingCheckoutSweepJob();
    startBillingReconcileJobs();
    startBillingPriceNoticesJob();

    server.listen(env.port, () => {
      logger.info(`
╔══════════════════════════════════════════╗
║          Rootaroo API Server              ║
║──────────────────────────────────────────║
║  Port:    ${String(env.port).padEnd(32)}║
║  Env:     ${env.nodeEnv.padEnd(32)}║
║  DB:      ${env.db.host}:${String(env.db.port).padEnd(20)}║
║  Redis:   ${env.redis.host}:${String(env.redis.port).padEnd(20)}║
╚══════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export { io };
