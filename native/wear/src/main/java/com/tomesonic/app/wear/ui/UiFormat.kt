package com.tomesonic.app.wear.ui

import com.tomesonic.app.wear.Formatters

/**
 * Every string the UI derives from a number, in one place with no Android types
 * — same reasoning as [Formatters], which this deliberately reuses rather than
 * re-implements: two clock formatters would drift.
 *
 * Digits are assembled by hand for the same reason [Formatters] does it: a
 * String.format with the platform locale renders non-ASCII digits on some
 * watches, and a size that reads "١.٢ GB" next to an ASCII title is worse than
 * plain.
 */
object UiFormat {

    private const val KB = 1024.0
    private const val MB = KB * 1024.0
    private const val GB = MB * 1024.0

    /**
     * Bytes -> a human size with ONE decimal below 10 units ("1.2 GB", "18 MB").
     * Storage numbers on a watch get about six characters of room, so the unit
     * steps up as early as it honestly can and precision drops as soon as the
     * mantissa has two digits of its own.
     */
    fun bytes(value: Long): String {
        if (value <= 0L) return "0 MB"
        val (scaled, unit) = when {
            value >= GB -> value / GB to "GB"
            value >= MB -> value / MB to "MB"
            value >= KB -> value / KB to "KB"
            else -> return "$value B"
        }
        return "${decimal(scaled)} $unit"
    }

    /** One decimal under 10, none at or above it — "9.4 MB", "18 MB". */
    private fun decimal(value: Double): String {
        if (value >= 10.0) return value.toLong().toString()
        val tenths = Math.round(value * 10.0)
        val whole = tenths / 10L
        val fraction = tenths % 10L
        return if (fraction == 0L) whole.toString() else "$whole.$fraction"
    }

    /** 0..1 -> "42%". Null for no progress at all, so a row can omit the label. */
    fun percent(fraction: Double?): String? {
        val f = fraction ?: return null
        if (!f.isFinite() || f <= 0.0) return null
        return "${Math.round(f.coerceIn(0.0, 1.0) * 100.0)}%"
    }

    /** Seconds (ABS's unit everywhere) -> the shared H:MM:SS clock. */
    fun secondsToClock(seconds: Double): String =
        Formatters.msToClock(if (seconds.isFinite() && seconds > 0.0) (seconds * 1000.0).toLong() else 0L)

    /**
     * A duration as prose — "11h 4m", "48m". The item screen has room for a
     * total but not for a running clock, and "11:04:37" reads as a position.
     */
    fun durationWords(seconds: Double): String {
        if (!seconds.isFinite() || seconds <= 0.0) return ""
        val total = seconds.toLong()
        val hours = total / 3600L
        val minutes = (total % 3600L) / 60L
        return when {
            hours > 0L && minutes > 0L -> "${hours}h ${minutes}m"
            hours > 0L -> "${hours}h"
            minutes > 0L -> "${minutes}m"
            else -> "<1m"
        }
    }

    /**
     * `https://abs.example.com:13378/` -> `abs.example.com:13378`.
     *
     * The settings screen shows WHICH server the watch is talking to, and on a
     * 1.2" screen the scheme is six wasted characters. The port stays: a
     * self-hosted ABS is far more often distinguished by its port than by its
     * host.
     */
    fun hostOnly(server: String): String {
        val trimmed = server.trim()
        val withoutScheme = trimmed
            .removePrefix("https://")
            .removePrefix("http://")
        val end = withoutScheme.indexOf('/')
        val host = if (end >= 0) withoutScheme.substring(0, end) else withoutScheme
        return host.ifEmpty { trimmed }
    }
}
