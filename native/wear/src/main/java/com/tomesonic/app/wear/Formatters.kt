package com.tomesonic.app.wear

// Display helpers with no Android types, so they stay unit-testable without
// Robolectric. Digits are assembled by hand rather than via String.format:
// the platform default locale would otherwise render non-ASCII digits on some
// watches.
object Formatters {

    /**
     * Millis -> "H:MM:SS", dropping the hour field under an hour ("M:SS").
     * Truncates sub-second remainders; negatives (an unknown position/duration
     * from the player) clamp to zero.
     */
    fun msToClock(ms: Long): String {
        val totalSeconds = (if (ms > 0L) ms else 0L) / 1000L
        val hours = totalSeconds / 3600L
        val minutes = (totalSeconds % 3600L) / 60L
        val seconds = totalSeconds % 60L
        val ss = seconds.toString().padStart(2, '0')
        return if (hours > 0L) {
            "$hours:${minutes.toString().padStart(2, '0')}:$ss"
        } else {
            "$minutes:$ss"
        }
    }
}
