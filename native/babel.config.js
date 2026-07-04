module.exports = function (api) {
  api.cache.using(() => process.env.NODE_ENV);
  // Under jest, skip the NativeWind preset: its css-interop transform wraps
  // require("react-native") with helpers that break jest.mock factories — and
  // the app styles exclusively with style objects (zero className usage).
  const isTest = api.env("test");
  return {
    presets: isTest
      ? ["babel-preset-expo"]
      : [
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
