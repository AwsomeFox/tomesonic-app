package com.tomesonic.app.wear.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material3.Text

// Every icon in the watch app, drawn.
//
// :wear declares no icon dependency (no material-icons-*, no vector drawables of
// its own — see build.gradle), and adding one to draw eleven small shapes would
// pull a several-thousand-icon artifact into a watch APK. These are plain
// Canvas paths on a unit square, so they scale to any size, tint from the theme,
// and cost nothing at build time.
//
// All coordinates are FRACTIONS of the glyph box (0..1), which is what keeps a
// 16dp list icon and a 30dp transport icon the same drawing.

/** Fractional point -> a real Offset inside this glyph's box. */
private fun DrawScope.at(x: Float, y: Float): Offset = Offset(size.width * x, size.height * y)

/** Stroke width as a fraction of the box, so weight scales with the icon. */
private fun DrawScope.weight(fraction: Float = 0.1f): Float = size.width * fraction

private fun DrawScope.polyline(color: Color, fraction: Float, vararg points: Pair<Float, Float>) {
    val width = weight(fraction)
    for (i in 0 until points.size - 1) {
        drawLine(
            color = color,
            start = at(points[i].first, points[i].second),
            end = at(points[i + 1].first, points[i + 1].second),
            strokeWidth = width,
            cap = StrokeCap.Round
        )
    }
}

private fun DrawScope.triangle(color: Color, vararg points: Pair<Float, Float>) {
    val path = Path()
    points.forEachIndexed { index, point ->
        val offset = at(point.first, point.second)
        if (index == 0) path.moveTo(offset.x, offset.y) else path.lineTo(offset.x, offset.y)
    }
    path.close()
    drawPath(path, color)
}

@Composable
fun PlayGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 24.dp) {
    Canvas(modifier.size(dim)) {
        triangle(tint, 0.28f to 0.16f, 0.84f to 0.5f, 0.28f to 0.84f)
    }
}

@Composable
fun PauseGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 24.dp) {
    Canvas(modifier.size(dim)) {
        val barWidth = size.width * 0.16f
        val top = size.height * 0.18f
        val height = size.height * 0.64f
        val radius = CornerRadius(barWidth * 0.4f, barWidth * 0.4f)
        drawRoundRect(tint, Offset(size.width * 0.26f, top), Size(barWidth, height), radius)
        drawRoundRect(tint, Offset(size.width * 0.58f, top), Size(barWidth, height), radius)
    }
}

/** ±30s: a broken circle with an arrowhead, "30" in the middle — the phone's idiom. */
@Composable
fun SeekGlyph(forward: Boolean, tint: Color, modifier: Modifier = Modifier, dim: Dp = 28.dp) {
    Box(modifier.size(dim), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val inset = size.width * 0.08f
            drawArc(
                color = tint,
                // Compose measures clockwise from 3 o'clock: this leaves an 80°
                // gap centred on 12 o'clock for the arrowhead to sit in.
                startAngle = -50f,
                sweepAngle = 280f,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = Size(size.width - inset * 2f, size.height - inset * 2f),
                style = Stroke(width = size.width * 0.09f, cap = StrokeCap.Round)
            )
            if (forward) {
                triangle(tint, 0.60f to 0.02f, 0.88f to 0.17f, 0.60f to 0.32f)
            } else {
                triangle(tint, 0.40f to 0.02f, 0.12f to 0.17f, 0.40f to 0.32f)
            }
        }
        Text(text = "30", color = tint, fontSize = 9.sp)
    }
}

@Composable
fun ChapterGlyph(forward: Boolean, tint: Color, modifier: Modifier = Modifier, dim: Dp = 22.dp) {
    Canvas(modifier.size(dim)) {
        val barWidth = size.width * 0.13f
        val top = size.height * 0.22f
        val height = size.height * 0.56f
        val radius = CornerRadius(barWidth * 0.4f, barWidth * 0.4f)
        if (forward) {
            triangle(tint, 0.16f to 0.22f, 0.62f to 0.5f, 0.16f to 0.78f)
            drawRoundRect(tint, Offset(size.width * 0.70f, top), Size(barWidth, height), radius)
        } else {
            triangle(tint, 0.84f to 0.22f, 0.38f to 0.5f, 0.84f to 0.78f)
            drawRoundRect(tint, Offset(size.width * 0.17f, top), Size(barWidth, height), radius)
        }
    }
}

/** An open book — the mediaType marker for a book library, and half the app mark. */
@Composable
fun BookGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 20.dp) {
    Canvas(modifier.size(dim)) {
        polyline(
            tint, 0.09f,
            0.50f to 0.30f, 0.30f to 0.20f, 0.10f to 0.22f, 0.10f to 0.74f,
            0.30f to 0.72f, 0.50f to 0.82f
        )
        polyline(
            tint, 0.09f,
            0.50f to 0.30f, 0.70f to 0.20f, 0.90f to 0.22f, 0.90f to 0.74f,
            0.70f to 0.72f, 0.50f to 0.82f
        )
    }
}

