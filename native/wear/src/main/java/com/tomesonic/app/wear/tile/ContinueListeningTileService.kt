package com.tomesonic.app.wear.tile

import android.content.Context
import androidx.concurrent.futures.SuspendToFutureAdapter
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders
import androidx.wear.protolayout.DeviceParametersBuilders.DeviceParameters
import androidx.wear.protolayout.DimensionBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material.ChipColors
import androidx.wear.protolayout.material.CompactChip
import androidx.wear.protolayout.material.Text
import androidx.wear.protolayout.material.Typography
import androidx.wear.protolayout.material.layouts.PrimaryLayout
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.LaunchRequests
import com.tomesonic.app.wear.MainActivity
import com.tomesonic.app.wear.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first

/**
 * The Continue Listening tile.
 *
 * Renders in the system's tile surface, which imposes three constraints the
 * rest of the app does not have:
 *  - NO network on the render path. The whole tile comes from ONE DataStore
 *    snapshot (creds + `last_item_id`), which is why SessionManager writes the
 *    title and author alongside the id — see CredsRepository.setLastItem.
 *  - NO Compose theme. Tile renderers cannot see
 *    `ui/theme/Color.kt`, so the colours at the bottom of this file are that
 *    file's dark values repeated as literal ARGB. When the palette moves, this
 *    file moves with it.
 *  - NO app process guarantee. The system can start this service in a process
 *    where MainApplication.onCreate has never run, so [Graph.init] is called
 *    defensively here exactly as DataLayerListenerService does.
 *
 * Freshness is 0 (never poll): the only thing that changes the content is a
 * play, and SessionManager pushes that through [TileRefresh].
 */
class ContinueListeningTileService : TileService() {

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest
    ): ListenableFuture<TileBuilders.Tile> =
        // TileService speaks ListenableFuture and everything below it speaks
        // coroutines; SuspendToFutureAdapter is the one bridge. IO because both
        // reads are a DataStore file.
        SuspendToFutureAdapter.launchFuture(Dispatchers.IO) {
            val root = layout(
                context = this@ContinueListeningTileService,
                device = requestParams.deviceConfiguration,
                state = readState()
            )
            TileBuilders.Tile.Builder()
                // MUST match the version onTileResourcesRequest answers with, or
                // the renderer requests resources it then declines to use.
                .setResourcesVersion(RESOURCES_VERSION)
                // 0 = never refresh on a timer. New state arrives via TileRefresh.
                .setFreshnessIntervalMillis(0L)
                // One entry, valid forever: nothing on this tile varies with
                // time, so a single-entry timeline is the whole story.
                .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root))
                .build()
        }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest
    ): ListenableFuture<ResourceBuilders.Resources> =
        SuspendToFutureAdapter.launchFuture {
            ResourceBuilders.Resources.Builder()
                .setVersion(RESOURCES_VERSION)
                .addIdToImageMapping(
                    ID_APP_MARK,
                    ResourceBuilders.ImageResource.Builder()
                        .setAndroidResourceByResId(
                            ResourceBuilders.AndroidImageResourceByResId.Builder()
                                .setResourceId(R.drawable.ic_app_mark)
                                .build()
                        )
                        .build()
                )
                .build()
        }

    /**
     * The two facts the tile renders from. A failure here becomes a rendered
     * "connect from your phone", never a thrown future: a tile whose request
     * fails stays broken on the user's watch until something else updates it.
     */
    private suspend fun readState(): TileState = try {
        Graph.init(applicationContext)
        val repo = Graph.credsRepository
        TileState.from(
            hasCreds = repo.creds.first() != null,
            lastItem = repo.lastItem.first()
        )
    } catch (t: Throwable) {
        TileState.NotConfigured
    }
}

/**
 * Bumped only when the resource MAP changes (an id added or repointed), not
 * when the drawable's artwork changes — the renderer caches by this string.
 */
private const val RESOURCES_VERSION = "1"

/** A protolayout resource id, not an Android one; the mapping is above. */
private const val ID_APP_MARK = "app_mark"

/** Reported back in TileService.EXTRA_CLICKABLE_ID. One action, one id. */
private const val CLICK_ID = "continue_listening"

// --- colours ---------------------------------------------------------------
// ui/theme/Color.kt's DARK values as literal ARGB. `const val` cannot hold a
// `.toInt()` call, so these are plain private top-level vals.

/** TomeSonicColors.Primary — the chip fill and the app mark. */
private val COLOR_PRIMARY: Int = 0xFF86D6BF.toInt()

/** TomeSonicColors.OnPrimary — the chip's label ON that fill. */
private val COLOR_ON_PRIMARY: Int = 0xFF00382D.toInt()

/** TomeSonicColors.Background — the tile canvas. */
private val COLOR_BACKGROUND: Int = 0xFF090F0D.toInt()

/**
 * TomeSonicColors.OnSurface. Color.kt publishes no `onBackground`; the wear M3
 * scheme in ui/theme/Theme.kt maps that role onto this same value.
 */
private val COLOR_ON_BACKGROUND: Int = 0xFFDEE4E0.toInt()

