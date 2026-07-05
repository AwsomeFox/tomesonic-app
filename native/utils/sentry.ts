import * as Sentry from "@sentry/react-native";

// Crash/error reporting. Kept fully inert until a DSN is supplied so the app
// (and CI builds) work with zero Sentry config — set EXPO_PUBLIC_SENTRY_DSN
// (e.g. in eas.json `env` per profile, or a local .env) to switch it on.
//
// Source maps: the @sentry/react-native config plugin (added in app.json)
// uploads them during EAS builds when SENTRY_ORG, SENTRY_PROJECT and
// SENTRY_AUTH_TOKEN are present in the build environment (use an EAS secret for
// the auth token). Without those the build still succeeds; stack traces just
// stay minified.

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

export function initSentry() {
  // No DSN → don't initialize at all (Sentry.captureException etc. become
  // harmless no-ops). Also never report from dev builds.
  if (!dsn || __DEV__) return;
  Sentry.init({
    dsn,
    // Capture native + JS crashes. Leave performance tracing off until it's
    // needed — it adds overhead and event volume.
    tracesSampleRate: 0,
    // Don't attach the full breadcrumb of every console.log in production.
    enableAutoSessionTracking: true,
  });
}

export { Sentry };
