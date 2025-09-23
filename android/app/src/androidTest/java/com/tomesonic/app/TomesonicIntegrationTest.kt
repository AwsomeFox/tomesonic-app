package com.tomesonic.app

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.ServiceTestRule
import com.tomesonic.app.data.*
import com.tomesonic.app.media.MediaManager
import com.tomesonic.app.player.MediaBrowserManager
import com.tomesonic.app.player.PlayerNotificationService
import com.tomesonic.app.server.ApiHandler
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mock
import org.mockito.MockitoAnnotations
import org.mockito.kotlin.whenever
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Integration tests for the TomeSonic Android app components.
 * These tests run on an actual Android device or emulator.
 */
@RunWith(AndroidJUnit4::class)
class TomesonicIntegrationTest {

    @get:Rule
    val serviceRule = ServiceTestRule()

    @Mock
    private lateinit var apiHandler: ApiHandler

    private lateinit var context: Context

    @Before
    fun setUp() {
        MockitoAnnotations.openMocks(this)
        context = InstrumentationRegistry.getInstrumentation().targetContext
        
        // Verify we're testing the correct app
        assertEquals("com.tomesonic.app", context.packageName)
    }

    @Test
    fun mediaManagerIntegrationTest() {
        // Test MediaManager can be instantiated and used
        val mediaManager = MediaManager(apiHandler, context)
        
        assertNotNull(mediaManager)
        assertTrue(mediaManager.serverLibraries.isEmpty())
        assertTrue(mediaManager.serverItemsInProgress.isEmpty())
    }

    @Test
    fun libraryItemCreationTest() {
        // Test creating various library items
        val book = Book().apply {
            title = "Integration Test Book"
            author = "Test Author"
            duration = 7200.0
            chapters = listOf(
                BookChapter().apply {
                    id = "ch1"
                    title = "Chapter 1"
                    startTime = 0.0
                    endTime = 3600.0
                }
            )
        }
        
        val libraryItem = LibraryItem().apply {
            id = "test-book-1"
            mediaType = "book"
            media = book
            title = book.title
        }
        
        assertEquals("book", libraryItem.mediaType)
        assertEquals("Integration Test Book", libraryItem.title)
        assertEquals(1, (libraryItem.media as Book).chapters?.size)
    }

    @Test
    fun podcastCreationTest() {
        val episode1 = PodcastEpisode().apply {
            id = "ep1"
            title = "Episode 1"
            duration = 1800.0
        }
        
        val episode2 = PodcastEpisode().apply {
            id = "ep2"
            title = "Episode 2"
            duration = 2100.0
        }
        
        val podcast = Podcast().apply {
            title = "Integration Test Podcast"
            description = "A test podcast for integration testing"
            episodes = listOf(episode1, episode2)
        }
        
        val libraryItem = LibraryItem().apply {
            id = "test-podcast-1"
            mediaType = "podcast"
            media = podcast
            title = podcast.title
        }
        
        assertEquals("podcast", libraryItem.mediaType)
        assertEquals(2, (libraryItem.media as Podcast).episodes?.size)
    }

    @Test
    fun mediaProgressTrackingTest() {
        // Test media progress tracking functionality
        val progress = MediaProgress().apply {
            id = "progress-1"
            libraryItemId = "test-item"
            currentTime = 1500.0
            progress = 0.25
            duration = 6000.0
            isFinished = false
        }
        
        assertEquals("test-item", progress.libraryItemId)
        assertEquals(0.25, progress.progress)
        assertEquals(1500.0, progress.currentTime)
    }

    @Test
    fun libraryStatsTest() {
        val stats = LibraryStats().apply {
            totalItems = 50
            totalAuthors = 15
            totalGenres = 8
            totalDuration = 180000.0
            numAudioFiles = 200
        }
        
        val library = Library().apply {
            id = "integration-lib"
            name = "Integration Test Library"
            mediaType = "book"
            stats = stats
        }
        
        assertEquals(50, library.stats?.totalItems)
        assertEquals(200, library.stats?.numAudioFiles)
    }

    @Test
    fun collectionManagementTest() {
        val collection = Collection().apply {
            id = "test-collection"
            name = "Integration Test Collection"
            description = "Collection for testing"
        }
        
        assertEquals("test-collection", collection.id)
        assertEquals("Integration Test Collection", collection.name)
    }

    @Test
    fun localLibraryItemTest() {
        // Test local (downloaded) content handling
        val localBook = Book().apply {
            title = "Downloaded Book"
            duration = 4500.0
        }
        
        val localItem = LocalLibraryItem().apply {
            id = "local-book-1"
            mediaType = "book"
            media = localBook
            title = localBook.title
        }
        
        assertEquals("book", localItem.mediaType)
        assertEquals("Downloaded Book", localItem.title)
    }

    @Test
    fun userProgressTest() {
        val userProgress = UserProgress().apply {
            libraryItemId = "test-book"
            currentTime = 3000.0
            progress = 0.6
            isFinished = false
            lastUpdate = System.currentTimeMillis()
        }
        
        assertEquals("test-book", userProgress.libraryItemId)
        assertEquals(0.6, userProgress.progress)
        assertTrue(userProgress.lastUpdate > 0)
    }

    @Test
    fun mediaManagerWithMockDataTest() {
        // Test MediaManager with some mock data
        val mediaManager = MediaManager(apiHandler, context)
        
        // Mock some library data
        val library = Library().apply {
            id = "mock-lib-1"
            name = "Mock Library"
            mediaType = "book"
        }
        
        mediaManager.serverLibraries.add(library)
        
        assertEquals(1, mediaManager.serverLibraries.size)
        assertEquals("Mock Library", mediaManager.serverLibraries[0].name)
    }

    @Test
    fun authorDataTest() {
        val author = Author().apply {
            id = "author-1"
            name = "John Smith"
            libraryId = "lib-1"
        }
        
        assertEquals("John Smith", author.name)
        assertEquals("lib-1", author.libraryId)
    }
}
