import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app';
import { env } from './config/env';
import { testDatabaseConnection } from './config/database';
import { setupAssociations } from './database/models';
import './config/redis';
import { startGroceryArchiveJob } from './jobs/grocery-archive';
import { startEventReminderJob } from './jobs/event-reminder';
import { startPushReceiptsJob } from './jobs/push-receipts';
import { startCalendarSyncJob } from './jobs/calendar-sync';
import { startOverduePointsReductionJob } from './jobs/overdue-points';
import { startPurgeScheduledDeletionsJob } from './jobs/purge-scheduled-deletions';
import { startPingExpiryJob } from './jobs/ping-expiry';
import { startLocationShareExpiryJob } from './jobs/location-share-expiry';
import { startE2eCleanupJob } from './jobs/e2e-cleanup';
import { startBillingEventSweepJob } from './jobs/billing-event-sweep';
import { startBillingCheckoutSweepJob } from './jobs/billing-checkout-sweep';
import { startBillingReconcileJobs } from './jobs/billing-reconcile';
import { startBillingPriceNoticesJob } from './jobs/billing-price-notices';
import { startCampaignsJob } from './jobs/campaigns';
import { setIO } from './shared/utils/socket';
import {
  socketAuthMiddleware,
  setupSocketConnectionHandlers,
} from './shared/middleware/socketAuth';
import { registerChatSocket } from './socket/chatSocket';
import logger from './shared/utils/logger';
import { assertBillingConfigAtStartup, getBillingConfig } from './modules/billing/config';
import { assertNoUploadsInProduction } from './shared/middleware/uploads';
import { startCatalogBustSubscriber } from './modules/billing/catalog';
import { loadServicesConfig, describeServices } from './services/config';
import { initServices } from './services';

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

// Fail fast on a bad provider setup (e.g. log email in production) before anything starts.
function initServicesAtStartup(): void {
  const { config, errors, warnings } = loadServicesConfig(process.env);
  if (errors.length > 0) {
    for (const e of errors) logger.error(`[Services] ${e}`);
    process.exit(1);
  }
  for (const w of warnings) logger.warn(`[Services] ${w}`);
  initServices(config);
  for (const line of describeServices(config)) logger.info(`[Services] ${line}`);
}

// ── Start Server ──
async function start(): Promise<void> {
  try {
    initServicesAtStartup();
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
    startPushReceiptsJob();
    startCalendarSyncJob();
    startOverduePointsReductionJob();
    startPurgeScheduledDeletionsJob();
    startPingExpiryJob();
    startLocationShareExpiryJob();
    startE2eCleanupJob();
    if (process.env.CAMPAIGNS_ENABLED !== 'false') startCampaignsJob();
    if (getBillingConfig().enabled) {
      startBillingEventSweepJob();
      startBillingCheckoutSweepJob();
      startBillingReconcileJobs();
      startBillingPriceNoticesJob();
    }

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
