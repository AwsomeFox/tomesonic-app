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
import com.tomesonic.app.testutils.TestDataFactory
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
        // Test creating various library items using test factory
        val book = TestDataFactory.createTestBook(
            title = "Integration Test Book",
            author = "Test Author",
            duration = 7200.0,
            numChapters = 1
        )
        
        val libraryItem = TestDataFactory.createTestLibraryItem(
            id = "test-book-1",
            title = book.metadata.title,
            mediaType = "book",
            media = book
        )
        
        assertEquals("book", libraryItem.mediaType)
        assertEquals("Integration Test Book", libraryItem.title)
        assertEquals(1, (libraryItem.media as Book).chapters?.size)
    }

    @Test
    fun podcastCreationTest() {
        val podcast = TestDataFactory.createTestPodcast(
            title = "Integration Test Podcast",
            numEpisodes = 2
        )
        
        val libraryItem = TestDataFactory.createTestLibraryItem(
            id = "test-podcast-1",
            title = podcast.metadata.title,
            mediaType = "podcast",
            media = podcast
        )
        
        assertEquals("podcast", libraryItem.mediaType)
        assertEquals(2, (libraryItem.media as Podcast).episodes?.size)
    }

    @Test
    fun mediaProgressTrackingTest() {
        // Test media progress tracking functionality
        val progress = TestDataFactory.createTestMediaProgress(
            libraryItemId = "test-item",
            currentTime = 1500.0,
            progress = 0.25,
            duration = 6000.0,
            isFinished = false
        )
        
        assertEquals("test-item", progress.libraryItemId)
        assertEquals(0.25, progress.progress)
        assertEquals(1500.0, progress.currentTime)
    }

    @Test
    fun libraryStatsTest() {
        val library = TestDataFactory.createTestLibrary(
            id = "integration-lib",
            name = "Integration Test Library",
            mediaType = "book",
            numItems = 50
        )
        
        assertEquals(50, library.stats?.totalItems)
        assertEquals(750, library.stats?.numAudioFiles)
    }

    @Test
    fun collectionManagementTest() {
        val collection = TestDataFactory.createTestCollection(
            id = "test-collection",
            name = "Integration Test Collection",
            description = "Collection for testing"
        )
        
        assertEquals("test-collection", collection.id)
        assertEquals("Integration Test Collection", collection.name)
    }

    @Test
    fun localLibraryItemTest() {
        // Test local (downloaded) content handling
        val localItem = TestDataFactory.createTestLocalLibraryItem(
            id = "local-book-1",
            title = "Downloaded Book",
            mediaType = "book"
        )
        
        assertEquals("book", localItem.mediaType)
        assertEquals("Downloaded Book", localItem.title)
        assertTrue(localItem.isLocal)
    }

    @Test
    fun mediaManagerWithMockDataTest() {
        // Test MediaManager with some mock data
        val mediaManager = MediaManager(apiHandler, context)
        
        // Mock some library data using test factory
        val library = TestDataFactory.createTestLibrary(
            id = "mock-lib-1",
            name = "Mock Library",
            mediaType = "book"
        )
        
        mediaManager.serverLibraries.add(library)
        
        assertEquals(1, mediaManager.serverLibraries.size)
        assertEquals("Mock Library", mediaManager.serverLibraries[0].name)
    }

    @Test
    fun authorDataTest() {
        val author = TestDataFactory.createTestAuthor(
            id = "author-1",
            name = "John Smith"
        )
        
        assertEquals("John Smith", author.name)
        assertEquals("author-1", author.id)
    }

    @Test
    fun androidAutoTestDataIntegration() {
        val (libraries, libraryItems, collections) = TestDataFactory.createAndroidAutoTestData()
        
        // Verify the data structure is correct
        assertEquals(2, libraries.size)
        assertEquals(3, libraryItems.size)
        assertEquals(2, collections.size)
        
        // Test that we have both book and podcast libraries
        val bookLibraries = libraries.filter { it.mediaType == "book" }
        val podcastLibraries = libraries.filter { it.mediaType == "podcast" }
        
        assertEquals(1, bookLibraries.size)
        assertEquals(1, podcastLibraries.size)
    }
}
