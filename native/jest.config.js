/** Jest config for the TomeSonic RN app.
 *
 * - jest-expo preset: handles Expo/RN transforms, platform extensions, and the
 *   react-native jest environment.
 * - Unit tests (utils/stores) and UI tests (@testing-library/react-native for
 *   components/screens) share this one config.
 * - Native modules are mocked centrally in jest.setup.ts (MMKV, TrackPlayer,
 *   Google Cast, Notifee, Sentry, expo-file-system, ...) so individual tests
 *   only mock what they specifically assert on.
 */
module.exports = {
  preset: "jest-expo",
  setupFiles: ["./jest.setup.ts"],
  // NOTE: transformIgnorePatterns intentionally NOT overridden — jest-expo's
  // preset default covers react-native/expo vendor code, and every exotic
  // native module is factory-mocked in jest.setup.ts (never actually loaded).
  testPathIgnorePatterns: ["/node_modules/", "/android/", "/ios/", "/plugins/"],
  collectCoverageFrom: [
    "store/**/*.{ts,tsx}",
    "utils/**/*.{ts,tsx}",
    "components/**/*.{ts,tsx}",
    "screens/**/*.{ts,tsx}",
    "hooks/**/*.{ts,tsx}",
    "theme/**/*.{ts,tsx}",
    "navigation/**/*.{ts,tsx}",
    "!**/*.d.ts",
  ],
  coveragePathIgnorePatterns: ["/node_modules/"],
  moduleNameMapper: {
    "\\.(css)$": "<rootDir>/__mocks__/styleMock.js",
  },
  // Keep runs deterministic and quiet in CI.
  clearMocks: true,
};
