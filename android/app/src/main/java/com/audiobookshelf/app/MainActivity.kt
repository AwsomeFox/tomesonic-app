package com.audiobookshelf.app

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.view.WindowInsets
import androidx.core.view.WindowCompat
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.view.updateLayoutParams
import com.anggrayudi.storage.SimpleStorage
import com.anggrayudi.storage.SimpleStorageHelper
import com.audiobookshelf.app.managers.DbManager
import com.audiobookshelf.app.player.service.AudiobookMediaService
import com.audiobookshelf.app.plugins.AbsAudioPlayer
import com.audiobookshelf.app.plugins.AbsDatabase
import com.audiobookshelf.app.plugins.AbsDownloader
import com.audiobookshelf.app.plugins.AbsFileSystem
import com.audiobookshelf.app.plugins.AbsLogger
// import com.audiobookshelf.app.plugins.AbsToast
import com.audiobookshelf.app.plugins.DynamicColorPlugin
import com.getcapacitor.BridgeActivity


class MainActivity : BridgeActivity() {
  private val tag = "MainActivity"

  private var mBounded = false
  lateinit var foregroundService : AudiobookMediaService
  private lateinit var mConnection : ServiceConnection

  lateinit var pluginCallback : () -> Unit

  val storageHelper = SimpleStorageHelper(this)
  val storage = SimpleStorage(this)

  val REQUEST_PERMISSIONS = 1
  var PERMISSIONS_ALL = arrayOf(
    Manifest.permission.READ_EXTERNAL_STORAGE
  )

