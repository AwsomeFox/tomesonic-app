import { registerRootComponent } from 'expo';
import TrackPlayer from 'react-native-track-player';
import App from './App';
import { playbackService } from './store/playbackService';
import { initSentry } from './utils/sentry';
import { appLogger } from './utils/logger';

// Initialize crash reporting as early as possible so setup-time errors are
// captured too. No-op unless EXPO_PUBLIC_SENTRY_DSN is set (and never in dev).
initSentry();

// Capture otherwise-invisible failures into the on-device log so a crash or an
// OEM background-kill leaves a diagnosable trail even without Sentry (which is
// opt-in and off by default). Persist a durable tail via db.saveLog so it
// survives the process death itself; the in-RAM appLogger ring is lost on exit.
(function installGlobalErrorHandlers() {
  const persist = (level: 'ERROR' | 'WARN', message: string) => {
    try {
      const { db } = require('./utils/db');
      db.saveLog({ level, message, timestamp: Date.now(), tag: 'Global' });
    } catch {}
  };
  try {
    const g: any = global as any;
    const prior = typeof ErrorUtils !== 'undefined' ? ErrorUtils.getGlobalHandler?.() : undefined;
    if (typeof ErrorUtils !== 'undefined' && ErrorUtils.setGlobalHandler) {
      ErrorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
        const msg = `${isFatal ? 'FATAL ' : ''}${error?.name || 'Error'}: ${error?.message || error}`;
        appLogger.error(msg, 'Global');
        persist('ERROR', `${msg}\n${error?.stack || ''}`.trim());
        if (typeof prior === 'function') prior(error, isFatal);
      });
    }
    // Hermes surfaces unhandled promise rejections via this hook.
    if (typeof g.HermesInternal?.enablePromiseRejectionTracker === 'function') {
      g.HermesInternal.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (_id: number, rejection: any) => {
          const msg = `Unhandled rejection: ${rejection?.message || rejection}`;
          appLogger.warn(msg, 'Global');
          persist('WARN', `${msg}\n${rejection?.stack || ''}`.trim());
        },
      });
    }
    // Trim the persisted log on boot so it can't grow without bound.
    try {
      const { db } = require('./utils/db');
      db.cleanLogs?.(72);
    } catch {}
  } catch {}
})();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

// Register react-native-track-player background service
TrackPlayer.registerPlaybackService(() => playbackService);
