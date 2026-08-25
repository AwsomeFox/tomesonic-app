package com.tomesonic.app.wear.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The speed chip.
 *
 * The first test is the one that matters: the watch offers EXACTLY the rates the
 * phone's quick-pick row offers (native/components/PlaybackSpeedModal.tsx). The
 * speed is a shared, persisted preference — a watch that could set 2.5× would
 * hand the phone a rate its own UI cannot show as selected.
 */
class SpeedStepsTest {

    private val delta = 1e-6f

    @Test
    fun stepsMirrorThePhonesQuickPicks() {
        assertEquals(
            listOf(0.75f, 1.0f, 1.25f, 1.5f, 1.75f, 2.0f),
            SpeedSteps.STEPS
        )
    }

    @Test
    fun nextWalksUpTheList() {
        assertEquals(1.0f, SpeedSteps.next(0.75f), delta)
        assertEquals(1.25f, SpeedSteps.next(1.0f), delta)
        assertEquals(2.0f, SpeedSteps.next(1.75f), delta)
    }

    @Test
    fun nextWrapsAtTheTop() {
        // A chip is a cycle: dead-ending at 2× looks like a broken button.
        assertEquals(0.75f, SpeedSteps.next(2.0f), delta)
        assertEquals(0.75f, SpeedSteps.next(3.0f), delta)
    }

    @Test
    fun previousWalksDownAndWrapsAtTheBottom() {
        assertEquals(1.5f, SpeedSteps.previous(1.75f), delta)
        assertEquals(0.75f, SpeedSteps.previous(1.0f), delta)
        assertEquals(2.0f, SpeedSteps.previous(0.75f), delta)
    }

    @Test
    fun aRateFromThePhonesStepperSnapsToTheNextStepEitherWay() {
        // The phone's ±0.05 stepper can leave the shared preference anywhere.
        assertEquals(1.5f, SpeedSteps.next(1.35f), delta)
        assertEquals(1.25f, SpeedSteps.previous(1.35f), delta)
    }

    @Test
    fun sixTapsReturnToWhereItStarted() {
        var rate = 1.0f
        repeat(SpeedSteps.STEPS.size) { rate = SpeedSteps.next(rate) }
        assertEquals(1.0f, rate, delta)
    }

    @Test
    fun nearestPicksTheClosestStep() {
        assertEquals(1.25f, SpeedSteps.nearest(1.31f), delta)
        assertEquals(1.5f, SpeedSteps.nearest(1.44f), delta)
        assertEquals(2.0f, SpeedSteps.nearest(2.9f), delta)
    }

    @Test
    fun labelsMatchThePhonesChipText() {
        // The phone renders `{rate}×` from a JS number: no trailing zeros.
        assertEquals("0.75×", SpeedSteps.label(0.75f))
        assertEquals("1×", SpeedSteps.label(1.0f))
        assertEquals("1.25×", SpeedSteps.label(1.25f))
        assertEquals("1.5×", SpeedSteps.label(1.5f))
        assertEquals("1.75×", SpeedSteps.label(1.75f))
        assertEquals("2×", SpeedSteps.label(2.0f))
    }

    @Test
    fun anOffListRateStillRenders() {
        assertEquals("1.35×", SpeedSteps.label(1.35f))
        assertEquals("1.05×", SpeedSteps.label(1.05f))
    }
}
