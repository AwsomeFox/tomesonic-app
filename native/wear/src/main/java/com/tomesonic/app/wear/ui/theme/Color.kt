package com.tomesonic.app.wear.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The phone app's DARK Material 3 palette, ported value-for-value from
 * `native/theme/palette.ts` (`darkColors` — SchemeTonalSpot from the brand seed
 * #1E5F50, NOT the M3 baseline purple).
 *
 * Watches are a dark canvas, always, so only the dark roles come across: the
 * phone's light scheme has no counterpart here. Every constant below is the
 * exact rgb() triple from palette.ts converted to 0xAARRGGBB, so the two apps
 * read as siblings — when the phone's palette moves, this file moves with it.
 *
 * THREE values are derived rather than copied, and are marked as such:
 * the Wear-only `*Dim` roles (the phone's M3 scheme has no "dim" tier) and
 * `onTertiary` (the phone's ThemeColors interface never needed one).
 */
object TomeSonicColors {

    // --- primary (brand teal) ---------------------------------------------
    val Primary = Color(0xFF86D6BF) // rgb(134, 214, 191)
    val OnPrimary = Color(0xFF00382D) // rgb(0, 56, 45)
    val PrimaryContainer = Color(0xFF005142) // rgb(0, 81, 66)
    val OnPrimaryContainer = Color(0xFFA1F2DB) // rgb(161, 242, 219)

    /**
     * DERIVED. Wear M3 wants a slightly darker primary for large filled areas;
     * the phone's scheme has no such role. This is the sRGB midpoint of the two
     * tones the phone DOES publish — light `primary` (#0D6B58, tone 40) and dark
     * `primary` (#86D6BF, tone 80) — i.e. tone ~60 of the same tonal palette.
     */
    val PrimaryDim = Color(0xFF4AA18C)

    // --- secondary ---------------------------------------------------------
    val Secondary = Color(0xFFB2CCC3) // rgb(178, 204, 195)
    val OnSecondary = Color(0xFF1D352E) // rgb(29, 53, 46)
    val SecondaryContainer = Color(0xFF334C44) // rgb(51, 76, 68)
    val OnSecondaryContainer = Color(0xFFCDE9DE) // rgb(205, 233, 222)

    /** DERIVED, same rule as [PrimaryDim]: midpoint of light/dark `secondary`. */
    val SecondaryDim = Color(0xFF7F9890)

    // --- tertiary ----------------------------------------------------------
    val Tertiary = Color(0xFFA9CBE3) // rgb(169, 203, 227)
    val TertiaryContainer = Color(0xFF294A5E) // rgb(41, 74, 94)
    val OnTertiaryContainer = Color(0xFFC6E7FF) // rgb(198, 231, 255)

    /** DERIVED, same rule as [PrimaryDim]: midpoint of light/dark `tertiary`. */
    val TertiaryDim = Color(0xFF7697AD)

    /**
     * DERIVED. `ThemeColors` on the phone has no onTertiary (nothing there ever
     * paints ON the tertiary accent). Tone 20 of the tertiary palette, one step
     * below the published `tertiaryContainer` (#294A5E, tone 30).
     */
    val OnTertiary = Color(0xFF0E3349)

    // --- error -------------------------------------------------------------
    val Error = Color(0xFFFFB4AB) // rgb(255, 180, 171)
    val OnError = Color(0xFF690005) // rgb(105, 0, 5)
    val ErrorContainer = Color(0xFF93000A) // rgb(147, 0, 10)
    val OnErrorContainer = Color(0xFFFFDAD6) // rgb(255, 218, 214)

    /** DERIVED, same rule as [PrimaryDim]: midpoint of the light/dark `error`. */
    val ErrorDim = Color(0xFFDC6763)

    // --- surfaces ----------------------------------------------------------
    /**
     * The watch canvas. The phone's darkest surface (`surfaceContainerLowest`,
     * rgb(9, 15, 13)) rather than its `surface` (rgb(15, 21, 19)): both are the
     * same green-black, and on an always-on OLED watch the darker of the two
     * real palette values is simply the right one to sit under everything.
     */
    val Background = Color(0xFF090F0D) // rgb(9, 15, 13)
    val Surface = Color(0xFF0F1513) // rgb(15, 21, 19)
    val SurfaceContainerLow = Color(0xFF171D1B) // rgb(23, 29, 27)
    val SurfaceContainer = Color(0xFF1B211F) // rgb(27, 33, 31)
    val SurfaceContainerHigh = Color(0xFF252B29) // rgb(37, 43, 41)
    val SurfaceContainerHighest = Color(0xFF303634) // rgb(48, 54, 52)
    val SurfaceBright = Color(0xFF343B38) // rgb(52, 59, 56)
    val SurfaceVariant = Color(0xFF3F4945) // rgb(63, 73, 69)

    val OnSurface = Color(0xFFDEE4E0) // rgb(222, 228, 224)
    val OnSurfaceVariant = Color(0xFFBFC9C4) // rgb(191, 201, 196)

    val Outline = Color(0xFF89938F) // rgb(137, 147, 143)
    val OutlineVariant = Color(0xFF3F4945) // rgb(63, 73, 69)

    val InverseSurface = Color(0xFFDEE4E0) // rgb(222, 228, 224)
    val InverseOnSurface = Color(0xFF2B322F) // rgb(43, 50, 47)
    val InversePrimary = Color(0xFF0D6B58) // rgb(13, 107, 88)

    // --- app-specific accents (not part of any M3 scheme, phone or wear) ----
    /** Text/icons over cover art — the player's backdrop overlay. */
    val OnMedia = Color(0xFFFFFFFF) // rgb(255, 255, 255)
    val OnMediaVariant = Color(0xFFDEE4E0) // rgb(222, 228, 224)

    /** "Downloaded" / "connected" green, same as the phone's `success`. */
    val Success = Color(0xFF4CAF50) // rgb(76, 175, 80)
}
