module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    plugins: [
      "react-native-reanimated/plugin",
    ],
    env: {
      production: {
        // Strip console.* from release bundles (perf + no leaking server
        // URLs/ids into logcat). Keep error/warn so genuine problems still
        // surface in crash-reporting breadcrumbs.
        plugins: [["transform-remove-console", { exclude: ["error", "warn"] }]],
      },
    },
  };
};
