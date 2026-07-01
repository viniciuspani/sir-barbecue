// Babel config — Sir Barbecue (Expo SDK 55)
// O plugin de worklets DEVE ser o último da lista.
// Reanimated 4.x usa `react-native-worklets/plugin` (worklets é pacote separado);
// em Reanimated 3.x seria `react-native-reanimated/plugin`.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
