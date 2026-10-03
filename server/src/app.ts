import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis from './config/redis';
import { env } from './config/env';
import { errorHandler } from './shared/middleware/errorHandler';
import path from 'path';
import authRouter from './modules/auth/routes';
import householdRouter from './modules/household/routes';
import feedRouter from './modules/feed/routes';
import taskRouter from './modules/task/routes';
import groceryRouter from './modules/grocery/routes';
import todoRouter from './modules/todo/routes';
import notificationRouter from './modules/notification/routes';
import dashboardRouter from './modules/dashboard/routes';
import expenseRouter from './modules/expense/routes';
import vaultRouter from './modules/vault/routes';
import chatRouter from './modules/chat/routes';
import eventRouter from './modules/calendar/routes';
import calendarFeedRouter from './modules/calendar/feedRoutes';
import { shouldServeUploads } from './shared/middleware/uploads';
import billingRouter from './modules/billing/routes';
import billingWebhookRouter from './modules/billing/webhookRoutes';
import checkInRouter from './modules/checkin/routes';
import pingRouter from './modules/ping/routes';
import placeRouter from './modules/place/routes';
import journalRouter from './modules/journal/routes';
import adminRouter from './modules/admin/routes';
import billingAdminRouter from './modules/billing/admin/routes';
import weatherRouter from './modules/weather/routes';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import logger from './shared/utils/logger';

const app = express();

// Railway (and most cloud hosts) sit the app behind their own reverse
// proxy, which sets X-Forwarded-For. Without this, Express's default
// (trust proxy: false) makes express-rate-limit's IP-based key generator
// throw ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request instead of
// rate-limiting by real client IP. `1` trusts exactly one hop — matches
// Railway's single reverse-proxy topology, not an arbitrary chain of
// caller-supplied headers.
app.set('trust proxy', 1);

// ── Security Middleware ──
app.use(helmet());
app.use(cors({
  origin: env.corsOrigins,
  credentials: true,
}));

// Users are on a high-latency link (Nepal ↔ Railway): feed/chat JSON is
// dominated by long signed media URLs and compresses ~3-5x, which saves
// whole round trips during TCP slow start on a fresh connection.
app.use(compression());

// ── Billing webhooks ──
// Raw body (signature verification), no rate limit (renewal-day bursts, T9),
// so they are mounted before the limiter and before express.json() (§4.4).
app.use('/api/v1/billing/webhooks', billingWebhookRouter);

// ── Rate Limiting ──
// Backed by Redis so limits survive restarts/deploys and are shared across
// instances, instead of the default in-memory store resetting on every boot.
//
// Fails OPEN, not closed: rate-limit-redis awaits a `SCRIPT LOAD` result on
// every check, so if Redis is unreachable that check rejects and would
// otherwise 500 every single API request. Rate limiting is a defense-in-depth
// measure, not core correctness — better to let requests through
// unthrottled during a Redis outage than to take the whole API down with it.
// `redisRateLimiter()` below only delegates to the Redis-backed limiter once
// `redis.status === 'ready'`; otherwise it skips straight to `next()`.
function redisRateLimiter(limiter: ReturnType<typeof rateLimit>) {
  return function rateLimitGate(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (redis.status !== 'ready') return next();
    limiter(req, res, next);
  };
}

// Auth endpoints (login, password reset, phone OTP) get the opposite
// failure mode: these guard account-takeover surfaces, so an unthrottled
// window during a Redis outage is worse than a temporary 503. Fails CLOSED.
function authRedisRateLimiter(limiter: ReturnType<typeof rateLimit>) {
  return function authRateLimitGate(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (redis.status !== 'ready') {
      res.status(503).json({ success: false, error: 'Service temporarily unavailable, please try again shortly.' });
      return;
    }
    limiter(req, res, next);
  };
}

const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
  store: new RedisStore({
    prefix: 'rl:general:',
    sendCommand: (...args: string[]) => (redis as any).call(...args),
  }),
});
app.use('/api/', redisRateLimiter(generalLimiter));

// Strict rate limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many auth attempts, please try again later.' },
  store: new RedisStore({
    prefix: 'rl:auth:',
    sendCommand: (...args: string[]) => (redis as any).call(...args),
  }),
});
app.use('/api/v1/auth/', authRedisRateLimiter(authLimiter));

// ── Body Parsing ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request Logging ──
app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined', {
  stream: { write: (message: string) => logger.info(message.trim()) },
}));

// ── Health Check ──
app.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

// ── Static files (uploaded media) ──
if (shouldServeUploads(env.nodeEnv)) {
  app.use('/uploads', express.static(path.resolve(env.uploadDir || './uploads')));
}

// ── API Routes ──
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/households', householdRouter);
app.use('/api/v1/feed', feedRouter);
app.use('/api/v1/tasks', taskRouter);
app.use('/api/v1/groceries', groceryRouter);
app.use('/api/v1/todos', todoRouter);
app.use('/api/v1/expenses', expenseRouter);
app.use('/api/v1/vault', vaultRouter);
app.use('/api/v1/notifications', notificationRouter);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/events', eventRouter);
app.use('/api/v1/calendar-feed', calendarFeedRouter);
app.use('/api/v1/chat', chatRouter);
app.use('/api/v1/checkins', checkInRouter);
app.use('/api/v1/pings', pingRouter);
app.use('/api/v1/places', placeRouter);
app.use('/api/v1/journal', journalRouter);
app.use('/api/v1/billing', billingRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/billing-admin', billingAdminRouter);
app.use('/api/v1/weather', weatherRouter);

// ── Swagger Docs ──
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get('/api-docs.json', (_req, res) => {
  res.json(swaggerSpec);
});

// ── 404 Handler ──
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found', message: 'Route not found' });
});

// ── Global Error Handler ──
app.use(errorHandler);

export default app;
