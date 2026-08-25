package com.tomesonic.app.wear.data

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService
import com.tomesonic.app.wear.Graph
import kotlinx.coroutines.runBlocking

/**
 * Phone -> watch credential delivery. The phone's WearBridgeModule puts one
 * DataItem at `/tomesonic/creds`; this turns it into stored credentials.
 *
 * Logout arrives as the SAME path with empty server/token (deliberately not a
 * deleteDataItems — deletion events are unreliable across reconnects), which
 * CredsRepository.applyFromDataLayer reads as clear(). Both directions go
 * through that one function so the listener and the app-open refresh can't
 * disagree about what "no creds" looks like.
 */
class DataLayerListenerService : WearableListenerService() {

    override fun onDataChanged(dataEvents: DataEventBuffer) {
        // The service can be started by the Data Layer without MainActivity ever
        // running; Application.onCreate has, but init is idempotent either way.
        Graph.init(applicationContext)
        val repo = Graph.credsRepository
        for (event in dataEvents) {
            try {
                if (event.type != DataEvent.TYPE_CHANGED) continue
                val item = event.dataItem
                if (item.uri.path != CredsRepository.CREDS_PATH) continue
                val map = DataMapItem.fromDataItem(item).dataMap
                // runBlocking, not a fire-and-forget scope: WearableListenerService
                // callbacks already run OFF the main thread and the service is
                // torn down as soon as this returns — a detached coroutine would
                // race that teardown and silently drop the write.
                runBlocking {
                    repo.applyFromDataLayer(
                        map.getString(CredsRepository.DL_KEY_SERVER),
                        map.getString(CredsRepository.DL_KEY_TOKEN),
                        map.getString(CredsRepository.DL_KEY_USER_ID),
                        map.getString(CredsRepository.DL_KEY_USERNAME)
                    )
                }
            } catch (t: Throwable) {
                // One malformed event must not abort the rest of the buffer, and
                // must never crash the app the user is listening on.
            }
        }
    }
}
