package com.tomesonic.app.widget

import android.content.Intent
import android.widget.RemoteViewsService

// Hosts the home-row widget's list factory.
class HomeRowWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory {
        return HomeRowRemoteViewsFactory(applicationContext, intent)
    }
}
