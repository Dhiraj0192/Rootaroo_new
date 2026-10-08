// Every unit test starts with default providers; tests needing a fake use __setServicesForTests.
// Required inside beforeEach so a test file's own jest.mock calls are in place before providers load.
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initServices } = require('../../services') as typeof import('../../services');
  initServices({ email: 'log', sms: 'log', push: 'expo', storage: 's3', weather: 'open-meteo', monitoring: 'console' });
});
