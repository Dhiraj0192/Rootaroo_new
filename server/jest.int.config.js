/** Integration tests: real MySQL (rootaroo_test). Run with `npm run test:int`. */
module.exports = {
  displayName: 'int',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__int__/**/*.int.test.ts'],
  setupFiles: ['<rootDir>/src/test/int/env.ts'],
  globalSetup: '<rootDir>/src/test/int/globalSetup.ts',
  moduleNameMapper: { '^jose$': '<rootDir>/src/test/int/joseStub.ts' },
  testTimeout: 30000,
};
