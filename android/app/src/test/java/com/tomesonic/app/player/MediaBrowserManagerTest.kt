package com.tomesonic.app.player

import android.content.Context
import androidx.media3.session.LibraryResult
import androidx.test.core.app.ApplicationProvider
import com.tomesonic.app.data.*
import com.tomesonic.app.media.MediaManager
import com.tomesonic.app.media.NetworkConnectivityManager
import com.tomesonic.app.testutils.TestDataFactory
import kotlinx.coroutines.runBlocking
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mock
import org.mockito.MockitoAnnotations
import org.mockito.kotlin.*
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class MediaBrowserManagerTest {

    @Mock
    private lateinit var service: PlayerNotificationService
    
    @Mock
    private lateinit var mediaManager: MediaManager
    
    @Mock
    private lateinit var networkConnectivityManager: NetworkConnectivityManager
    
    private lateinit var context: Context
    private lateinit var mediaBrowserManager: MediaBrowserManager

    @Before
    fun setUp() {
        MockitoAnnotations.openMocks(this)
        context = ApplicationProvider.getApplicationContext()
        
        // Mock media manager to return empty data initially
        whenever(mediaManager.serverItemsInProgress).thenReturn(emptyList())
        whenever(mediaManager.serverLibraries).thenReturn(emptyList())
        whenever(mediaManager.hasRecentShelvesLoaded()).thenReturn(false)
        
        mediaBrowserManager = MediaBrowserManager(service, mediaManager, networkConnectivityManager, context)
    }

    @Test
    fun `onGetLibraryRoot should reject invalid clients`() = runBlocking {
        // Test with invalid package name
        val result = mediaBrowserManager.onGetLibraryRoot("invalid.package.name", null).get()
        
        // Should return error for invalid clients
        assertEquals(LibraryResult.RESULT_ERROR_NOT_SUPPORTED, result.resultCode)
    }

    @Test
    fun `onGetLibraryRoot should accept valid Android Auto client`() = runBlocking {
        // Mock browse tree initialization
        mediaBrowserManager.initializeBrowseTree()
        
        // Test with Android Auto package name
        val result = mediaBrowserManager.onGetLibraryRoot("com.google.android.projection.gearhead", null).get()
        
        // Should succeed for valid clients
        assertEquals(LibraryResult.RESULT_SUCCESS, result.resultCode)
        assertNotNull(result.value)
    }

    @Test
    fun `shouldBookBeBrowsable returns true for books with chapters`() {
        // Use test factory to create test data
        val book = TestDataFactory.createTestBook(numChapters = 2)
        val libraryItem = TestDataFactory.createTestLibraryItem(
            mediaType = "book",
            media = book
        )
        
        val result = mediaBrowserManager.shouldBookBeBrowsable(libraryItem)
        assertTrue(result)
    }

    @Test
    fun `shouldBookBeBrowsable returns false for books without chapters`() {
        // Create a book without chapters using test factory
        val book = TestDataFactory.createTestBook(numChapters = 0)
        val libraryItem = TestDataFactory.createTestLibraryItem(
            mediaType = "book",
            media = book
        )
        
        val result = mediaBrowserManager.shouldBookBeBrowsable(libraryItem)
        assertFalse(result)
    }

    @Test
    fun `shouldBookBeBrowsable returns false for non-book media`() {
        // Create a podcast using test factory
        val podcast = TestDataFactory.createTestPodcast()
        val libraryItem = TestDataFactory.createTestLibraryItem(
            mediaType = "podcast",
            media = podcast
        )
        
        val result = mediaBrowserManager.shouldBookBeBrowsable(libraryItem)
        assertFalse(result)
    }

    @Test
    fun `initializeBrowseTree initializes successfully`() {
        // Mock some library data using test factory
        val library = TestDataFactory.createTestLibrary()
        whenever(mediaManager.serverLibraries).thenReturn(listOf(library))
        
        // Should not throw exception
        mediaBrowserManager.initializeBrowseTree()
        
        // Should be initialized
        assertTrue(mediaBrowserManager.isBrowseTreeInitialized())
    }

    @Test
    fun `formatTime formats seconds correctly`() {
        // Test with hours, minutes, seconds
        assertEquals("1:23:45", mediaBrowserManager.formatTime(5025))
        
        // Test with minutes and seconds only  
        assertEquals("12:34", mediaBrowserManager.formatTime(754))
        
        // Test with seconds only
        assertEquals("0:30", mediaBrowserManager.formatTime(30))
        
        // Test zero
        assertEquals("0:00", mediaBrowserManager.formatTime(0))
    }

    @Test
    fun `shouldLocalBookBeBrowsable works with local library items`() {
        // Create local book with chapters
        val localBook = TestDataFactory.createTestBook(numChapters = 3)
        val localItem = TestDataFactory.createTestLocalLibraryItem(
            mediaType = "book"
        ).apply {
            media = localBook
        }
        
        val result = mediaBrowserManager.shouldLocalBookBeBrowsable(localItem)
        assertTrue(result)
    }

    @Test
    fun `browse tree handles multiple libraries`() {
        // Create test data with multiple libraries
        val (libraries, _, _) = TestDataFactory.createAndroidAutoTestData()
        whenever(mediaManager.serverLibraries).thenReturn(libraries)
        
        // Initialize browse tree
        mediaBrowserManager.initializeBrowseTree()
        
        // Should be initialized successfully
        assertTrue(mediaBrowserManager.isBrowseTreeInitialized())
    }

    // Helper method to access private formatTime method via reflection
    private fun MediaBrowserManager.formatTime(seconds: Long): String {
        val method = MediaBrowserManager::class.java.getDeclaredMethod("formatTime", Long::class.java)
        method.isAccessible = true
        return method.invoke(this, seconds) as String
    }

    // Helper method to access private shouldLocalBookBeBrowsable method via reflection
    private fun MediaBrowserManager.shouldLocalBookBeBrowsable(localLibraryItem: LocalLibraryItem): Boolean {
        val method = MediaBrowserManager::class.java.getDeclaredMethod("shouldLocalBookBeBrowsable", LocalLibraryItem::class.java)
        method.isAccessible = true
        return method.invoke(this, localLibraryItem) as Boolean
    }

    // Helper method to access private shouldBookBeBrowsable method via reflection
    private fun MediaBrowserManager.shouldBookBeBrowsable(libraryItem: LibraryItem): Boolean {
        val method = MediaBrowserManager::class.java.getDeclaredMethod("shouldBookBeBrowsable", LibraryItem::class.java)
        method.isAccessible = true
        return method.invoke(this, libraryItem) as Boolean
    }
}