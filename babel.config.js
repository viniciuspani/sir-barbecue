// Babel config — Sir Barbecue (Expo SDK 55)
// Notas:
// - `@babel/plugin-proposal-decorators` (legacy) é exigido pelos models do WatermelonDB.
// - O plugin de worklets DEVE ser o último da lista.
//   Reanimated 4.x usa `react-native-worklets/plugin` (worklets virou pacote separado).
//   Em Reanimated 3.x o plugin seria `react-native-reanimated/plugin`.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ['@babel/plugin-proposal-decorators', { legacy: true }],
      'react-native-worklets/plugin',
    ],
  };
};