/** A microphone — the mediaType marker for a podcast library. */
@Composable
fun PodcastGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 20.dp) {
    Canvas(modifier.size(dim)) {
        val capsuleWidth = size.width * 0.26f
        drawRoundRect(
            color = tint,
            topLeft = Offset(size.width * 0.37f, size.height * 0.12f),
            size = Size(capsuleWidth, size.height * 0.44f),
            cornerRadius = CornerRadius(capsuleWidth / 2f, capsuleWidth / 2f)
        )
        val inset = size.width * 0.22f
        drawArc(
            color = tint,
            startAngle = 0f,
            sweepAngle = 180f,
            useCenter = false,
            topLeft = Offset(inset, size.height * 0.30f),
            size = Size(size.width - inset * 2f, size.height * 0.44f),
            style = Stroke(width = size.width * 0.09f, cap = StrokeCap.Round)
        )
        polyline(tint, 0.09f, 0.50f to 0.74f, 0.50f to 0.90f)
    }
}

@Composable
fun DownloadGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 20.dp) {
    Canvas(modifier.size(dim)) {
        polyline(tint, 0.1f, 0.50f to 0.12f, 0.50f to 0.62f)
        polyline(tint, 0.1f, 0.28f to 0.42f, 0.50f to 0.64f, 0.72f to 0.42f)
        polyline(tint, 0.1f, 0.20f to 0.86f, 0.80f to 0.86f)
    }
}

/** "This is on the watch" — a check over the same baseline as [DownloadGlyph]. */
@Composable
fun DownloadedGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 20.dp) {
    Canvas(modifier.size(dim)) {
        polyline(tint, 0.1f, 0.24f to 0.42f, 0.44f to 0.62f, 0.78f to 0.18f)
        polyline(tint, 0.1f, 0.20f to 0.86f, 0.80f to 0.86f)
    }
}

@Composable
fun TrashGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 20.dp) {
    Canvas(modifier.size(dim)) {
        polyline(tint, 0.09f, 0.16f to 0.28f, 0.84f to 0.28f)
        polyline(tint, 0.09f, 0.38f to 0.28f, 0.38f to 0.16f, 0.62f to 0.16f, 0.62f to 0.28f)
        polyline(tint, 0.09f, 0.26f to 0.34f, 0.30f to 0.86f, 0.70f to 0.86f, 0.74f to 0.34f)
    }
}

/** Sliders, not a gear: three strokes read at 20dp where a cog's teeth do not. */
@Composable
fun SettingsGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 20.dp) {
    Canvas(modifier.size(dim)) {
        val knob = size.width * 0.09f
        polyline(tint, 0.08f, 0.14f to 0.26f, 0.86f to 0.26f)
        polyline(tint, 0.08f, 0.14f to 0.50f, 0.86f to 0.50f)
        polyline(tint, 0.08f, 0.14f to 0.74f, 0.86f to 0.74f)
        drawCircle(tint, knob, at(0.66f, 0.26f))
        drawCircle(tint, knob, at(0.34f, 0.50f))
        drawCircle(tint, knob, at(0.58f, 0.74f))
    }
}

@Composable
fun ChevronGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 14.dp) {
    Canvas(modifier.size(dim)) {
        polyline(tint, 0.14f, 0.36f to 0.18f, 0.68f to 0.5f, 0.36f to 0.82f)
    }
}

/** Sync — the same broken circle as [SeekGlyph] with no number in it. */
@Composable
fun RefreshGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 20.dp) {
    Canvas(modifier.size(dim)) {
        val inset = size.width * 0.12f
        drawArc(
            color = tint,
            startAngle = -50f,
            sweepAngle = 280f,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = Size(size.width - inset * 2f, size.height - inset * 2f),
            style = Stroke(width = size.width * 0.1f, cap = StrokeCap.Round)
        )
        triangle(tint, 0.58f to 0.00f, 0.90f to 0.16f, 0.58f to 0.32f)
    }
}

/** A magnifier — the Search chip on home and on every library screen. */
@Composable
fun SearchGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 20.dp) {
    Canvas(modifier.size(dim)) {
        drawCircle(
            color = tint,
            radius = size.width * 0.28f,
            center = at(0.42f, 0.42f),
            style = Stroke(width = weight(0.1f), cap = StrokeCap.Round)
        )
        // The handle starts just clear of the rim: drawn from the centre it
        // would show through the glass at small sizes.
        polyline(tint, 0.1f, 0.63f to 0.63f, 0.86f to 0.86f)
    }
}

/**
 * The TomeSonic mark: the phone's launcher icon — an open book with a play
 * triangle in the fold — rebuilt from the same primitives as everything else.
 */
@Composable
fun AppMarkGlyph(tint: Color, modifier: Modifier = Modifier, dim: Dp = 48.dp) {
    Box(modifier.size(dim), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            polyline(
                tint, 0.075f,
                0.50f to 0.26f, 0.28f to 0.15f, 0.07f to 0.18f, 0.07f to 0.78f,
                0.28f to 0.75f, 0.50f to 0.86f
            )
            polyline(
                tint, 0.075f,
                0.50f to 0.26f, 0.72f to 0.15f, 0.93f to 0.18f, 0.93f to 0.78f,
                0.72f to 0.75f, 0.50f to 0.86f
            )
            triangle(tint, 0.40f to 0.38f, 0.66f to 0.53f, 0.40f to 0.68f)
        }
    }
}
