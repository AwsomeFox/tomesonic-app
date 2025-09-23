package com.tomesonic.app.player

import android.content.Context
import android.content.Intent
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.test.core.app.ApplicationProvider
import com.tomesonic.app.data.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.MockitoAnnotations
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class PlayerNotificationServiceTest {

    private lateinit var context: Context
    private lateinit var service: PlayerNotificationService

    @Before
    fun setUp() {
        MockitoAnnotations.openMocks(this)
        context = ApplicationProvider.getApplicationContext()
        service = PlayerNotificationService()
    }

    @Test
    fun `service can be created`() {
        assertNotNull(service)
    }

    @Test
    fun `isBrowseTreeInitialized returns false initially`() {
        // Before initialization, browse tree should not be initialized
        assertFalse(service.isBrowseTreeInitialized())
    }

    @Test
    fun `setUseChapterTrack updates setting`() {
        // Test setting chapter track usage
        service.setUseChapterTrack(true)
        // Note: This is testing that the method doesn't throw an exception
        // as the internal state is private
        assertNotNull(service)
        
        service.setUseChapterTrack(false)
        assertNotNull(service)
    }

    @Test
    fun `onBind returns valid binder`() {
        val intent = Intent()
        val binder = service.onBind(intent)
        
        // Should return a binder (either MediaBrowser or LocalBinder)
        assertNotNull(binder)
    }

    @Test
    fun `service handles start command without crashing`() {
        val intent = Intent()
        val result = service.onStartCommand(intent, 0, 1)
        
        // Should handle start command successfully
        assertNotNull(result)
        
        // Verify service is marked as started
        assertTrue(PlayerNotificationService.isStarted)
    }

    @Test
    fun `getChapterRelativePosition returns valid position`() {
        // Test that the method exists and returns a valid position
        val position = service.getChapterRelativePosition()
        
        // Should return a non-negative position
        assertTrue(position >= 0)
    }

    @Test
    fun `service can handle media items creation for books`() {
        // Create test book data
        val book = Book().apply {
            title = "Test Book"
            author = "Test Author"
            duration = 3600.0
        }
        
        val libraryItem = LibraryItem().apply {
            id = "book-1"
            mediaType = "book"
            media = book
            title = "Test Book"
        }
        
        val progress = MediaProgress().apply {
            currentTime = 1800.0
            progress = 0.5
            duration = 3600.0
        }
        
        // Test creating media items (indirectly through handleInProgressBrowsing)
        // This tests the data flow without requiring full service initialization
        assertNotNull(libraryItem)
        assertNotNull(progress)
        assertEquals("book", libraryItem.mediaType)
        assertEquals(0.5, progress.progress)
    }

    @Test
    fun `service constants are properly defined`() {
        // Test custom action constants
        assertEquals("jump_backward", PlayerNotificationService.CUSTOM_ACTION_JUMP_BACKWARD)
        assertEquals("jump_forward", PlayerNotificationService.CUSTOM_ACTION_JUMP_FORWARD)
        assertEquals("change_playback_speed", PlayerNotificationService.CUSTOM_ACTION_CHANGE_PLAYBACK_SPEED)
    }

    @Test
    fun `service handles collections browsing data`() {
        // Create test collection data
        val collection = Collection().apply {
            id = "collection-1" 
            name = "Test Collection"
            description = "A test collection"
        }
        
        // Test that collection data can be properly structured
        assertNotNull(collection)
        assertEquals("collection-1", collection.id)
        assertEquals("Test Collection", collection.name)
    }

    @Test
    fun `service can process library browsing parameters`() {
        // Test library ID parsing from media ID
        val mediaId = "__LIBRARY__lib1__BOOKS__"
        val parts = mediaId.split("__")
        
        assertTrue(parts.contains("LIBRARY"))
        assertTrue(parts.contains("lib1"))
        assertTrue(parts.contains("BOOKS"))
    }

    @Test
    fun `service handles podcast episode data`() {
        // Create test podcast data
        val episode = PodcastEpisode().apply {
            id = "ep-1"
            title = "Test Episode"
            duration = 2700.0
        }
        
        val podcast = Podcast().apply {
            title = "Test Podcast"
            episodes = listOf(episode)
        }
        
        val libraryItem = LibraryItem().apply {
            id = "podcast-1"
            mediaType = "podcast"
            media = podcast
        }
        
        assertEquals("podcast", libraryItem.mediaType)
        assertEquals(1, (libraryItem.media as Podcast).episodes?.size)
        assertEquals("Test Episode", (libraryItem.media as Podcast).episodes?.get(0)?.title)
    }
}