/** TomeSonicColors.OnSurfaceVariant — the quieter second line. */
private val COLOR_ON_BACKGROUND_VARIANT: Int = 0xFFBFC9C4.toInt()

/**
 * The whole tile.
 *
 * PrimaryLayout with responsive insets rather than a hand-margined Column: it
 * is the component that knows how far in a ROUND screen's content has to sit,
 * and this app's watches are round. The Box around it exists only to paint the
 * app's own canvas colour under the layout — a tile draws on whatever the
 * system puts behind it otherwise.
 */
private fun layout(
    context: Context,
    device: DeviceParameters,
    state: TileState
): LayoutElementBuilders.LayoutElement {
    val content = LayoutElementBuilders.Column.Builder()
        .setWidth(DimensionBuilders.expand())
        .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
        .addContent(appMark())
        .addContent(spacer(6f))
        .addContent(
            text(
                context = context,
                value = state.primary,
                typography = Typography.TYPOGRAPHY_TITLE3,
                color = COLOR_ON_BACKGROUND,
                maxLines = 2
            )
        )

    state.secondary?.let { secondary ->
        content.addContent(spacer(2f))
        content.addContent(
            text(
                context = context,
                value = secondary,
                typography = Typography.TYPOGRAPHY_CAPTION1,
                color = COLOR_ON_BACKGROUND_VARIANT,
                maxLines = 1
            )
        )
    }

    val primaryLayout = PrimaryLayout.Builder(device)
        .setResponsiveContentInsetEnabled(true)
        .setContent(content.build())
        .setPrimaryChipContent(
            CompactChip.Builder(context, state.actionLabel, clickable(context, state), device)
                .setChipColors(ChipColors(COLOR_PRIMARY, COLOR_ON_PRIMARY))
                .setContentDescription(state.actionLabel)
                .build()
        )
        .build()

    return LayoutElementBuilders.Box.Builder()
        .setWidth(DimensionBuilders.expand())
        .setHeight(DimensionBuilders.expand())
        .setModifiers(
            ModifiersBuilders.Modifiers.Builder()
                .setBackground(
                    ModifiersBuilders.Background.Builder()
                        .setColor(ColorBuilders.argb(COLOR_BACKGROUND))
                        .build()
                )
                .build()
        )
        .addContent(primaryLayout)
        .build()
}

private fun appMark(): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Image.Builder()
        .setResourceId(ID_APP_MARK)
        .setWidth(DimensionBuilders.dp(24f))
        .setHeight(DimensionBuilders.dp(24f))
        // The drawable is a white silhouette so the complication can hand it to
        // the system for its own tinting; the tile paints it brand teal here.
        .setColorFilter(
            LayoutElementBuilders.ColorFilter.Builder()
                .setTint(ColorBuilders.argb(COLOR_PRIMARY))
                .build()
        )
        .build()

private fun spacer(dp: Float): LayoutElementBuilders.LayoutElement =
    LayoutElementBuilders.Spacer.Builder()
        .setHeight(DimensionBuilders.dp(dp))
        .build()

private fun text(
    context: Context,
    value: String,
    typography: Int,
    color: Int,
    maxLines: Int
): LayoutElementBuilders.LayoutElement =
    Text.Builder(context, value)
        .setTypography(typography)
        .setColor(ColorBuilders.argb(color))
        .setMaxLines(maxLines)
        .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER)
        .setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE)
        .build()

/**
 * The one tap. A LaunchAction, not a LoadAction: the tile has no state of its
 * own to reload — every action here opens the app, and Resume additionally
 * names what to play.
 *
 * Package and class come from the runtime rather than string literals because
 * applicationId (com.tomesonic.app) and namespace (com.tomesonic.app.wear)
 * differ in this module; a hand-written pair is the one thing that reads wrong
 * here, and a wrong one fails silently, as a tap that does nothing.
 */
private fun clickable(context: Context, state: TileState): ModifiersBuilders.Clickable {
    val activity = ActionBuilders.AndroidActivity.Builder()
        .setPackageName(context.packageName)
        .setClassName(MainActivity::class.java.name)

    if (state is TileState.Resume) {
        activity.addKeyToExtraMapping(
            LaunchRequests.EXTRA_OPEN_PLAYER,
            ActionBuilders.AndroidBooleanExtra.Builder().setValue(true).build()
        )
        activity.addKeyToExtraMapping(
            LaunchRequests.EXTRA_PLAY_ITEM,
            ActionBuilders.AndroidStringExtra.Builder().setValue(state.itemId).build()
        )
        state.episodeId?.let { episodeId ->
            activity.addKeyToExtraMapping(
                LaunchRequests.EXTRA_PLAY_EPISODE,
                ActionBuilders.AndroidStringExtra.Builder().setValue(episodeId).build()
            )
        }
    }

    return ModifiersBuilders.Clickable.Builder()
        .setId(CLICK_ID)
        .setOnClick(
            ActionBuilders.LaunchAction.Builder()
                .setAndroidActivity(activity.build())
                .build()
        )
        .build()
}
