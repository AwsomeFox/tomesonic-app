package com.tomesonic.app.widget

import android.app.Application
import android.appwidget.AppWidgetManager
import android.content.Context
import android.view.View
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import com.tomesonic.app.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * ResumeWidgetProvider reads filesDir/widget_state.json (with a fallback to
 * the .tmp file written during JS's delete-then-rename swap) and renders
 * title/author into the widget's RemoteViews. Robolectric's
 * ShadowAppWidgetManager dispatches onUpdate and applies the RemoteViews to a
 * real view hierarchy, so these tests assert what actually ends up on screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class ResumeWidgetProviderTest {

    private lateinit var context: Context
    private lateinit var manager: AppWidgetManager

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        manager = AppWidgetManager.getInstance(context)
    }

    @After
    fun tearDown() {
        stateFile().delete()
        tmpFile().delete()
    }

    private fun stateFile() = java.io.File(context.filesDir, "widget_state.json")
    private fun tmpFile() = java.io.File(context.filesDir, "widget_state.json.tmp")

    /**
     * Creates a widget bound to ResumeWidgetProvider — the shadow dispatches
     * onUpdate to the provider — and returns the applied widget view.
     */
    private fun renderWidget(): View {
        val shadowManager = shadowOf(manager)
        val id = shadowManager.createWidget(ResumeWidgetProvider::class.java, R.layout.resume_widget)
        return shadowManager.getViewFor(id)
    }

    private fun title(view: View) = view.findViewById<TextView>(R.id.widget_title).text.toString()
    private fun subtitle(view: View) = view.findViewById<TextView>(R.id.widget_subtitle).text.toString()

    @Test
    fun defaultsWhenNoStateFileExists() {
        val view = renderWidget()
        assertEquals("TomeSonic", title(view))
        assertEquals("Tap to resume listening", subtitle(view))
    }

    @Test
    fun showsTitleAndAuthorFromStateFile() {
        stateFile().writeText("""{"title":"The Hobbit","author":"J.R.R. Tolkien"}""")
        val view = renderWidget()
        assertEquals("The Hobbit", title(view))
        assertEquals("J.R.R. Tolkien", subtitle(view))
    }

    @Test
    fun fallsBackToTmpFileDuringAtomicSwap() {
        // JS swaps the state file via delete-then-rename. A widget update that
        // lands in the gap must read the fully-written .tmp file instead of
        // silently showing defaults.
        tmpFile().writeText("""{"title":"Dune","author":"Frank Herbert"}""")
        val view = renderWidget()
        assertEquals("Dune", title(view))
        assertEquals("Frank Herbert", subtitle(view))
    }

    @Test
    fun realStateFileWinsOverTmpFile() {
        stateFile().writeText("""{"title":"Current","author":"Author A"}""")
        tmpFile().writeText("""{"title":"Stale","author":"Author B"}""")
        val view = renderWidget()
        assertEquals("Current", title(view))
        assertEquals("Author A", subtitle(view))
    }

    @Test
    fun malformedJsonFallsBackToDefaults() {
        stateFile().writeText("{not valid json")
        val view = renderWidget()
        assertEquals("TomeSonic", title(view))
        assertEquals("Tap to resume listening", subtitle(view))
    }

    @Test
    fun emptyFieldsKeepDefaults() {
        stateFile().writeText("""{"title":"","author":""}""")
        val view = renderWidget()
        assertEquals("TomeSonic", title(view))
        assertEquals("Tap to resume listening", subtitle(view))
    }

    @Test
    fun titleOnlyKeepsDefaultSubtitle() {
        stateFile().writeText("""{"title":"Solo Title"}""")
        val view = renderWidget()
        assertEquals("Solo Title", title(view))
        assertEquals("Tap to resume listening", subtitle(view))
    }
}
