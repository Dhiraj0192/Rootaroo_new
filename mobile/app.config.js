// Extends app.json. LOCAL_NO_FCM=1 drops the Android google-services.json reference so a
// local emulator build works without the Firebase file (push tokens are unavailable in that build).
// EAS and normal builds are unaffected.
module.exports = ({ config }) => {
  if (process.env.LOCAL_NO_FCM === '1' && config.android) {
    const { googleServicesFile, ...android } = config.android;
    return { ...config, android };
  }
  return config;
};
