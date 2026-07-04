const ORIGINAL_DEV = (global as any).__DEV__;

afterEach(() => {
  delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  (global as any).__DEV__ = ORIGINAL_DEV;
});

function loadAndInit(): { init: jest.Mock } {
  let sentryMock: any;
  jest.isolateModules(() => {
    sentryMock = require("@sentry/react-native");
    const { initSentry } = require("../../utils/sentry");
    initSentry();
  });
  return sentryMock;
}

describe("initSentry", () => {
  it("stays inert without a DSN", () => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    (global as any).__DEV__ = false;
    const sentry = loadAndInit();
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("never reports from dev builds even with a DSN", () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.io/1";
    (global as any).__DEV__ = true;
    const sentry = loadAndInit();
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("initializes with the DSN in a production build", () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.io/1";
    (global as any).__DEV__ = false;
    const sentry = loadAndInit();
    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://key@sentry.io/1",
        tracesSampleRate: 0,
        enableAutoSessionTracking: true,
      })
    );
  });

  it("re-exports the Sentry module", () => {
    let mod: any;
    let sentryMock: any;
    jest.isolateModules(() => {
      sentryMock = require("@sentry/react-native");
      mod = require("../../utils/sentry");
    });
    // Namespace interop adds a `default` key — compare a member instead.
    expect(mod.Sentry.init).toBe(sentryMock.init);
    expect(mod.Sentry.captureException).toBe(sentryMock.captureException);
  });
});
