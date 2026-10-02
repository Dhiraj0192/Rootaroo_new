// Unit tests never talk to Redis: a real ioredis client would retry forever and keep Jest alive.
// Individual tests can still jest.mock('.../config/redis') with their own stub.
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    status: 'end', get: jest.fn(), set: jest.fn(), del: jest.fn(), eval: jest.fn(), publish: jest.fn(),
    keys: jest.fn(async () => []), disconnect: jest.fn(), call: jest.fn(),
    duplicate: jest.fn(() => ({ on: jest.fn(), subscribe: jest.fn(async () => undefined) })),
  },
}));
