import { registerRootComponent } from 'expo';
import TrackPlayer from 'react-native-track-player';
import App from './App';
import { playbackService } from './store/playbackService';
import { initSentry } from './utils/sentry';

// Initialize crash reporting as early as possible so setup-time errors are
// captured too. No-op unless EXPO_PUBLIC_SENTRY_DSN is set (and never in dev).
initSentry();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

// Register react-native-track-player background service
TrackPlayer.registerPlaybackService(() => playbackService);
