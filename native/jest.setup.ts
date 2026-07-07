/**
 * Global jest setup: central mocks for every native module the app touches.
 * Tests import the app code directly; anything platform-level resolves to the
 * in-memory fakes below. Individual tests can still `jest.spyOn` /
 * `jest.mocked` these to assert calls or override behavior per-case.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

// ---------------------------------------------------------------------------
// react-native-mmkv — real in-memory key/value store, so storage.ts and every
// cache path behave like production (set/get round-trips, getAllKeys, etc.).
// ---------------------------------------------------------------------------
jest.mock("react-native-mmkv", () => {
  class MMKV {
    private map = new Map<string, string | number | boolean | Uint8Array>();
    constructor(_config?: any) {}
    set(key: string, value: string | number | boolean | Uint8Array) {
      this.map.set(key, value);
    }
    getString(key: string) {
      const v = this.map.get(key);
      return typeof v === "string" ? v : undefined;
    }
    getNumber(key: string) {
      const v = this.map.get(key);
      return typeof v === "number" ? v : undefined;
    }
    getBoolean(key: string) {
      const v = this.map.get(key);
      return typeof v === "boolean" ? v : undefined;
    }
    contains(key: string) {
      return this.map.has(key);
    }
    delete(key: string) {
      this.map.delete(key);
    }
    remove(key: string) {
      this.map.delete(key);
    }
    getAllKeys() {
      return Array.from(this.map.keys());
    }
    clearAll() {
      this.map.clear();
    }
    recrypt(_key?: string) {}
  }
  return { MMKV, createMMKV: (config?: any) => new MMKV(config) };
});

// ---------------------------------------------------------------------------
// react-native-track-player — full API surface as jest.fn()s + the enums the
// app reads. Playback tests drive these mocks and assert against them.
// ---------------------------------------------------------------------------
jest.mock("react-native-track-player", () => {
  const listeners: Array<{ event: string; handler: (payload: any) => void }> = [];
  const TrackPlayer = {
    setupPlayer: jest.fn().mockResolvedValue(undefined),
    updateOptions: jest.fn().mockResolvedValue(undefined),
    registerPlaybackService: jest.fn(),
    addEventListener: jest.fn((event: string, handler: any) => {
      const entry = { event, handler };
      listeners.push(entry);
      return { remove: () => listeners.splice(listeners.indexOf(entry), 1) };
    }),
    // Test helper (not part of the real API): fire a registered remote event.
    __emit: (event: string, payload?: any) =>
      listeners.filter((l) => l.event === event).forEach((l) => l.handler(payload)),
    __listeners: listeners,
    add: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
    retry: jest.fn().mockResolvedValue(undefined),
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    seekTo: jest.fn().mockResolvedValue(undefined),
    skip: jest.fn().mockResolvedValue(undefined),
    skipToNext: jest.fn().mockResolvedValue(undefined),
    skipToPrevious: jest.fn().mockResolvedValue(undefined),
    setRate: jest.fn().mockResolvedValue(undefined),
    setVolume: jest.fn().mockResolvedValue(undefined),
    getProgress: jest.fn().mockResolvedValue({ position: 0, duration: 0, buffered: 0 }),
    getPlaybackState: jest.fn().mockResolvedValue({ state: "paused" }),
    getActiveTrack: jest.fn().mockResolvedValue(null),
    getActiveTrackIndex: jest.fn().mockResolvedValue(0),
    getQueue: jest.fn().mockResolvedValue([]),
    updateMetadataForTrack: jest.fn().mockResolvedValue(undefined),
    updateNowPlayingMetadata: jest.fn().mockResolvedValue(undefined),
  };
  return {
    __esModule: true,
    default: TrackPlayer,
    Event: {
      RemotePlay: "remote-play",
      RemotePause: "remote-pause",
      RemoteStop: "remote-stop",
      RemoteNext: "remote-next",
      RemotePrevious: "remote-previous",
      RemoteJumpForward: "remote-jump-forward",
      RemoteJumpBackward: "remote-jump-backward",
      RemoteSeek: "remote-seek",
      RemotePlayId: "remote-play-id",
      RemoteDuck: "remote-duck",
      PlaybackState: "playback-state",
      PlaybackActiveTrackChanged: "playback-active-track-changed",
      PlaybackQueueEnded: "playback-queue-ended",
      PlaybackError: "playback-error",
    },
    State: {
      None: "none",
      Ready: "ready",
      Playing: "playing",
      Paused: "paused",
      Stopped: "stopped",
      Buffering: "buffering",
      Loading: "loading",
      Error: "error",
      Ended: "ended",
    },
    Capability: {
      Play: "play",
      Pause: "pause",
      Stop: "stop",
      SeekTo: "seek-to",
      JumpForward: "jump-forward",
      JumpBackward: "jump-backward",
      SkipToNext: "skip-to-next",
      SkipToPrevious: "skip-to-previous",
    },
    AppKilledPlaybackBehavior: {
      StopPlaybackAndRemoveNotification: "stop-playback-and-remove-notification",
      ContinuePlayback: "continue-playback",
      PausePlayback: "pause-playback",
    },
    RepeatMode: { Off: 0, Track: 1, Queue: 2 },
  };
});

// ---------------------------------------------------------------------------
// react-native-google-cast — no cast device in tests; hooks return null and
// components render nothing. Cast tests inject their own fake client.
// ---------------------------------------------------------------------------
jest.mock("react-native-google-cast", () => {
  const React = require("react");
  return {
    __esModule: true,
    useRemoteMediaClient: jest.fn(() => null),
    useCastDevice: jest.fn(() => null),
    useCastState: jest.fn(() => "notConnected"),
    CastButton: (props: any) => React.createElement("CastButton", props),
    CastContext: {
      getSessionManager: jest.fn(() => ({ endCurrentSession: jest.fn() })),
      showCastDialog: jest.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Notifee / Sentry — inert.
// ---------------------------------------------------------------------------
jest.mock("@notifee/react-native", () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn().mockResolvedValue("id"),
    cancelNotification: jest.fn().mockResolvedValue(undefined),
    createChannel: jest.fn().mockResolvedValue("channel"),
    requestPermission: jest.fn().mockResolvedValue({ authorizationStatus: 1 }),
    getNotificationSettings: jest.fn().mockResolvedValue({ authorizationStatus: 1 }),
  },
  AndroidImportance: { LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { DENIED: 0, AUTHORIZED: 1 },
}));

jest.mock("@sentry/react-native", () => ({
  init: jest.fn(),
  wrap: (c: any) => c,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Expo modules.
// ---------------------------------------------------------------------------
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///test-documents/",
  cacheDirectory: "file:///test-cache/",
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  moveAsync: jest.fn().mockResolvedValue(undefined),
  downloadAsync: jest.fn().mockResolvedValue({ uri: "file:///test-cache/dl", status: 200 }),
  readAsStringAsync: jest.fn().mockResolvedValue(""),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(50 * 1024 * 1024 * 1024),
  createDownloadResumable: jest.fn(() => ({
    downloadAsync: jest.fn().mockResolvedValue({ uri: "file:///test-cache/dl", status: 200 }),
    pauseAsync: jest.fn(),
    cancelAsync: jest.fn().mockResolvedValue(undefined),
  })),
  EncodingType: { UTF8: "utf8", Base64: "base64" },
}));

jest.mock("expo-secure-store", () => {
  const mem = new Map<string, string>();
  return {
    getItem: jest.fn((k: string) => mem.get(k) ?? null),
    setItem: jest.fn((k: string, v: string) => void mem.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => mem.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void mem.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void mem.delete(k)),
  };
});

jest.mock("expo-crypto", () => ({
  getRandomBytes: jest.fn((n: number) => new Uint8Array(n).fill(7)),
  getRandomBytesAsync: jest.fn(async (n: number) => new Uint8Array(n).fill(7)),
  digestStringAsync: jest.fn(async () => "digest"),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
}));

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

jest.mock("expo-keep-awake", () => ({
  useKeepAwake: jest.fn(),
  activateKeepAwakeAsync: jest.fn(),
  deactivateKeepAwake: jest.fn(),
}));

jest.mock("expo-screen-orientation", () => ({
  lockAsync: jest.fn().mockResolvedValue(undefined),
  unlockAsync: jest.fn().mockResolvedValue(undefined),
  OrientationLock: { PORTRAIT_UP: 1, ALL: 0 },
}));

jest.mock("expo-web-browser", () => ({
  openBrowserAsync: jest.fn().mockResolvedValue({ type: "dismiss" }),
  openAuthSessionAsync: jest.fn().mockResolvedValue({ type: "dismiss" }),
}));

jest.mock("expo-image", () => {
  const React = require("react");
  const { Image: RNImage } = require("react-native");
  return { Image: (props: any) => React.createElement(RNImage, { ...props, source: undefined }) };
});

jest.mock("expo-linear-gradient", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { LinearGradient: (props: any) => React.createElement(View, props, props.children) };
});

jest.mock("@pchmn/expo-material3-theme", () => ({
  useMaterial3Theme: jest.fn(() => ({ theme: null })),
}));

// Vector icons load real font assets through expo-font — swap the icon sets
// for plain Text elements carrying the glyph name (assertable + no registry).
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  const iconSet = (family: string) => {
    const C = ({ name, ...rest }: any) =>
      React.createElement(Text, { ...rest, accessibilityLabel: `${family}:${name}` }, name);
    C.displayName = family;
    return C;
  };
  return {
    MaterialIcons: iconSet("MaterialIcons"),
    MaterialCommunityIcons: iconSet("MaterialCommunityIcons"),
    Ionicons: iconSet("Ionicons"),
    Feather: iconSet("Feather"),
  };
});

// ---------------------------------------------------------------------------
// Reanimated + safe area.
// Self-contained inert mocks: the stock `react-native-reanimated/mock`
// transitively loads react-native-worklets' native bindings (throws under
// jest with reanimated v4), and the safe-area jest mock is an ES module whose
// named exports live on `.default`.
// ---------------------------------------------------------------------------
jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const RN = require("react-native");

  const passthrough = (Component: any) => {
    const C = React.forwardRef((props: any, ref: any) =>
      React.createElement(Component, { ...props, ref })
    );
    return C;
  };

  // Chainable no-op animation builder: FadeIn.duration(x).delay(y)...
  const builder: any = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "build" ? () => ({}) : () => builder),
    apply: () => builder,
  });

  const Animated = {
    View: passthrough(RN.View),
    Text: passthrough(RN.Text),
    Image: passthrough(RN.Image),
    ScrollView: passthrough(RN.ScrollView),
    FlatList: passthrough(RN.FlatList),
    createAnimatedComponent: (c: any) => passthrough(c),
  };

  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    useSharedValue: (init: any) => ({ value: init }),
    useAnimatedStyle: (factory: () => any) => {
      try {
        return factory();
      } catch {
        return {};
      }
    },
    useDerivedValue: (factory: () => any) => ({ value: (() => { try { return factory(); } catch { return undefined; } })() }),
    useAnimatedProps: () => ({}),
    useAnimatedReaction: jest.fn(),
    useAnimatedRef: () => ({ current: null }),
    useReducedMotion: jest.fn(() => false),
    withTiming: (v: any) => v,
    withSpring: (v: any) => v,
    withDelay: (_d: number, v: any) => v,
    withRepeat: (v: any) => v,
    withSequence: (...v: any[]) => v[v.length - 1],
    cancelAnimation: jest.fn(),
    runOnJS: (fn: any) => fn,
    runOnUI: (fn: any) => fn,
    interpolate: (value: number, input: number[], output: number[]) => {
      // Simple linear interpolation with edge clamping — enough for tests.
      if (value <= input[0]) return output[0];
      const last = input.length - 1;
      if (value >= input[last]) return output[last];
      for (let i = 0; i < last; i++) {
        if (value >= input[i] && value <= input[i + 1]) {
          const t = (value - input[i]) / (input[i + 1] - input[i] || 1);
          return output[i] + t * (output[i + 1] - output[i]);
        }
      }
      return output[0];
    },
    Extrapolation: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    Easing: {
      bezier: () => ({ factory: () => (t: number) => t }),
      linear: (t: number) => t,
      ease: (t: number) => t,
      cubic: (t: number) => t,
      out: (f: any) => f,
      in: (f: any) => f,
      inOut: (f: any) => f,
    },
    // Entering/exiting/layout animations — all chainable no-ops.
    FadeIn: builder,
    FadeOut: builder,
    FadeInDown: builder,
    FadeInUp: builder,
    FadeInRight: builder,
    FadeInLeft: builder,
    SlideInDown: builder,
    SlideInUp: builder,
    LinearTransition: builder,
    Layout: builder,
  };
});

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    __esModule: true,
    SafeAreaProvider: ({ children }: any) => React.createElement(View, null, children),
    SafeAreaView: React.forwardRef((props: any, ref: any) =>
      React.createElement(View, { ...props, ref }, props.children)
    ),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    SafeAreaInsetsContext: React.createContext(insets),
    initialWindowMetrics: { insets, frame },
  };
});

// ---------------------------------------------------------------------------
// Lazily-required native modules.
// ---------------------------------------------------------------------------
jest.mock(
  "@react-native-community/netinfo",
  () => ({
    __esModule: true,
    default: {
      addEventListener: jest.fn(() => jest.fn()),
      fetch: jest.fn().mockResolvedValue({ isConnected: true, isInternetReachable: true }),
    },
  }),
  { virtual: true }
);

jest.mock(
  "expo-sharing",
  () => ({
    isAvailableAsync: jest.fn().mockResolvedValue(false),
    shareAsync: jest.fn().mockResolvedValue(undefined),
  }),
  { virtual: true }
);

jest.mock(
  "react-native-webview",
  () => {
    const React = require("react");
    return { WebView: (props: any) => React.createElement("WebView", props) };
  },
  { virtual: true }
);

jest.mock(
  "react-native-pdf",
  () => {
    const React = require("react");
    return { __esModule: true, default: (props: any) => React.createElement("Pdf", props) };
  },
  { virtual: true }
);

// react-native-svg renders host components fine under jest-expo, but keep the
// heavier WavyProgress internals deterministic by stubbing requestAnimationFrame.
if (!(global as any).requestAnimationFrame) {
  (global as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
}
