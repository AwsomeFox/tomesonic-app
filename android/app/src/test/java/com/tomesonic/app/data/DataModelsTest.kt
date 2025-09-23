package com.tomesonic.app.data

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
    fun `LibraryItem initializes with default values`() {
        val libraryItem = LibraryItem()
        
        assertNotNull(libraryItem)
        assertEquals("", libraryItem.id)
        assertEquals("", libraryItem.mediaType)
    }

    @Test
    fun `LibraryItem with book media type`() {
        val book = Book().apply {
            title = "Test Book"
            author = "Test Author"
            duration = 7200.0 // 2 hours
        }
        
        val libraryItem = LibraryItem().apply {
            id = "book-1"
            mediaType = "book"
            media = book
            title = "Test Book"
        }
        
        assertEquals("book", libraryItem.mediaType)
        assertEquals("Test Book", libraryItem.title)
        assertEquals("Test Book", (libraryItem.media as Book).title)
        assertEquals(7200.0, (libraryItem.media as Book).duration)
    }

    @Test
    fun `LibraryItem with podcast media type`() {
        val podcast = Podcast().apply {
            title = "Test Podcast"
            description = "A test podcast"
        }
        
        val libraryItem = LibraryItem().apply {
            id = "podcast-1"
            mediaType = "podcast"
            media = podcast
            title = "Test Podcast"
        }
        
        assertEquals("podcast", libraryItem.mediaType)
        assertEquals("Test Podcast", libraryItem.title)
        assertEquals("Test Podcast", (libraryItem.media as Podcast).title)
    }

    @Test
    fun `Book with chapters`() {
        val chapter1 = BookChapter().apply {
            id = "ch1"
            title = "Chapter 1"
            startTime = 0.0
            endTime = 1800.0 // 30 minutes
        }
        
        val chapter2 = BookChapter().apply {
            id = "ch2"
            title = "Chapter 2"
            startTime = 1800.0
            endTime = 3600.0 // 30 minutes
        }
        
        val book = Book().apply {
            title = "Multi-Chapter Book"
            chapters = listOf(chapter1, chapter2)
        }
        
        assertEquals(2, book.chapters?.size)
        assertEquals("Chapter 1", book.chapters?.get(0)?.title)
        assertEquals(1800.0, book.chapters?.get(1)?.startTime)
    }

    @Test
    fun `MediaProgress tracks playback state`() {
        val progress = MediaProgress().apply {
            id = "progress-1"
            currentTime = 1500.0
            progress = 0.25
            duration = 6000.0
            isFinished = false
        }
        
        assertEquals(0.25, progress.progress)
        assertEquals(1500.0, progress.currentTime)
        assertEquals(6000.0, progress.duration)
        assertFalse(progress.isFinished)
    }

    @Test
    fun `Library with statistics`() {
        val stats = LibraryStats().apply {
            totalItems = 100
            totalAuthors = 25
            totalGenres = 10
            totalDuration = 360000.0 // 100 hours
            numAudioFiles = 500
        }
        
        val library = Library().apply {
            id = "lib-1"
            name = "Main Library"
            mediaType = "book"
            stats = stats
        }
        
        assertEquals("Main Library", library.name)
        assertEquals("book", library.mediaType)
        assertEquals(100, library.stats?.totalItems)
        assertEquals(500, library.stats?.numAudioFiles)
    }

    @Test
    fun `LocalLibraryItem for offline content`() {
        val localBook = Book().apply {
            title = "Downloaded Book"
            duration = 3600.0
        }
        
        val localItem = LocalLibraryItem().apply {
            id = "local-1"
            mediaType = "book"
            media = localBook
            title = "Downloaded Book"
        }
        
        assertEquals("book", localItem.mediaType)
        assertEquals("Downloaded Book", localItem.title)
        assertEquals(3600.0, (localItem.media as Book).duration)
    }

    @Test
    fun `Collection groups library items`() {
        val collection = Collection().apply {
            id = "collection-1"
            name = "Favorite Books"
            description = "My favorite books collection"
        }
        
        assertEquals("collection-1", collection.id)
        assertEquals("Favorite Books", collection.name)
        assertEquals("My favorite books collection", collection.description)
    }

    @Test
    fun `UserProgress combines media progress and settings`() {
        val userProgress = UserProgress().apply {
            libraryItemId = "item-1"
            currentTime = 2400.0
            progress = 0.4
            isFinished = false
        }
        
        assertEquals("item-1", userProgress.libraryItemId)
        assertEquals(0.4, userProgress.progress)
        assertFalse(userProgress.isFinished)
    }

    @Test
    fun `PodcastEpisode with metadata`() {
        val episode = PodcastEpisode().apply {
            id = "ep-1"
            title = "Episode 1"
            description = "First episode"
            duration = 2700.0 // 45 minutes
            publishedAt = 1640995200000 // Jan 1, 2022
        }
        
        assertEquals("Episode 1", episode.title)
        assertEquals(2700.0, episode.duration)
        assertEquals(1640995200000, episode.publishedAt)
    }

    @Test
    fun `Author with library reference`() {
        val author = Author().apply {
            id = "author-1"
            name = "John Doe"
            libraryId = "lib-1"
        }
        
        assertEquals("John Doe", author.name)
        assertEquals("lib-1", author.libraryId)
    }
}