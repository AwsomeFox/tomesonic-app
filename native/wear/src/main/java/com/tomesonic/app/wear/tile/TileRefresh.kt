package com.tomesonic.app.wear.tile

import android.content.Context
import androidx.wear.tiles.TileService

/**
 * "The last-played book changed; redraw the tile."
 *
 * The tile's freshness interval is 0 — it never polls — so this push is the ONLY
 * thing that moves it off a stale book. Playback calls it after
 * `CredsRepository.setLastItem` (see SessionManager.play).
 *
 * Every failure is swallowed, deliberately and without a log line at the call
 * site: the overwhelmingly common "failure" is a watch that has simply never
 * added the tile, which is not a problem to report. The rest (no tile service
 * on the device, a dead binder to the tile host, a SecurityException from a
 * system update mid-call) are all equally not worth interrupting playback for.
 */
object TileRefresh {

    fun requestUpdate(context: Context) {
        try {
            TileService.getUpdater(context.applicationContext)
                .requestUpdate(ContinueListeningTileService::class.java)
        } catch (t: Throwable) {
            // See above: nothing here is worth a crash on the playback path.
        }
    }
}
