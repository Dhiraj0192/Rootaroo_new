import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { HouseholdMember } from '../../database/models';
import logger from '../utils/logger';
import { isSocketEntitled } from '../../modules/billing/socketGate';

// ── Typed socket data ──

export interface SocketUserData {
  userId: string;
  email: string;
  role: string;
  householdId: string | null;
  billingAllowed?: boolean;
  billingCheckedAt?: number;
  billingHouseholdId?: string;
}

export interface AuthenticatedSocket extends Socket {
  data: SocketUserData;
}

// ── Authentication middleware ──
// Verifies the JWT from handshake.auth.token before allowing connection

export function socketAuthMiddleware(io: SocketIOServer): void {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;

    if (!token) {
      logger.warn(`Socket auth rejected: no token provided (${socket.id})`);
      return next(new Error('Authentication required — provide a token in auth.token'));
    }

    try {
      const decoded = jwt.verify(token, env.jwt.accessSecret) as {
        userId: string;
        email: string;
        role: string;
        householdId?: string;
      };

      // Attach user data to socket
      socket.data.userId = decoded.userId;
      socket.data.email = decoded.email;
      socket.data.role = decoded.role;
      socket.data.householdId = decoded.householdId ?? null;

      // If householdId wasn't in the JWT, look up the active membership
      if (!socket.data.householdId) {
        const membership = await HouseholdMember.findOne({
          where: { userId: decoded.userId },
          attributes: ['householdId'],
          order: [['joinedAt', 'DESC']],
        });

        if (membership) {
          socket.data.householdId = membership.householdId;
        }
      }

      next();
    } catch (err) {
      const message = err instanceof jwt.TokenExpiredError
        ? 'Token expired — please refresh and reconnect'
        : 'Invalid token';

      logger.warn(`Socket auth rejected: ${message} (${socket.id})`);
      next(new Error(message));
    }
  });
}

// ── Connection handler ──
// Auto-joins the user to their household room + personal room

export function setupSocketConnectionHandlers(io: SocketIOServer): void {
  io.on('connection', (socket: AuthenticatedSocket) => {
    const { userId, householdId } = socket.data;

    // Join a personal room for targeted events (e.g., notifications)
    socket.join(`user:${userId}`);

    if (householdId) {
      socket.join(`household:${householdId}`);
      void isSocketEntitled(socket);
      logger.info(
        `Socket connected: ${socket.id} | user:${userId} → household:${householdId}`,
      );
    } else {
      logger.info(
        `Socket connected: ${socket.id} | user:${userId} (no household yet)`,
      );
    }

    // ── Household room change ──
    // If a user joins a household after connecting, they can request to join the room
    socket.on('join:household', async (targetHouseholdId: string) => {
      if (typeof targetHouseholdId !== 'string' || !targetHouseholdId) {
        socket.emit('error', { message: 'Invalid household ID' });
        return;
      }

      // Verify actual membership — don't trust the client
      const membership = await HouseholdMember.findOne({
        where: { userId, householdId: targetHouseholdId },
        attributes: ['id'],
      });

      if (!membership) {
        socket.emit('error', { message: 'You are not a member of this household' });
        return;
      }

      // Leave old household room if present
      if (socket.data.householdId) {
        socket.leave(`household:${socket.data.householdId}`);
      }

      socket.data.householdId = targetHouseholdId;
      socket.join(`household:${targetHouseholdId}`);
      socket.emit('joined:household', { householdId: targetHouseholdId });
      logger.info(
        `Socket ${socket.id} joined household room: ${targetHouseholdId}`,
      );
    });

    // ── Disconnect ──
    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} | reason: ${reason}`);
    });

    // ── Periodic token validation ──
    // If the client supports it, re-verify token on heartbeat
    socket.on('auth:ping', () => {
      const freshToken = socket.handshake.auth?.token as string | undefined;
      if (!freshToken) {
        socket.emit('auth:expired');
        socket.disconnect(true);
        return;
      }

      try {
        jwt.verify(freshToken, env.jwt.accessSecret);
        socket.emit('auth:pong', { valid: true });
      } catch {
        socket.emit('auth:expired');
        socket.disconnect(true);
      }
    });
  });
}

// ── Guard helper ──
// Use inside socket event handlers to ensure the user belongs to the target household

export function requireHouseholdAccess(
  socket: AuthenticatedSocket,
  targetHouseholdId: string,
): boolean {
  if (socket.data.householdId !== targetHouseholdId) {
    socket.emit('error', {
      message: 'You do not have access to this household',
    });
    return false;
  }
  return true;
}
