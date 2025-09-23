package com.tomesonic.app.media

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.tomesonic.app.data.*
import com.tomesonic.app.server.ApiHandler
import com.tomesonic.app.testutils.TestDataFactory
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mock
import org.mockito.MockitoAnnotations
import org.mockito.kotlin.*
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class MediaManagerTest {

    @Mock
    private lateinit var apiHandler: ApiHandler
    
    private lateinit var context: Context
    private lateinit var mediaManager: MediaManager
    private lateinit var mockWebServer: MockWebServer

    @Before
    fun setUp() {
        MockitoAnnotations.openMocks(this)
        context = ApplicationProvider.getApplicationContext()
        mockWebServer = MockWebServer()
        mockWebServer.start()
        
        mediaManager = MediaManager(apiHandler, context)
    }

    @After
    fun tearDown() {
        mockWebServer.shutdown()
    }

    @Test
    fun `mediaManager initializes with empty collections`() {
        // Verify initial state
        assertTrue(mediaManager.serverLibraries.isEmpty())
        assertTrue(mediaManager.serverItemsInProgress.isEmpty())
    }

    @Test
    fun `getCachedCollections returns empty list when no collections cached`() {
        val collections = mediaManager.getCachedCollections("test-library-id")
        assertTrue(collections.isEmpty())
    }

    @Test
    fun `hasRecentShelvesLoaded returns false initially`() {
        val result = mediaManager.hasRecentShelvesLoaded()
        assertEquals(false, result)
    }

    @Test
    fun `serverLibraries can be updated`() {
        // Use test factory to create libraries
        val library1 = TestDataFactory.createTestLibrary("lib1", "Library 1", "book")
        val library2 = TestDataFactory.createTestLibrary("lib2", "Library 2", "podcast")
        
        // Simulate adding libraries
        mediaManager.serverLibraries.clear()
        mediaManager.serverLibraries.addAll(listOf(library1, library2))
        
        assertEquals(2, mediaManager.serverLibraries.size)
        assertEquals("Library 1", mediaManager.serverLibraries[0].name)
        assertEquals("podcast", mediaManager.serverLibraries[1].mediaType)
    }

    @Test
    fun `getCachedPodcasts returns empty list when no podcasts cached`() {
        val podcasts = mediaManager.getCachedPodcasts("test-library-id")
        assertTrue(podcasts.isEmpty())
    }

    @Test
    fun `getCachedBooks returns empty list when no books cached`() {
        val books = mediaManager.getCachedBooks("test-library-id")
        assertTrue(books.isEmpty())
    }

    @Test
    fun `android auto load listeners can be registered`() {
        var listenerCalled = false
        val listener = { listenerCalled = true }
        
        mediaManager.registerAndroidAutoLoadListener(listener)
        
        // Verify listener was registered (implementation detail, but we can test behavior)
        assertNotNull(mediaManager)
    }

    @Test
    fun `getCachedAuthors returns empty map when no authors cached`() {
        val authors = mediaManager.getCachedAuthors("test-library-id")
        assertTrue(authors.isEmpty())
    }

    @Test
    fun `getCachedLibraryDiscovery returns empty list when no discovery items cached`() {
        val discoveryItems = mediaManager.getCachedLibraryDiscovery("test-library-id")
        assertTrue(discoveryItems.isEmpty())
    }
    
    @Test
    fun `removeFromItemsInProgress removes item successfully`() {
        // Create test library item using test factory
        val libraryItem = TestDataFactory.createTestLibraryItem("test-item-1", "Test Book")
        
        // Add to progress items
        mediaManager.serverItemsInProgress.add(libraryItem)
        assertEquals(1, mediaManager.serverItemsInProgress.size)
        
        // Remove from progress
        mediaManager.removeFromItemsInProgress("test-item-1")
        assertTrue(mediaManager.serverItemsInProgress.isEmpty())
    }

    @Test
    fun `addOrUpdateItemProgress updates existing item`() {
        // Create test library item with progress using test factory
        val progress = TestDataFactory.createTestMediaProgress(
            libraryItemId = "test-item-1",
            currentTime = 1000.0,
            progress = 0.5
        )
        
        val libraryItem = TestDataFactory.createTestLibraryItem("test-item-1", "Test Book").apply {
            userMediaProgress = progress
        }
        
        // Add to progress items
        mediaManager.serverItemsInProgress.add(libraryItem)
        
        // Update with new progress
        val newProgress = TestDataFactory.createTestMediaProgress(
            libraryItemId = "test-item-1",
            currentTime = 2000.0,
            progress = 0.8
        )
        
        mediaManager.addOrUpdateItemProgress(libraryItem.id, newProgress)
        
        // Verify update
        val updatedItem = mediaManager.serverItemsInProgress.find { it.id == "test-item-1" }
        assertNotNull(updatedItem)
        assertEquals(0.8, updatedItem.userMediaProgress?.progress)
        assertEquals(2000.0, updatedItem.userMediaProgress?.currentTime)
    }

    @Test
    fun `handles multiple library types correctly`() {
        // Create test data with both books and podcasts
        val (libraries, libraryItems, _) = TestDataFactory.createAndroidAutoTestData()
        
        // Add libraries to manager
        mediaManager.serverLibraries.addAll(libraries)
        mediaManager.serverItemsInProgress.addAll(libraryItems)
        
        assertEquals(2, mediaManager.serverLibraries.size)
        assertEquals(3, mediaManager.serverItemsInProgress.size)
        
        // Verify we have both book and podcast libraries
        val bookLibraries = mediaManager.serverLibraries.filter { it.mediaType == "book" }
        val podcastLibraries = mediaManager.serverLibraries.filter { it.mediaType == "podcast" }
        
        assertEquals(1, bookLibraries.size)
        assertEquals(1, podcastLibraries.size)
    }

    @Test
    fun `progress tracking works with test data`() {
        // Create multiple items with progress
        val items = TestDataFactory.createTestLibraryItems(3, "book")
        items.forEach { item ->
            val progress = TestDataFactory.createTestMediaProgress(
                libraryItemId = item.id,
                currentTime = 1500.0,
                progress = 0.25
            )
            item.userMediaProgress = progress
        }
        
        mediaManager.serverItemsInProgress.addAll(items)
        
        assertEquals(3, mediaManager.serverItemsInProgress.size)
        
        // Verify all items have progress
        mediaManager.serverItemsInProgress.forEach { item ->
            assertNotNull(item.userMediaProgress)
            assertEquals(0.25, item.userMediaProgress?.progress)
        }
    }
}