module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['./scripts/exclude-design-route.cjs'],
  };
};
