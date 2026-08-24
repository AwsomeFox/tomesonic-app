package com.tomesonic.app.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.tomesonic.app.wear.ui.WearApp

/**
 * The whole watch UI is [WearApp]; this class exists to host it.
 *
 * Nothing is constructed here on purpose. The two things that must outlive a
 * screen — the MediaController wrapper and Coil's ImageLoader — belong to
 * `RootViewModel`, which is scoped to this Activity's ViewModelStore: that
 * survives configuration changes (which an Activity does not) and releases the
 * controller in `onCleared`, after the last screen is gone.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { WearApp() }
    }
}
