package com.tomesonic.app.wear.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScrollIndicator
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText

// The watch app's own small component set.
//
// Wear Compose Material 3 has its own Button/Card/ListHeader, each with several
// heavily-defaulted overloads (containerPainter variants, SurfaceTransformation,
// per-component *Colors types). They are deliberately not used for the chips and
// cards here: the app's rows want one consistent shape and colour pair across
// seven screens, and a Row + background + clickable states that in six lines
// with nothing to keep in sync with a library's slot semantics.
//
// What DOES come from the library is everything the platform owns rather than
// the app: TimeText (the curved system clock), ScrollIndicator (the edge
// scrollbar), ScalingLazyColumn, MaterialTheme and Text. Those are not styling
// choices — a hand-drawn version of any of them would read as a foreign app.

/** Chips and cards share one radius so the two read as the same family. */
private val ChipShape = RoundedCornerShape(26.dp)
private val CardShape = RoundedCornerShape(20.dp)

/**
 * A scrolling screen: the app background, a ScalingLazyColumn (which centres a
 * short list and scales its edges — the reason round displays get this and not a
 * plain Column), the curved clock and the edge scroll indicator.
 *
 * Assembled by hand rather than via ScreenScaffold: the scaffold hands its
 * content a PaddingValues that the list must then apply itself, and one screen
 * forgetting to is a list clipped by the bezel. Two children in a Box do the
 * same job with nothing to forget.
 */
@Composable
fun ScrollScreen(
    modifier: Modifier = Modifier,
    state: ScalingLazyListState = rememberScalingLazyListState(),
    showTime: Boolean = true,
    content: ScalingLazyListScope.() -> Unit
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = state,
            // Wide vertical padding is what keeps the first and last rows off a
            // round display's curved edge; 8dp horizontal is the wear default.
            contentPadding = PaddingValues(start = 8.dp, end = 8.dp, top = 34.dp, bottom = 36.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            content = content
        )
        ScrollIndicator(
            state = state,
            modifier = Modifier.align(Alignment.CenterEnd)
        )
        // The system clock, curved along the top of a round display. Wear M3's
        // own — a hand-drawn flat one would be the single most obviously
        // non-native thing on the screen.
        if (showTime) TimeText()
    }
}

/** The screen's own name, as the first row of a list. */
@Composable
fun ScreenTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 2.dp),
        color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.titleMedium,
        textAlign = TextAlign.Center,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis
    )
}

/** A group label inside a list — the brand tint is the only thing marking it. */
@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier
            .fillMaxWidth()
            .padding(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 2.dp),
        color = MaterialTheme.colorScheme.primary,
        style = MaterialTheme.typography.labelMedium,
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
    )
}

/** Small centred prose: an offline hint, an empty state, an inline failure. */
@Composable
fun Note(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurfaceVariant
) {
    Text(
        text = text,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        color = color,
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center
    )
}

/**
 * The workhorse row: a full-width rounded chip with an optional leading glyph,
 * a label, an optional second line and an optional trailing glyph.
 */
@Composable
fun TomeChip(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    secondaryLabel: String? = null,
    enabled: Boolean = true,
    background: Color = MaterialTheme.colorScheme.surfaceContainer,
    contentColor: Color = MaterialTheme.colorScheme.onSurface,
    secondaryColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    icon: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 50.dp)
            .clip(ChipShape)
            .background(background)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (icon != null) {
            icon()
            Spacer(Modifier.width(10.dp))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                color = contentColor,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            if (secondaryLabel != null) {
                Text(
                    text = secondaryLabel,
                    color = secondaryColor,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            trailing()
        }
    }
}

/** A chip that carries the brand fill — one per screen, at most. */
@Composable
fun PrimaryChip(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    secondaryLabel: String? = null,
    enabled: Boolean = true,
    icon: (@Composable () -> Unit)? = null
) {
    TomeChip(
        label = label,
        onClick = onClick,
        modifier = modifier,
        secondaryLabel = secondaryLabel,
        enabled = enabled,
        background = MaterialTheme.colorScheme.primaryContainer,
        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        secondaryColor = MaterialTheme.colorScheme.onPrimaryContainer,
        icon = icon
    )
}

/** A rounded container. Tappable when [onClick] is given, inert otherwise. */
@Composable
fun TomeCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    background: Color = MaterialTheme.colorScheme.surfaceContainer,
    content: @Composable ColumnScope.() -> Unit
) {
    val base = modifier
        .fillMaxWidth()
        .clip(CardShape)
        .background(background)
    Column(
        modifier = (if (onClick != null) base.clickable(role = Role.Button, onClick = onClick) else base)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        content = content
    )
}

/** A flat progress bar. Draws nothing at zero — an empty track reads as broken. */
@Composable
fun LinearProgress(
    fraction: Float,
    modifier: Modifier = Modifier,
    height: Dp = 4.dp,
    track: Color = MaterialTheme.colorScheme.surfaceContainerHigh,
    indicator: Color = MaterialTheme.colorScheme.primary
) {
    val value = if (fraction.isFinite()) fraction.coerceIn(0f, 1f) else 0f
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(height / 2))
            .background(track)
    ) {
        if (value > 0f) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(value)
                    .fillMaxHeight()
                    .background(indicator)
            )
        }
    }
}

/**
 * The player's edge ring. A full circle starting at 12 o'clock, which on a round
 * watch is the one progress indicator that costs no vertical space at all.
 */
@Composable
fun ProgressArc(
    fraction: Float,
    modifier: Modifier = Modifier,
    strokeWidth: Dp = 4.dp,
    track: Color = MaterialTheme.colorScheme.surfaceContainerHigh,
    indicator: Color = MaterialTheme.colorScheme.primary
) {
    val value = if (fraction.isFinite()) fraction.coerceIn(0f, 1f) else 0f
    Canvas(modifier.fillMaxSize()) {
        val stroke = strokeWidth.toPx()
        val inset = stroke / 2f + 2f
        val arcSize = Size(size.width - inset * 2f, size.height - inset * 2f)
        val topLeft = Offset(inset, inset)
        drawArc(
            color = track,
            startAngle = -90f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = topLeft,
            size = arcSize,
            style = Stroke(width = stroke)
        )
        if (value > 0f) {
            drawArc(
                color = indicator,
                startAngle = -90f,
                sweepAngle = 360f * value,
                useCenter = false,
                topLeft = topLeft,
                size = arcSize,
                style = Stroke(width = stroke, cap = StrokeCap.Round)
            )
        }
    }
}

/** A circular tap target — the player transport and nothing else. */
@Composable
fun RoundIconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    diameter: Dp = 44.dp,
    enabled: Boolean = true,
    background: Color = MaterialTheme.colorScheme.surfaceContainerHigh,
    content: @Composable BoxScope.() -> Unit
) {
    Box(
        modifier = modifier
            .size(diameter)
            .clip(CircleShape)
            .background(background)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
        content = content
    )
}

/** A status dot — connected/disconnected in settings. */
@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier, diameter: Dp = 10.dp) {
    Box(
        modifier = modifier
            .size(diameter)
            .clip(CircleShape)
            .background(color)
    )
}

/** A tinted square standing in for a missing cover. Same shape as a real one. */
@Composable
fun CoverPlaceholder(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(8.dp),
    content: (@Composable BoxScope.() -> Unit)? = null
) {
    Box(
        modifier = modifier
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh),
        contentAlignment = Alignment.Center
    ) {
        content?.invoke(this)
    }
}
