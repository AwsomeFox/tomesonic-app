package com.tomesonic.app.testutils

import com.tomesonic.app.data.*

/**
 * Test utilities and factory methods for creating test data
 */
object TestDataFactory {

    fun createTestBook(
        id: String = "test-book-1",
        title: String = "Test Book",
        author: String = "Test Author",
        duration: Double = 3600.0,
        numChapters: Int = 3
    ): Book {
        val chapters = (1..numChapters).map { i ->
            BookChapter().apply {
                this.id = "chapter-$i"
                this.title = "Chapter $i"
                this.startTime = ((i - 1) * (duration / numChapters))
                this.endTime = (i * (duration / numChapters))
            }
        }
        
        return Book().apply {
            this.title = title
            this.author = author
            this.duration = duration
            this.chapters = chapters
        }
    }

    fun createTestLibraryItem(
        id: String = "test-item-1",
        title: String = "Test Item",
        mediaType: String = "book",
        media: Any? = null
    ): LibraryItem {
        return LibraryItem().apply {
            this.id = id
            this.title = title
            this.mediaType = mediaType
            this.media = media ?: when (mediaType) {
                "book" -> createTestBook(id = id, title = title)
                "podcast" -> createTestPodcast(title = title)
                else -> null
            }
        }
    }

    fun createTestPodcast(
        title: String = "Test Podcast",
        description: String = "A test podcast",
        numEpisodes: Int = 5
    ): Podcast {
        val episodes = (1..numEpisodes).map { i ->
            PodcastEpisode().apply {
                this.id = "episode-$i"
                this.title = "Episode $i"
                this.description = "Episode $i description"
                this.duration = (1800.0 + (i * 300)) // 30-55 minutes per episode
                this.publishedAt = System.currentTimeMillis() - (i * 24 * 60 * 60 * 1000) // i days ago
            }
        }
        
        return Podcast().apply {
            this.title = title
            this.description = description
            this.episodes = episodes
        }
    }

    fun createTestLibrary(
        id: String = "test-library-1",
        name: String = "Test Library",
        mediaType: String = "book",
        numItems: Int = 10
    ): Library {
        val stats = LibraryStats().apply {
            totalItems = numItems
            totalAuthors = numItems / 2
            totalGenres = 5
            totalDuration = numItems * 3600.0
            numAudioFiles = numItems * 15
        }
        
        return Library().apply {
            this.id = id
            this.name = name
            this.mediaType = mediaType
            this.stats = stats
        }
    }

    fun createTestMediaProgress(
        id: String = "test-progress-1",
        libraryItemId: String = "test-item-1",
        currentTime: Double = 1800.0,
        duration: Double = 3600.0,
        isFinished: Boolean = false
    ): MediaProgress {
        return MediaProgress().apply {
            this.id = id
            this.libraryItemId = libraryItemId
            this.currentTime = currentTime
            this.duration = duration
            this.progress = currentTime / duration
            this.isFinished = isFinished
        }
    }

    fun createTestCollection(
        id: String = "test-collection-1",
        name: String = "Test Collection",
        description: String = "A test collection"
    ): Collection {
        return Collection().apply {
            this.id = id
            this.name = name
            this.description = description
        }
    }

    fun createTestAuthor(
        id: String = "test-author-1",
        name: String = "Test Author",
        libraryId: String = "test-library-1"
    ): Author {
        return Author().apply {
            this.id = id
            this.name = name
            this.libraryId = libraryId
        }
    }

    fun createTestUserProgress(
        libraryItemId: String = "test-item-1",
        currentTime: Double = 1800.0,
        progress: Double = 0.5,
        isFinished: Boolean = false
    ): UserProgress {
        return UserProgress().apply {
            this.libraryItemId = libraryItemId
            this.currentTime = currentTime
            this.progress = progress
            this.isFinished = isFinished
            this.lastUpdate = System.currentTimeMillis()
        }
    }

    fun createTestLocalLibraryItem(
        id: String = "test-local-1",
        title: String = "Local Test Item",
        mediaType: String = "book"
    ): LocalLibraryItem {
        return LocalLibraryItem().apply {
            this.id = id
            this.title = title
            this.mediaType = mediaType
            this.media = when (mediaType) {
                "book" -> createTestBook(id = id, title = title)
                "podcast" -> createTestPodcast(title = title)
                else -> null
            }
        }
    }

    /**
     * Creates a list of test library items for bulk testing
     */
    fun createTestLibraryItems(count: Int, mediaType: String = "book"): List<LibraryItem> {
        return (1..count).map { i ->
            createTestLibraryItem(
                id = "test-item-$i",
                title = "Test Item $i",
                mediaType = mediaType
            )
        }
    }

    /**
     * Creates test data for Android Auto browsing scenarios
     */
    fun createAndroidAutoTestData(): Triple<List<Library>, List<LibraryItem>, List<Collection>> {
        val libraries = listOf(
            createTestLibrary("lib-books", "Books", "book", 25),
            createTestLibrary("lib-podcasts", "Podcasts", "podcast", 15)
        )
        
        val libraryItems = listOf(
            createTestLibraryItem("book-1", "The Great Gatsby", "book"),
            createTestLibraryItem("book-2", "To Kill a Mockingbird", "book"),
            createTestLibraryItem("podcast-1", "Tech Talk Weekly", "podcast")
        )
        
        val collections = listOf(
            createTestCollection("col-1", "Favorites", "My favorite books and podcasts"),
            createTestCollection("col-2", "Recently Added", "Recently added content")
        )
        
        return Triple(libraries, libraryItems, collections)
    }
}