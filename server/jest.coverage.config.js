/** Unit + integration together, for the >= 90 % billing coverage target (spec 13.1). */
module.exports = {
  testTimeout: 30000,
  projects: ['<rootDir>/jest.config.js', '<rootDir>/jest.int.config.js'],
  collectCoverageFrom: [
    '<rootDir>/src/modules/billing/**/*.ts',
    '!<rootDir>/src/modules/billing/scripts/**',
    '!<rootDir>/src/modules/billing/**/__tests__/**',
    '!<rootDir>/src/modules/billing/**/__int__/**',
  ],
  coverageThreshold: { global: { lines: 90, statements: 90, functions: 90, branches: 80 } },
};
