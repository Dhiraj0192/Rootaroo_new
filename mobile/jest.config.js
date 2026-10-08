module.exports = {
  preset: 'jest-expo',
  // Vault crypto tests generate RSA key pairs and PBKDF2 hashes; slow on CI-class machines.
  testTimeout: 30000,
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg)',
  ],
};
