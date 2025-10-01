# Bluetooth/External Controls Update

## Summary
Modified the bluetooth and external media controls (headphones, car stereos, etc.) to use skip forward/backward (jump) functionality instead of skipping to the next/previous item in the queue.

## Changes Made

### File Modified
- `android/app/src/main/java/com/tomesonic/app/player/PlayerNotificationService.kt`

### Implementation Details

Added `onPlayerCommandRequest()` override method in the `MediaLibrarySessionCallback` class to intercept player commands from bluetooth/external controls before they execute.

The method intercepts:
- `COMMAND_SEEK_TO_NEXT_MEDIA_ITEM` / `COMMAND_SEEK_TO_NEXT` → redirects to `jumpForward()`
- `COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM` / `COMMAND_SEEK_TO_PREVIOUS` → redirects to `jumpBackward()`

### Behavior

**Before:**
- Pressing "next" on bluetooth headset → skipped to next chapter/episode in queue
- Pressing "previous" on bluetooth headset → skipped to previous chapter/episode in queue

**After:**
- Pressing "next" on bluetooth headset → skips forward by the configured jump time (e.g., 15 or 30 seconds)
- Pressing "previous" on bluetooth headset → skips backward by the configured jump time (e.g., 15 or 30 seconds)

### Technical Notes

1. The existing commands `COMMAND_SEEK_TO_NEXT_MEDIA_ITEM` and `COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM` were already removed from the available player commands in the `onConnect()` method.

2. However, some bluetooth devices still attempt to send these commands, so we intercept them at the callback level to ensure they're handled correctly.

3. The jump forward/backward functionality uses the user's configured jump time settings stored in `deviceSettings.jumpForwardTimeMs` and `deviceSettings.jumpBackwardsTimeMs`.

4. The implementation is chapter-aware and works with both local ExoPlayer and Cast player scenarios.

### Testing

To test this change:
1. Build and install the app on an Android device
2. Start playing an audiobook
3. Connect bluetooth headphones or use a car's bluetooth system
4. Press the "next track" button → should skip forward by the configured jump time
5. Press the "previous track" button → should skip backward by the configured jump time

The app should no longer skip to the next/previous chapter or episode when using bluetooth controls.
