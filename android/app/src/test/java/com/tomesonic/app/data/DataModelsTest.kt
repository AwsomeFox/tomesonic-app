package com.tomesonic.app.data

import com.tomesonic.app.testutils.TestDataFactory
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class DataModelsTest {

    @Test
    fun `LibraryItem initializes with proper values`() {
        val libraryItem = TestDataFactory.createTestLibraryItem()
        
        assertNotNull(libraryItem)
        assertEquals("test-item-1", libraryItem.id)
        assertEquals("book", libraryItem.mediaType)
        assertEquals("Test Item", libraryItem.title)
    }

    @Test
    fun `LibraryItem with book media type`() {
        val book = TestDataFactory.createTestBook(
            title = "Test Book",
            author = "Test Author",
            duration = 7200.0 // 2 hours
        )
        
        val libraryItem = TestDataFactory.createTestLibraryItem(
            id = "book-1",
            mediaType = "book",
            media = book
        )
        
        assertEquals("book", libraryItem.mediaType)
        assertEquals("Test Book", libraryItem.title)
        assertEquals("Test Book", (libraryItem.media as Book).metadata.title)
        assertEquals(7200.0, (libraryItem.media as Book).duration)
    }

    @Test
    fun `LibraryItem with podcast media type`() {
        val podcast = TestDataFactory.createTestPodcast(
            title = "Test Podcast"
        )
        
        val libraryItem = TestDataFactory.createTestLibraryItem(
            id = "podcast-1",
            mediaType = "podcast", 
            media = podcast
        )
        
        assertEquals("podcast", libraryItem.mediaType)
        assertEquals("Test Podcast", libraryItem.title)
        assertEquals("Test Podcast", (libraryItem.media as Podcast).metadata.title)
    }

    @Test
    fun `Book with chapters`() {
        val book = TestDataFactory.createTestBook(
            title = "Multi-Chapter Book",
            numChapters = 2
        )
        
        assertEquals(2, book.chapters?.size)
        assertEquals("Chapter 1", book.chapters?.get(0)?.title)
        assertEquals(1800.0, book.chapters?.get(1)?.start)
    }

    @Test
    fun `MediaProgress tracks playback state`() {
        val progress = TestDataFactory.createTestMediaProgress(
            currentTime = 1500.0,
            progress = 0.25,
            duration = 6000.0,
            isFinished = false
        )
        
        assertEquals(0.25, progress.progress)
        assertEquals(1500.0, progress.currentTime)
        assertEquals(6000.0, progress.duration)
        assertFalse(progress.isFinished)
    }

    @Test
    fun `Library with statistics`() {
        val library = TestDataFactory.createTestLibrary(
            name = "Main Library",
            mediaType = "book",
            numItems = 100
        )
        
        assertEquals("Main Library", library.name)
        assertEquals("book", library.mediaType)
        assertEquals(100, library.stats?.totalItems)
        assertEquals(1500, library.stats?.numAudioFiles)
    }

    @Test
    fun `LocalLibraryItem for offline content`() {
        val localItem = TestDataFactory.createTestLocalLibraryItem(
            id = "local-1",
            title = "Downloaded Book",
            mediaType = "book"
        )
        
        assertEquals("book", localItem.mediaType)
        assertEquals("Downloaded Book", localItem.title)
        assertTrue(localItem.isLocal)
    }

    @Test
    fun `Collection groups library items`() {
        val collection = TestDataFactory.createTestCollection(
            id = "collection-1",
            name = "Favorite Books",
            description = "My favorite books collection"
        )
        
        assertEquals("collection-1", collection.id)
        assertEquals("Favorite Books", collection.name)
        assertEquals("My favorite books collection", collection.description)
    }

    @Test
    fun `PodcastEpisode with metadata`() {
        val podcast = TestDataFactory.createTestPodcast(
            title = "Test Podcast",
            numEpisodes = 1
        )
        
        val episode = podcast.episodes?.get(0)
        assertNotNull(episode)
        assertEquals("Episode 1", episode.title)
        assertEquals(2100.0, episode.duration) // 35 minutes
    }

    @Test
    fun `Author with proper data`() {
        val author = TestDataFactory.createTestAuthor(
            id = "author-1",
            name = "John Doe"
        )
        
        assertEquals("John Doe", author.name)
        assertEquals("author-1", author.id)
    }

    @Test
    fun `Book without chapters`() {
        val book = TestDataFactory.createTestBook(
            title = "No Chapter Book",
            numChapters = 0
        )
        
        assertTrue(book.chapters?.isEmpty() == true)
    }

    @Test
    fun `Multiple library items can be created`() {
        val items = TestDataFactory.createTestLibraryItems(3, "book")
        
        assertEquals(3, items.size)
        assertEquals("Test Item 1", items[0].title)
        assertEquals("Test Item 2", items[1].title)
        assertEquals("Test Item 3", items[2].title)
    }

    @Test
    fun `Android Auto test data structure`() {
        val (libraries, libraryItems, collections) = TestDataFactory.createAndroidAutoTestData()
        
        assertEquals(2, libraries.size)
        assertEquals(3, libraryItems.size)
        assertEquals(2, collections.size)
        
        // Verify library types
        assertTrue(libraries.any { it.mediaType == "book" })
        assertTrue(libraries.any { it.mediaType == "podcast" })
    }
}