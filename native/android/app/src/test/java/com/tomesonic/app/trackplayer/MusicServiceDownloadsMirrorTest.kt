package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * Schema contract between the JS downloads mirror writer
 * (native/store/useDownloadStore.ts, writeAutoDownloads: entries of
 * {id,title,author,folder,coverPath,currentTime,duration,
 *  tracks:[{filename,startOffset,duration}]})
 * and the native parser absRefreshDownloaded in the patched MusicService
 * (node_modules/react-native-track-player/.../service/MusicService.kt,
 * applied by patches/react-native-track-player+5.0.0-alpha0.patch).
 *
 * The parser's resilience rules matter mid-drive: JS rewrites the file every
 * ~15s while a downloaded book plays, and the JS atomic swap is
 * delete-then-rename, so the native side must (a) fall back to the fully
 * written .tmp when the main file is missing, and (b) keep the LAST GOOD map
 * on a torn/unreadable read instead of wiping the offline catalog. Legacy
 * bare-string id arrays still parse as badge-only entries.
 *
 * Harness per the sibling tests: Robolectric.buildService(...).get(), the
 * mirror written into the service's real filesDir, absRefreshDownloaded
 * invoked via reflection, and the parsed private AbsDownload map inspected
 * via reflection.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceDownloadsMirrorTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    private fun refresh() {
        val m = try {
            MusicService::class.java.getDeclaredMethod("absRefreshDownloaded")
        } catch (e: NoSuchMethodException) {
            throw AssertionError(
                "absRefreshDownloaded missing — renamed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        m.isAccessible = true
        m.invoke(service)
    }

    private fun downloads(): Map<*, *> {
        val f = MusicService::class.java.getDeclaredField("absDownloads")
        f.isAccessible = true
        return f.get(service) as Map<*, *>
    }

    private fun writeMirror(text: String, name: String = "auto_downloads.json") {
        File(service.filesDir, name).writeText(text)
    }

    private fun deleteMirror(name: String = "auto_downloads.json") {
        File(service.filesDir, name).delete()
    }

    /** Reads a field off the private AbsDownload data class. */
    private fun prop(entry: Any, name: String): Any? {
        val f = entry.javaClass.getDeclaredField(name)
        f.isAccessible = true
        return f.get(entry)
    }

    // Exactly the shape the JS writer emits (store/useDownloadStore.ts).
    private val richEntryJson = """
        [{"id":"li_abc123","title":"Project Hail Mary","author":"Andy Weir",
          "folder":"file:///data/user/0/com.tomesonic.app/files/downloads/li_abc123",
          "coverPath":"file:///data/user/0/com.tomesonic.app/files/downloads/li_abc123/cover.jpg",
          "currentTime":700.5,"duration":57855.7,
          "tracks":[
            {"filename":"Part 01.mp3","startOffset":0,"duration":28900.2},
            {"filename":"Part 02.mp3","startOffset":28900.2,"duration":28955.5}
          ]}]
    """.trimIndent()

    @Test
    fun richJsWriterEntryParsesEveryField() {
        writeMirror(richEntryJson)
        refresh()
        val map = downloads()
        assertEquals(setOf("li_abc123"), map.keys)
        val d = map["li_abc123"]!!
        assertEquals("Project Hail Mary", prop(d, "title"))
        assertEquals("Andy Weir", prop(d, "author"))
        assertEquals(
            "file:///data/user/0/com.tomesonic.app/files/downloads/li_abc123",
            prop(d, "folder")
        )
        assertEquals(
            "file:///data/user/0/com.tomesonic.app/files/downloads/li_abc123/cover.jpg",
            prop(d, "coverPath")
        )
        assertEquals(700.5, prop(d, "currentTime") as Double, 0.0)
        assertEquals(57855.7, prop(d, "duration") as Double, 0.0)
        val tracks = prop(d, "tracks") as List<*>
        assertEquals(2, tracks.size)
        assertEquals(Triple("Part 01.mp3", 0.0, 28900.2), tracks[0])
        assertEquals(Triple("Part 02.mp3", 28900.2, 28955.5), tracks[1])
    }

    @Test
    fun legacyBareStringIdParsesAsBadgeOnlyEntry() {
        writeMirror("""["legacy-id-1","legacy-id-2"]""")
        refresh()
        val map = downloads()
        assertEquals(setOf("legacy-id-1", "legacy-id-2"), map.keys)
        val d = map["legacy-id-1"]!!
        // Badge only: placeholder title, nothing to play offline.
        assertEquals("Audiobook", prop(d, "title"))
        assertNull(prop(d, "author"))
        assertNull(prop(d, "folder"))
        assertNull(prop(d, "coverPath"))
        assertTrue((prop(d, "tracks") as List<*>).isEmpty())
    }

    @Test
    fun mixedLegacyAndRichRowsCoexist() {
        writeMirror(
            """["legacy-id",{"id":"rich-id","title":"T","currentTime":1,"duration":2,"tracks":[]}]"""
        )
        refresh()
        assertEquals(setOf("legacy-id", "rich-id"), downloads().keys)
    }

    @Test
    fun tornJsonKeepsThePreviousMap() {
        writeMirror(richEntryJson)
        refresh()
        // JS mid-write: truncated array.
        writeMirror("""[{"id":"li_abc123","title":"Proj""")
        refresh()
        assertEquals(
            "a torn read must not wipe the offline catalog",
            setOf("li_abc123"),
            downloads().keys
        )
        assertEquals("Project Hail Mary", prop(downloads()["li_abc123"]!!, "title"))
    }

    @Test
    fun missingFileKeepsThePreviousMap() {
        writeMirror(richEntryJson)
        refresh()
        // The delete half of JS's delete-then-rename swap, with no .tmp yet
        // visible either: keep the last good map.
        deleteMirror()
        refresh()
        assertEquals(setOf("li_abc123"), downloads().keys)
    }

    @Test
    fun tmpFileIsReadWhenTheMainFileIsMissing() {
        // Read landing between JS's delete and rename: only the fully written
        // .tmp exists.
        deleteMirror()
        writeMirror(richEntryJson, name = "auto_downloads.json.tmp")
        refresh()
        assertEquals(setOf("li_abc123"), downloads().keys)
    }

    @Test
    fun mainFileWinsOverAStaleTmp() {
        writeMirror("""[{"id":"current","title":"T","currentTime":0,"duration":1,"tracks":[]}]""")
        writeMirror("""[{"id":"stale","title":"T","currentTime":0,"duration":1,"tracks":[]}]""",
            name = "auto_downloads.json.tmp")
        refresh()
        assertEquals(setOf("current"), downloads().keys)
    }

    @Test
    fun idLessRowsAreDroppedFromAValidParse() {
        writeMirror("""[{"title":"no id here"},{"id":"kept","title":"T","tracks":[]}]""")
        refresh()
        assertEquals(setOf("kept"), downloads().keys)
    }

    @Test
    fun emptyArrayIsAValidParseAndClearsTheMap() {
        writeMirror(richEntryJson)
        refresh()
        // Unlike a torn read, a VALID empty array is truth: everything was
        // un-downloaded.
        writeMirror("[]")
        refresh()
        assertTrue(downloads().isEmpty())
    }
}
