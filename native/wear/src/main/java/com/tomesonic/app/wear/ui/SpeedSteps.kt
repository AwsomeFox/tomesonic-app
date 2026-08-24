package com.tomesonic.app.wear.ui

/**
 * The playback rates the watch offers, mirrored EXACTLY from the phone's
 * quick-pick row (`native/components/PlaybackSpeedModal.tsx`, `const QUICK`).
 *
 * The phone also has a ±0.05 stepper across 0.5–3.0; a watch has neither the
 * screen nor the patience for fifty steps, so the chip cycles the same six
 * values the phone puts one tap away. Anything the phone set outside this list
 * (via its stepper, synced through the shared speed preference) still RENDERS
 * correctly — [next] and [previous] just snap to the nearest step from there.
 *
 * (native/wear/ARCHITECTURE.md's UI section says "0.75–2.5"; the phone's actual
 * quick picks stop at 2.0, and mirroring the phone is the requirement that
 * wins.)
 */
object SpeedSteps {

    val STEPS: List<Float> = listOf(0.75f, 1.0f, 1.25f, 1.5f, 1.75f, 2.0f)

    /** Rates compare as floats; anything inside half a step is "the same step". */
    private const val EPSILON = 0.001f

    /**
     * The next rate up, wrapping at the top — a chip is a cycle, not a stepper,
     * and a dead-ended chip on a watch reads as a broken one.
     *
     * An off-list rate (the phone's stepper landed on 1.35) moves to the first
     * step ABOVE it rather than to some arbitrary index.
     */
    fun next(current: Float): Float {
        val above = STEPS.firstOrNull { it > current + EPSILON }
        return above ?: STEPS.first()
    }

    /** The mirror image of [next]: the first step below, wrapping at the bottom. */
    fun previous(current: Float): Float {
        val below = STEPS.lastOrNull { it < current - EPSILON }
        return below ?: STEPS.last()
    }

    /** The nearest step to an arbitrary rate — what the chip highlights. */
    fun nearest(current: Float): Float =
        STEPS.minByOrNull { kotlin.math.abs(it - current) } ?: 1.0f

    /**
     * "1×", "1.25×" — the phone's own chip label (`{rate}×`), which drops a
     * trailing zero because JS numbers do. Two decimals never appear: no step
     * has them.
     */
    fun label(speed: Float): String {
        val hundredths = Math.round(speed * 100.0f)
        val whole = hundredths / 100
        val fraction = hundredths % 100
        val text = when {
            fraction == 0 -> "$whole"
            fraction % 10 == 0 -> "$whole.${fraction / 10}"
            else -> "$whole.${if (fraction < 10) "0$fraction" else "$fraction"}"
        }
        return "${text}×"
    }
}
