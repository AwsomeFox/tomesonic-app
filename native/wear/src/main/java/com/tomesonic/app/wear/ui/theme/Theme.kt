package com.tomesonic.app.wear.ui.theme

import androidx.compose.runtime.Composable
import androidx.wear.compose.material3.ColorScheme
import androidx.wear.compose.material3.MaterialTheme

/**
 * The phone's dark palette wearing Wear M3's role names.
 *
 * Wear Compose Material 3's ColorScheme is NOT the phone's: there is no
 * `surface`/`surfaceVariant` pair (a watch has `background` plus three
 * container tiers), and every accent gains a `*Dim` sibling. The mapping below
 * is role-for-role wherever the two schemes share a name and documented in
 * `Color.kt` wherever they don't.
 *
 * Only the colors are overridden. Typography and shapes stay Wear M3's own
 * defaults on purpose: they are tuned for a round 1.2–1.4" screen at arm's
 * length, and the phone's type ramp has nothing useful to say about that.
 *
 * Possible follow-up (v1 non-goal): the phone honours Material You, tinting
 * itself from the system wallpaper palette (see
 * `native/theme/DynamicThemeContext.tsx`). The watch equivalent would seed this
 * scheme from the active WATCH FACE's colors. Wear has no wallpaper API to read,
 * so that needs a real design decision rather than a port, and v1 ships the
 * brand teal.
 */
private val TomeSonicWearColorScheme = ColorScheme(
    primary = TomeSonicColors.Primary,
    primaryDim = TomeSonicColors.PrimaryDim,
    primaryContainer = TomeSonicColors.PrimaryContainer,
    onPrimary = TomeSonicColors.OnPrimary,
    onPrimaryContainer = TomeSonicColors.OnPrimaryContainer,
    secondary = TomeSonicColors.Secondary,
    secondaryDim = TomeSonicColors.SecondaryDim,
    secondaryContainer = TomeSonicColors.SecondaryContainer,
    onSecondary = TomeSonicColors.OnSecondary,
    onSecondaryContainer = TomeSonicColors.OnSecondaryContainer,
    tertiary = TomeSonicColors.Tertiary,
    tertiaryDim = TomeSonicColors.TertiaryDim,
    tertiaryContainer = TomeSonicColors.TertiaryContainer,
    onTertiary = TomeSonicColors.OnTertiary,
    onTertiaryContainer = TomeSonicColors.OnTertiaryContainer,
    surfaceContainerLow = TomeSonicColors.SurfaceContainerLow,
    surfaceContainer = TomeSonicColors.SurfaceContainer,
    surfaceContainerHigh = TomeSonicColors.SurfaceContainerHigh,
    onSurface = TomeSonicColors.OnSurface,
    onSurfaceVariant = TomeSonicColors.OnSurfaceVariant,
    outline = TomeSonicColors.Outline,
    outlineVariant = TomeSonicColors.OutlineVariant,
    background = TomeSonicColors.Background,
    onBackground = TomeSonicColors.OnSurface,
    error = TomeSonicColors.Error,
    errorDim = TomeSonicColors.ErrorDim,
    onError = TomeSonicColors.OnError,
    errorContainer = TomeSonicColors.ErrorContainer,
    onErrorContainer = TomeSonicColors.OnErrorContainer
)

@Composable
fun TomeSonicWearTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = TomeSonicWearColorScheme, content = content)
}
