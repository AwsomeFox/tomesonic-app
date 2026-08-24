package com.tomesonic.app.wear.ui

import android.content.Context
import android.media.AudioManager

/**
 * Media volume, one platform step at a time.
 *
 * Deliberately the smallest thing that works: `adjustStreamVolume(..., ADJUST_*,
 * FLAG_SHOW_UI)` is stable API back to API 1, moves the SAME stream the player
 * uses, and asks the system to draw its own volume overlay — so the watch shows
 * the slider its own face and its own headphones already agree on, and this file
 * draws nothing.
 *
 * Setting an absolute level was the alternative and is worse: the number of
 * steps differs per device (and per connected Bluetooth sink), so "volume 7"
 * means different things on the same watch ten seconds apart.
 */
class VolumeController(context: Context) {

    private val audioManager: AudioManager? = try {
        context.applicationContext.getSystemService(AudioManager::class.java)
    } catch (t: Throwable) {
        null
    }

    fun raise() = adjust(AudioManager.ADJUST_RAISE)

    fun lower() = adjust(AudioManager.ADJUST_LOWER)

    private fun adjust(direction: Int) {
        try {
            audioManager?.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
        } catch (t: Throwable) {
            // A watch can refuse the adjustment while a call or a system alert
            // owns the stream. A dead volume tick is not worth a crash.
        }
    }

    /**
     * Rotary crown -> volume steps.
     *
     * The crown reports SCROLL PIXELS, not detents, and a fast flick delivers
     * hundreds of them in a handful of events. Accumulating and spending them in
     * whole steps is what stops one flick emptying the volume scale — and keeps
     * a slow turn from doing nothing at all.
     */
    fun onRotary(deltaPixels: Float) {
        if (!deltaPixels.isFinite()) return
        accumulated += deltaPixels
        while (accumulated >= PIXELS_PER_STEP) {
            accumulated -= PIXELS_PER_STEP
            raise()
        }
        while (accumulated <= -PIXELS_PER_STEP) {
            accumulated += PIXELS_PER_STEP
            lower()
        }
    }

    private var accumulated = 0f

    private companion object {
        /**
         * Roughly one crown detent on the watches that report ~64px per detent,
         * biased high: over-sensitive volume is far more annoying than a crown
         * that needs a second flick.
         */
        const val PIXELS_PER_STEP = 60f
    }
}