  public override fun onCreate(savedInstanceState: Bundle?) {
    DbManager.initialize(applicationContext)

    registerPlugin(AbsAudioPlayer::class.java)
    registerPlugin(AbsDownloader::class.java)
    registerPlugin(AbsFileSystem::class.java)
    registerPlugin(AbsDatabase::class.java)
    registerPlugin(AbsLogger::class.java)
    // registerPlugin(AbsToast::class.java)
    registerPlugin(DynamicColorPlugin::class.java)

    super.onCreate(savedInstanceState)
    Log.d(tag, "onCreate")

  // Enable edge-to-edge so the webview can render behind the system bars.
  // See: https://developer.android.com/develop/ui/views/layout/edge-to-edge
  WindowCompat.setDecorFitsSystemWindows(window, false)
    val webView: WebView = findViewById(R.id.webview)
    // Keep injecting CSS safe-area insets but DO NOT add margins so the webview
    // content draws behind the system bars (transparent nav/status bar)
    webView.setOnApplyWindowInsetsListener { v, insets ->
      val (left, top, right, bottom) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val sysInsets = insets.getInsets(WindowInsets.Type.systemBars())
        Log.d(tag, "safe sysInsets: $sysInsets")
        arrayOf(sysInsets.left, sysInsets.top, sysInsets.right, sysInsets.bottom)
      } else {
        arrayOf(
          insets.systemWindowInsetLeft,
          insets.systemWindowInsetTop,
          insets.systemWindowInsetRight,
          insets.systemWindowInsetBottom
        )
      }

      // Inject as CSS variables so Nuxt pages can use env(safe-area-inset-*) or
      // the --safe-area-inset-* variables for layout while content stays full-bleed.
      val js = """
       document.documentElement.style.setProperty('--safe-area-inset-top', '${top}px');
       document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottom}px');
       document.documentElement.style.setProperty('--safe-area-inset-left', '${left}px');
       document.documentElement.style.setProperty('--safe-area-inset-right', '${right}px');
       document.documentElement.setAttribute('data-safe-area-ready', 'true');
       console.log('[Android] Set safe area insets - top: ${top}px, bottom: ${bottom}px');
      """.trimIndent()
      webView.evaluateJavascript(js, null)

      // Do not consume insets so underlying handling remains intact on older SDKs
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        insets
      } else {
        insets
      }
    }

    val permission = ActivityCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE)
    if (permission != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this,
        PERMISSIONS_ALL,
        REQUEST_PERMISSIONS)
    }
  }

  override fun onDestroy() {
    super.onDestroy()
  }

  override fun onStart() {
    super.onStart()
    Log.d(tag, "onStart MainActivity")
    // Additional sync point for when activity becomes visible
    if (::foregroundService.isInitialized) {
      try {
        val absAudioPlayer = bridge.getPlugin("AbsAudioPlayer").instance as AbsAudioPlayer
        absAudioPlayer.syncCurrentPlaybackStateWhenReady()
      } catch (e: Exception) {
        Log.e(tag, "Failed to sync playback state on start: ${e.message}")
      }
    }
  }

  override fun onResume() {
    super.onResume()
    Log.d(tag, "onResume MainActivity")
    // Trigger UI sync when app comes to foreground, waiting for UI to be ready
    if (::foregroundService.isInitialized) {
      try {
        val absAudioPlayer = bridge.getPlugin("AbsAudioPlayer").instance as AbsAudioPlayer
        // Only sync if there's already an active session - don't trigger restoration on resume
        if (foregroundService.currentPlaybackSession != null) {
          Log.d(tag, "Active session exists, syncing playback state on resume")
          absAudioPlayer.syncCurrentPlaybackStateWhenReady() // Smart sync that waits for readiness
        } else {
          Log.d(tag, "No active session, skipping sync on resume to avoid interfering with automatic restoration")
        }
        Log.d(tag, "AABrowser: Calling forceAndroidAutoReload on app resume")
        foregroundService.forceAndroidAutoReload()
      } catch (e: Exception) {
        Log.e(tag, "Failed to sync playback state on resume: ${e.message}")
      }
    }

    // Ensure safe area insets are set when app resumes
    updateSafeAreaInsets()
  }

  private fun updateSafeAreaInsets() {
    val webView: WebView = findViewById(R.id.webview)
    val insets = webView.rootWindowInsets
    if (insets != null) {
      val (left, top, right, bottom) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val sysInsets = insets.getInsets(WindowInsets.Type.systemBars())
        Log.d(tag, "updateSafeAreaInsets sysInsets: $sysInsets")
        arrayOf(sysInsets.left, sysInsets.top, sysInsets.right, sysInsets.bottom)
      } else {
        arrayOf(
          insets.systemWindowInsetLeft,
          insets.systemWindowInsetTop,
          insets.systemWindowInsetRight,
          insets.systemWindowInsetBottom
        )
      }

      // Inject as CSS variables so Nuxt pages can use env(safe-area-inset-*) or
      // the --safe-area-inset-* variables for layout while content stays full-bleed.
      val js = """
       document.documentElement.style.setProperty('--safe-area-inset-top', '${top}px');
       document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottom}px');
       document.documentElement.style.setProperty('--safe-area-inset-left', '${left}px');
       document.documentElement.style.setProperty('--safe-area-inset-right', '${right}px');
      """.trimIndent()
      webView.evaluateJavascript(js, null)
    }
  }

  override fun onPostCreate(savedInstanceState: Bundle?) {
    super.onPostCreate(savedInstanceState)
    Log.d(tag, "onPostCreate MainActivity")

    mConnection = object : ServiceConnection {
      override fun onServiceDisconnected(name: ComponentName) {
        Log.w(tag, "Service Disconnected $name")
        mBounded = false
      }

      override fun onServiceConnected(name: ComponentName, service: IBinder) {
        Log.d(tag, "Service Connected $name")

        mBounded = true
        val mLocalBinder = service as AudiobookMediaService.LocalBinder
        foregroundService = mLocalBinder.getService()

        // Let NativeAudio know foreground service is ready and setup event listener
        pluginCallback()

        // Also trigger UI sync when service connects on activity creation
        try {
          val absAudioPlayer = bridge.getPlugin("AbsAudioPlayer").instance as AbsAudioPlayer
          absAudioPlayer.syncCurrentPlaybackStateWhenReady() // Smart sync that waits for readiness

          // Add a fallback sync for fresh installs/updates where timing might be critical
          Handler(Looper.getMainLooper()).post {
            try {
              Log.d(tag, "Fallback sync attempt after service connection")
              absAudioPlayer.syncCurrentPlaybackStateWhenReady()
            } catch (e: Exception) {
              Log.e(tag, "Fallback sync failed: ${e.message}")
            }
          }

        } catch (e: Exception) {
          Log.e(tag, "Failed to sync playback state on service connect: ${e.message}")
        }
      }
    }

    Intent(this, AudiobookMediaService::class.java).also { intent ->
      Log.d(tag, "Binding AudiobookMediaService")
      bindService(intent, mConnection, Context.BIND_AUTO_CREATE)
    }
  }

  fun isPlayerNotificationServiceInitialized():Boolean {
    return ::foregroundService.isInitialized
  }

  fun stopMyService() {
    if (mBounded) {
      mConnection.let { unbindService(it) };
      mBounded = false;
    }
    val stopIntent = Intent(this, AudiobookMediaService::class.java)
    stopService(stopIntent)
  }

  override fun onSaveInstanceState(outState: Bundle) {
    storageHelper.onSaveInstanceState(outState)
    super.onSaveInstanceState(outState)
    outState.clear()
  }

  override fun onRestoreInstanceState(savedInstanceState: Bundle) {
    super.onRestoreInstanceState(savedInstanceState)
    storageHelper.onRestoreInstanceState(savedInstanceState)
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    // Mandatory for Activity, but not for Fragment & ComponentActivity
    storageHelper.storage.onActivityResult(requestCode, resultCode, data)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    Log.d(tag, "onRequestPermissionResult $requestCode")
    permissions.forEach { Log.d(tag, "PERMISSION $it") }
    grantResults.forEach { Log.d(tag, "GRANTREUSLTS $it") }
    // Mandatory for Activity, but not for Fragment & ComponentActivity
    storageHelper.onRequestPermissionsResult(requestCode, permissions, grantResults)
  }
}
