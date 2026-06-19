// ESLint (flat config) — Sir Barbecue (Expo SDK 55)
// eslint-config-expo é instalado na sub-fase 0.3.
const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  {
    ignores: ['dist/*', 'node_modules/*', '.expo/*', 'android/*', 'ios/*'],
  },
];
