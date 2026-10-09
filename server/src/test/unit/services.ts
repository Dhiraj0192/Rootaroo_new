// Every unit test starts with default providers; tests needing a fake use __setServicesForTests.
// Required inside beforeEach so a test file's own jest.mock calls are in place before providers load.
process.env.KEY_VAULT_LOCAL_SECRET = 'unit-test-key-vault-secret-0123456789abcdef';
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initServices } = require('../../services') as typeof import('../../services');
  initServices({ email: 'log', sms: 'log', push: 'expo', storage: 's3', weather: 'open-meteo', monitoring: 'console', keyVault: 'local' });
});
