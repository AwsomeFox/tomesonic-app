package com.tomesonic.app.testutils

import com.tomesonic.app.data.*

/**
 * Test utilities and factory methods for creating test data
 */
object TestDataFactory {

    fun createTestBookMetadata(
        title: String = "Test Book",
        author: String = "Test Author"
    ): BookMetadata {
        return BookMetadata(
            title = title,
            subtitle = null,
            authors = mutableListOf(Author("author-1", author, null)),
            narrators = null,
            genres = mutableListOf("Test Genre"),
            publishedYear = "2023",
            publishedDate = null,
            publisher = "Test Publisher",
            description = "A test book description",
            isbn = null,
            asin = null,
            language = "en",
            explicit = false,
            authorName = author,
            authorNameLF = author,
            narratorName = null,
            seriesName = null,
            series = null
        )
    }

    fun createTestBook(
        id: String = "test-book-1",
        title: String = "Test Book",
        author: String = "Test Author",
        duration: Double = 3600.0,
        numChapters: Int = 3
    ): Book {
        val chapters = if (numChapters > 0) {
            (1..numChapters).map { i ->
                BookChapter(
                    id = i,
                    start = ((i - 1) * (duration / numChapters)),
                    end = (i * (duration / numChapters)),
                    title = "Chapter $i"
                )
            }
        } else {
            emptyList()
        }
        
        val metadata = createTestBookMetadata(title, author)
        
        return Book(
            metadata = metadata,
            coverPath = null,
            tags = listOf("test"),
            audioFiles = null,
            chapters = chapters,
            tracks = mutableListOf(),
            ebookFile = null,
            size = null,
            duration = duration,
            numTracks = null
        )
    }

    fun createTestPodcastMetadata(
        title: String = "Test Podcast"
    ): PodcastMetadata {
        return PodcastMetadata(
            title = title,
            author = "Test Podcaster",
            feedUrl = "https://test.com/feed",
            genres = mutableListOf("Test Genre"),
            explicit = false
        )
    }

    fun createTestLibraryItem(
        id: String = "test-item-1",
        title: String = "Test Item",
        mediaType: String = "book",
        media: MediaType? = null
    ): LibraryItem {
        val mediaInstance = media ?: when (mediaType) {
            "book" -> createTestBook(id = id, title = title)
            "podcast" -> createTestPodcast(title = title)
            else -> createTestBook(id = id, title = title)
        }
        
        return LibraryItem(
            id = id,
            ino = "test-ino",
            libraryId = "test-library",
            folderId = "test-folder",
            path = "/test/path",
            relPath = "test/path",
            mtimeMs = System.currentTimeMillis(),
            ctimeMs = System.currentTimeMillis(),
            birthtimeMs = System.currentTimeMillis(),
            addedAt = System.currentTimeMillis(),
            updatedAt = System.currentTimeMillis(),
            lastScan = System.currentTimeMillis(),
            scanVersion = "1.0",
            isMissing = false,
            isInvalid = false,
            mediaType = mediaType,
            media = mediaInstance,
            libraryFiles = mutableListOf(),
            userMediaProgress = null,
            collapsedSeries = null,
            localLibraryItemId = null,
            recentEpisode = null
        )
    }

    fun createTestPodcast(
        title: String = "Test Podcast",
        description: String = "A test podcast",
        numEpisodes: Int = 5
    ): Podcast {
        val episodes = if (numEpisodes > 0) {
            (1..numEpisodes).map { i ->
                PodcastEpisode(
                    id = "episode-$i",
                    index = i,
                    episode = null,
                    episodeType = null,
                    title = "Episode $i",
                    subtitle = null,
                    description = "Episode $i description",
                    pubDate = null,
                    publishedAt = System.currentTimeMillis() - (i * 24 * 60 * 60 * 1000), // i days ago
                    audioFile = null,
                    audioTrack = null,
                    chapters = null,
                    duration = (1800.0 + (i * 300)), // 30-55 minutes per episode
                    size = 0L,
                    serverEpisodeId = null,
                    localEpisodeId = null
                )
            }.toMutableList()
        } else {
            mutableListOf()
        }
        
        val metadata = createTestPodcastMetadata(title)
        
        return Podcast(
            metadata = metadata,
            coverPath = null,
            tags = mutableListOf("test"),
            episodes = episodes,
            autoDownloadEpisodes = false,
            numEpisodes = numEpisodes
        )
    }

    fun createTestLibrary(
        id: String = "test-library-1",
        name: String = "Test Library",
        mediaType: String = "book",
        numItems: Int = 10
    ): Library {
        val stats = LibraryStats(
            totalItems = numItems,
            totalSize = numItems * 1000000L,
            totalDuration = numItems * 3600.0,
            numAudioFiles = numItems * 15
        )
        
        return Library(
            id = id,
            name = name,
            folders = mutableListOf(),
            icon = "database",
            mediaType = mediaType,
            stats = stats
        )
    }

    fun createTestMediaProgress(
        id: String = "test-progress-1",
        libraryItemId: String = "test-item-1",
        currentTime: Double = 1800.0,
        duration: Double = 3600.0,
        isFinished: Boolean = false
    ): MediaProgress {
        return MediaProgress(
            id = id,
            libraryItemId = libraryItemId,
            episodeId = null,
            duration = duration,
            progress = currentTime / duration,
            currentTime = currentTime,
            isFinished = isFinished,
            ebookLocation = null,
            ebookProgress = null,
            lastUpdate = System.currentTimeMillis(),
            startedAt = System.currentTimeMillis(),
            finishedAt = if (isFinished) System.currentTimeMillis() else null
        )
    }

    fun createTestCollection(
        id: String = "test-collection-1",
        name: String = "Test Collection",
        description: String = "A test collection"
    ): LibraryCollection {
        return LibraryCollection(
            id = id,
            libraryId = "test-library",
            name = name,
            description = description,
            books = mutableListOf()
        )
    }

    fun createTestAuthor(
        id: String = "test-author-1",
        name: String = "Test Author",
        libraryId: String = "test-library-1"
    ): Author {
        return Author(
            id = id,
            name = name,
            coverPath = null
        )
    }

    fun createTestLocalLibraryItem(
        id: String = "test-local-1",
        title: String = "Local Test Item",
        mediaType: String = "book"
    ): LocalLibraryItem {
        val media = when (mediaType) {
            "book" -> createTestBook(id = id, title = title)
            "podcast" -> createTestPodcast(title = title)
            else -> createTestBook(id = id, title = title)
        }
        
        return LocalLibraryItem(
            id = id,
            folderId = "test-folder",
            basePath = "/test/path",
            absolutePath = "/test/path/absolute",
            contentUrl = "content://test",
            isInvalid = false,
            mediaType = mediaType,
            media = media,
            localFiles = mutableListOf(),
            coverContentUrl = null,
            coverAbsolutePath = null,
            isLocal = true,
            serverConnectionConfigId = null,
            serverAddress = null,
            serverUserId = null,
            libraryItemId = null
        )
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
    fun createAndroidAutoTestData(): Triple<List<Library>, List<LibraryItem>, List<LibraryCollection>> {
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