package com.tomesonic.app.wear.complication

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.data.SmallImage
import androidx.wear.watchface.complications.data.SmallImageComplicationData
import androidx.wear.watchface.complications.data.SmallImageType
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import com.tomesonic.app.wear.LaunchRequests
import com.tomesonic.app.wear.MainActivity
import com.tomesonic.app.wear.R

/**
 * "Resume" on the watch face — one tap from any face straight into the player.
 *
 * DELIBERATELY STATIC. The text never changes and no data is read, which is why
 * the manifest declares `UPDATE_PERIOD_SECONDS` 0: a complication that showed
 * the current book's title would have to be refreshed on every play, every
 * progress sync and every logout, and a watch face renders several of these at
 * once. The tile is where the book's name belongs; this is a button.
 *
 * Being static is also what makes it correct with no credentials: the tap opens
 * the app, and the app decides between the player and the connect screen from
 * state this service would only be guessing at.
 *
 * Extends the ktx SuspendingComplicationDataSourceService for uniformity with
 * the rest of the module even though nothing here suspends — the non-suspending
 * base hands back a listener to call, which is a second way to get it wrong.
 */
class ResumeComplicationService : SuspendingComplicationDataSourceService() {

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? =
        complication(request.complicationType)

    /**
     * The watch face editor's preview. Identical to the live data on purpose:
     * anything else would show the user a chooser entry that does not match what
     * they get when they pick it.
     */
    override fun getPreviewData(type: ComplicationType): ComplicationData? = complication(type)

    /**
     * Null for every type the manifest does not advertise. The system only asks
     * for SUPPORTED_TYPES, but a face that asks for something else must get "I
     * have nothing" rather than a wrongly-shaped payload.
     */
    private fun complication(type: ComplicationType): ComplicationData? = when (type) {
        ComplicationType.SHORT_TEXT -> ShortTextComplicationData.Builder(
            PlainComplicationText.Builder(TEXT).build(),
            PlainComplicationText.Builder(CONTENT_DESCRIPTION).build()
        )
            .setTitle(PlainComplicationText.Builder(TITLE).build())
            .setTapAction(tapAction())
            .build()

        // ICON, not PHOTO: the app mark is a flat white silhouette, so the face
        // may recolour it to whatever its own scheme wants. A PHOTO would be
        // rendered as-is and go invisible on a light face.
        ComplicationType.SMALL_IMAGE -> SmallImageComplicationData.Builder(
            SmallImage.Builder(
                Icon.createWithResource(this, R.drawable.ic_app_mark),
                SmallImageType.ICON
            ).build(),
            PlainComplicationText.Builder(CONTENT_DESCRIPTION).build()
        )
            .setTapAction(tapAction())
            .build()

        else -> null
    }

    /**
     * Straight to the player, via the same one-shot holder the tile uses.
     *
     * FLAG_IMMUTABLE is required from API 31 and correct everywhere: nothing
     * outside this app has any business rewriting where this intent points.
     * SINGLE_TOP is what lets a tap on a watch that is already showing the app
     * arrive at MainActivity.onNewIntent instead of stacking a second copy.
     */
    private fun tapAction(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            // No item id: this complication does not read the resume pointer, so
            // "open the player" is the whole request — the app resumes whatever
            // its own state says is current.
            .putExtra(LaunchRequests.EXTRA_OPEN_PLAYER, true)
        return PendingIntent.getActivity(
            this,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    private companion object {
        /** SHORT_TEXT is a ~7 character slot on most faces; this is the whole budget. */
        const val TEXT = "Resume"
        const val TITLE = "TomeSonic"
        const val CONTENT_DESCRIPTION = "Resume listening in TomeSonic"

        /** One action, one request code — updates replace rather than accumulate. */
        const val REQUEST_CODE = 0
    }
}
