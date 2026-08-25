package com.tomesonic.app.wear.ui.components

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.tomesonic.app.wear.Graph
import java.io.File

/**
 * The ONE Coil ImageLoader for the whole app, provided from the root so every
 * cover request — home, library rows, item, player backdrop, downloads —
 * travels on [com.tomesonic.app.wear.data.AbsClient.client].
 *
 * That client is the only place a Bearer token is attached (its interceptor
 * decorates requests to our server and nothing else), so a cover fetched with
 * any other loader is a 401 with no way to recover. Null means the root hasn't
 * provided one yet, which renders as the placeholder rather than as a crash.
 */
val LocalCoverLoader = staticCompositionLocalOf<ImageLoader?> { null }

/** Built once, in the root ViewModel — Coil caches per loader, not per request. */
fun buildCoverLoader(context: Context): ImageLoader =
    ImageLoader.Builder(context.applicationContext)
        .okHttpClient(Graph.absClient.client)
        .crossfade(true)
        .build()

/** The contract's cover width. One size everywhere keeps Coil's cache hitting. */
const val COVER_WIDTH_PX = 240

/**
 * What to hand Coil for an item: the downloaded cover when the watch has one
 * (it renders with no network and no token), otherwise the server's cover URL.
 *
 * A local path is wrapped in a File rather than concatenated into a `file://`
 * string — Coil takes a File directly, and hand-building that URI is how a path
 * with a space stops resolving.
 */
fun coverModel(coverPath: String?, itemId: String?, width: Int = COVER_WIDTH_PX): Any? {
    val path = coverPath?.trim().orEmpty()
    if (path.isNotEmpty()) {
        if (path.startsWith("file://") || path.startsWith("content://") ||
            path.startsWith("http://") || path.startsWith("https://")
        ) {
            return path
        }
        return File(path)
    }
    val id = itemId?.takeIf { it.isNotBlank() } ?: return null
    return Graph.absApi.coverUrl(id, width)
}

/**
 * A cover, or the tinted box that stands in for one. The placeholder is the
 * container itself (a surface-tinted Box behind the image) rather than a Coil
 * placeholder painter, so an empty model, a loading request and a failed fetch
 * all look the same instead of flickering between three states.
 */
@Composable
fun CoverImage(
    model: Any?,
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(8.dp),
    contentScale: ContentScale = ContentScale.Crop,
    alpha: Float = 1f,
    placeholderContent: (@Composable () -> Unit)? = null
) {
    CoverPlaceholder(modifier = modifier, shape = shape) {
        val loader = LocalCoverLoader.current
        if (model != null && loader != null) {
            val context = LocalContext.current
            val request = remember(model, context) {
                ImageRequest.Builder(context)
                    .data(model)
                    .crossfade(true)
                    .build()
            }
            AsyncImage(
                model = request,
                contentDescription = null,
                imageLoader = loader,
                modifier = Modifier.fillMaxSize(),
                contentScale = contentScale,
                alpha = alpha
            )
        } else if (placeholderContent != null) {
            Box { placeholderContent() }
        }
    }
}
