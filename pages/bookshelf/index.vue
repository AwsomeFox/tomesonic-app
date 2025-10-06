<template>
  <div class="w-full h-full min-h-full relative">
    <!-- Proper-sized Material 3 skeleton cards to match actual book card dimensions -->
    <div v-if="showingSkeleton" class="w-full px-4 py-4">
      <div class="grid grid-cols-2 gap-8">
        <div
          v-for="n in 8"
          :key="`card-skel-${n}`"
          :class="['bg-surface-container rounded-2xl shadow-elevation-1 overflow-hidden skeleton-card', n % 2 === 0 ? 'shimmer-rtl' : 'shimmer-ltr']"
          :style="{
            '--shimmer-delay': n * 90 + 'ms',
            width: bookSkeletonWidth + 'px',
            height: bookSkeletonHeight + 'px'
          }"
        >
          <div class="p-3 h-full flex flex-col">
            <!-- Cover placeholder with correct aspect ratio -->
            <div
              class="w-full bg-surface-variant rounded-lg shimmer-block flex-1"
              :style="{
                minHeight: bookSkeletonCoverHeight + 'px',
                maxHeight: bookSkeletonCoverHeight + 'px'
              }"
            ></div>
            <!-- Content placeholder - only shown in alt view -->
            <div v-if="altViewEnabled" class="mt-3 space-y-2 flex-shrink-0">
              <div class="h-4 bg-surface-variant rounded-md w-3/4 shimmer-block"></div>
              <div class="h-3 bg-surface-variant rounded-md w-1/2 shimmer-block"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!showingSkeleton" class="w-full" :class="{ 'py-3': altViewEnabled, 'content-loading': isLoading, 'content-loaded': !isLoading && shelves.length }" :style="contentPaddingStyle">
      <template v-for="(shelf, index) in shelves">
        <bookshelf-shelf :key="shelf.id" :label="getShelfLabel(shelf)" :entities="shelf.entities" :type="shelf.type" :style="{ zIndex: shelves.length - index }" :class="[{ 'shelf-updating': shelf._updating }, 'shelf-item', `shelf-delay-${Math.min(index, 6)}`]" />
      </template>
    </div>
  </div>
</template>

<script>
export default {
  props: {},
  data() {
    return {
      shelves: [],
      isFirstNetworkConnection: true,
      lastServerFetch: 0,
      lastServerFetchLibraryId: null,
      lastLocalFetch: 0,
      localLibraryItems: [],
      isLoading: true,
      isFetchingCategories: false,
      firstLoad: true,
      showingSkeleton: true,
      initialConnectionWaitComplete: false
    }
  },
  watch: {
    networkConnected(newVal) {
      // Update shelves when network connect status changes
      console.log(`[categories] Network changed to ${newVal} - fetch categories. ${this.lastServerFetch}/${this.lastLocalFetch}`)

      if (newVal) {
        // Fetch right away the first time network connects during initial load
        if (this.isFirstNetworkConnection) {
          this.isFirstNetworkConnection = false
          console.log(`[categories] networkConnected true first network connection. lastServerFetch=${this.lastServerFetch}`)

          // If we already showed local books and haven't fetched from server, refetch now
          if (this.lastServerFetch === 0 && this.shelves.length > 0) {
            console.log('[categories] Already showed local books, now fetching from server')
            this.fetchCategories()
          } else if (this.shelves.length === 0) {
            // No shelves yet, this is probably during initial mount delay
            console.log('[categories] No shelves yet, mounted will handle fetch')
          }
          return
        }

        setTimeout(() => {
          // Using timeout because making this fetch as soon as network gets connected will often fail on Android
          console.log(`[categories] networkConnected true so fetching categories. lastServerFetch=${this.lastServerFetch}`)
          this.fetchCategories()
        }, 4000)
      } else {
        console.log(`[categories] networkConnected false so fetching categories`)
        this.fetchCategories()
      }
    },
    user(newVal, oldVal) {
      // When user becomes available (login/connection), refetch if we previously showed local-only
      if (newVal && !oldVal && this.networkConnected && this.currentLibraryId && this.initialConnectionWaitComplete) {
        console.log('[categories] User became available after initial wait, checking if refetch needed')
        // Only refetch if we haven't fetched from server yet (showed local-only)
        if (this.lastServerFetch === 0 && this.shelves.length > 0) {
          console.log('[categories] Refetching from server now that user is available')
          this.fetchCategories()
        } else {
          console.log('[categories] Server fetch already done or in progress, skipping')
        }
      }
    },
    currentLibraryId(newVal, oldVal) {
      // When library ID changes (but not on initial load)
      if (newVal && oldVal && newVal !== oldVal) {
        console.log('[categories] Library ID switched from', oldVal, 'to', newVal, '- resetting and refetching')
        // Reset state for new library (actual switch)
        this.showingSkeleton = true
        this.isLoading = true
        this.firstLoad = true
        this.shelves = []
        this.fetchCategories()
      } else if (newVal && !oldVal && this.user && this.networkConnected && this.initialConnectionWaitComplete) {
        // Library ID became available for the first time AND we have user + network (after initial wait)
        console.log('[categories] Library ID became available on initial load:', newVal)
        // If we showed local books first, try to fetch from server now (without resetting UI)
        if (this.lastServerFetch === 0 && this.shelves.length > 0) {
          console.log('[categories] Have local books, now fetching from server')
          // Don't reset shelves, just fetch in background
          this.fetchCategories()
        }
      }
    }
  },
  computed: {
    user() {
      return this.$store.state.user.user
    },
    networkConnected() {
      return this.$store.state.networkConnected
    },
    isIos() {
      return this.$platform === 'ios'
    },
    currentLibraryName() {
      return this.$store.getters['libraries/getCurrentLibraryName']
    },
    currentLibraryId() {
      return this.$store.state.libraries.currentLibraryId
    },
    currentLibraryMediaType() {
      return this.$store.getters['libraries/getCurrentLibraryMediaType']
    },
    currentLibraryIsPodcast() {
      return this.currentLibraryMediaType === 'podcast'
    },
    altViewEnabled() {
      return this.$store.getters['getAltViewEnabled']
    },
    localMediaProgress() {
      return this.$store.state.globals.localMediaProgress
    },
    attemptingConnection() {
      return this.$store.state.attemptingConnection
    },
    contentPaddingStyle() {
      // Add bottom padding to content when player is open so end of content is visible above mini player
      if (this.$store.getters['getIsPlayerOpen']) {
        return { paddingBottom: '120px' }
      }
      return {}
    },
    // Skeleton card dimensions to match actual book cards
    bookCoverAspectRatio() {
      return this.$store.getters['libraries/getBookCoverAspectRatio']
    },
    isCoverSquareAspectRatio() {
      return this.bookCoverAspectRatio === 1
    },
    bookSkeletonWidth() {
      // Match Shelf.vue bookWidth calculation
      if (this.isCoverSquareAspectRatio) return 192
      return 120
    },
    bookSkeletonHeight() {
      // Match Shelf.vue bookHeight calculation
      if (this.isCoverSquareAspectRatio) return this.bookSkeletonWidth
      return this.bookSkeletonWidth * 1.6
    },
    bookSkeletonCoverHeight() {
      // Height for just the cover portion (excluding text in alt view)
      if (this.altViewEnabled) {
        return this.bookSkeletonHeight - 60 // Reserve space for text
      }
      return this.bookSkeletonHeight
    }
  },
  methods: {
    getShelfLabel(shelf) {
      if (shelf.labelStringKey && this.$strings[shelf.labelStringKey]) return this.$strings[shelf.labelStringKey]
      return shelf.label
    },
    getLocalMediaItemCategories() {
      const localMedia = this.localLibraryItems
      if (!localMedia?.length) return []

      const categories = []
      const books = []
      const podcasts = []
      const booksContinueListening = []
      const podcastEpisodesContinueListening = []
      localMedia.forEach((item) => {
        if (item.mediaType == 'book') {
          item.progress = this.$store.getters['globals/getLocalMediaProgressById'](item.id)
          if (item.progress && !item.progress.isFinished && item.progress.progress > 0) booksContinueListening.push(item)
          books.push(item)
        } else if (item.mediaType == 'podcast') {
          const podcastEpisodeItemCloner = { ...item }
          item.media.episodes = item.media.episodes.map((ep) => {
            ep.progress = this.$store.getters['globals/getLocalMediaProgressById'](item.id, ep.id)
            if (ep.progress && !ep.progress.isFinished && ep.progress.progress > 0) {
              podcastEpisodesContinueListening.push({
                ...podcastEpisodeItemCloner,
                recentEpisode: ep
              })
            }
            return ep
          })
          podcasts.push(item)
        }
      })

      // Continue listening episodes shelf (podcasts only)
      if (podcastEpisodesContinueListening.length) {
        categories.push({
          id: 'local-episodes-continue',
          label: this.$strings.LabelContinueEpisodes,
          type: 'episode',
          localOnly: true,
          entities: podcastEpisodesContinueListening.sort((a, b) => {
            if (a.recentEpisode.progress && b.recentEpisode.progress) {
              return b.recentEpisode.progress.lastUpdate > a.recentEpisode.progress.lastUpdate ? 1 : -1
            }
            return 0
          })
        })
      }

      // Merged local books shelf (continue listening books first, then other local books)
      if (books.length) {
        // Get books that are NOT in continue listening (no progress or finished)
        const otherBooks = books.filter((book) => {
          return !book.progress || book.progress.isFinished || book.progress.progress === 0
        })

        // Combine continue listening books first, then other books
        const allBooksEntities = [
          // Continue listening books sorted by most recent activity
          ...booksContinueListening.sort((a, b) => {
            if (a.progress && b.progress) {
              return b.progress.lastUpdate > a.progress.lastUpdate ? 1 : -1
            }
            return 0
          }),
          // Other books sorted with finished books at the end
          ...otherBooks.sort((a, b) => {
            if (a.progress && a.progress.isFinished) return 1
            else if (b.progress && b.progress.isFinished) return -1
            else if (a.progress && b.progress) {
              return b.progress.lastUpdate > a.progress.lastUpdate ? 1 : -1
            }
            return 0
          })
        ]

        categories.push({
          id: 'local-books',
          label: this.$strings.LabelLocalBooks,
          type: 'book',
          entities: allBooksEntities
        })
      }
      if (podcasts.length) {
        categories.push({
          id: 'local-podcasts',
          label: this.$strings.LabelLocalPodcasts,
          type: 'podcast',
          entities: podcasts
        })
      }

      return categories
    },
    async fetchCategories() {
      console.log(`[categories] fetchCategories networkConnected=${this.networkConnected}, user=${!!this.user}, currentLibraryId=${this.currentLibraryId}, lastServerFetch=${this.lastServerFetch}, lastLocalFetch=${this.lastLocalFetch}`)

      if (this.isFetchingCategories) {
        console.log('[categories] fetchCategories already in progress, skipping')
        return
      }
      this.isFetchingCategories = true

      try {
        // Check connection status once at the start and use it consistently throughout
        const isConnectedToServerWithInternet = this.user && this.currentLibraryId && this.networkConnected
        console.log(`[categories] isConnectedToServerWithInternet=${isConnectedToServerWithInternet}`)

        // Check if we should skip this fetch (too soon after last fetch)
        if (isConnectedToServerWithInternet) {
          if (this.lastServerFetch && Date.now() - this.lastServerFetch < 5000 && this.lastServerFetchLibraryId == this.currentLibraryId) {
            console.log(`[categories] fetchCategories server fetch was ${Date.now() - this.lastServerFetch}ms ago so not doing it.`)
            this.isFetchingCategories = false
            return
          } else {
            console.log(`[categories] fetchCategories fetching from server. Last was ${this.lastServerFetch ? Date.now() - this.lastServerFetch + 'ms' : 'Never'} ago. lastServerFetchLibraryId=${this.lastServerFetchLibraryId} and currentLibraryId=${this.currentLibraryId}`)
            this.lastServerFetchLibraryId = this.currentLibraryId
            this.lastServerFetch = Date.now()
            this.lastLocalFetch = 0
          }
        } else {
          if (this.lastLocalFetch && Date.now() - this.lastLocalFetch < 5000) {
            console.log(`[categories] fetchCategories local fetch was ${Date.now() - this.lastLocalFetch}ms ago so not doing it.`)
            this.isFetchingCategories = false
            return
          } else {
            console.log(`[categories] fetchCategories fetching from local. Last was ${this.lastLocalFetch ? Date.now() - this.lastLocalFetch + 'ms' : 'Never'} ago`)
            this.lastServerFetchLibraryId = null
            this.lastServerFetch = 0
            this.lastLocalFetch = Date.now()
          }
        }

        // Only show skeleton if we have no content yet, otherwise keep existing content during load
        if (!this.shelves.length) {
          this.showingSkeleton = true
        }
        this.isLoading = true

        // Load local library items first
        this.localLibraryItems = await this.$db.getLocalLibraryItems()
        const localCategories = this.getLocalMediaItemCategories()
        console.log('[categories] Local categories computed', localCategories.length, 'isConnectedToServerWithInternet=', isConnectedToServerWithInternet)

        if (isConnectedToServerWithInternet) {
          // Wait up to 5 seconds for server books to load
          const serverTimeoutMs = 5000
          const serverRequest = this.$nativeHttp.get(`/api/libraries/${this.currentLibraryId}/personalized?minified=1&include=rssfeed,numEpisodesIncomplete`, { connectTimeout: 10000 }).catch((error) => {
            console.error('[categories] Failed to fetch categories', error)
            return null
          })

          const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('__timeout__'), serverTimeoutMs))
          const categoriesOrTimeout = await Promise.race([serverRequest, timeoutPromise])

          // Helper function to merge local items with server categories
          const mergeLocalWithServerCategories = (serverCategories) => {
            return serverCategories.map((cat) => {
              if (cat.type == 'book' || cat.type == 'podcast' || cat.type == 'episode') {
                cat.entities = cat.entities.map((entity) => {
                  const localLibraryItem = this.localLibraryItems.find((lli) => {
                    return lli.libraryItemId == entity.id
                  })
                  if (localLibraryItem) {
                    entity.localLibraryItem = localLibraryItem
                  }
                  return entity
                })
              }
              return cat
            })
          }

          // Helper function to combine server and local-only shelves
          const combineServerAndLocalShelves = (serverCats) => {
            const localOnlyShelves = localCategories.filter((cat) => !serverCats.find((sc) => sc.id === cat.id) && cat.type === this.currentLibraryMediaType)
            return [...serverCats, ...localOnlyShelves]
          }

          // Case 1: Server responded before timeout
          if (categoriesOrTimeout !== '__timeout__' && categoriesOrTimeout && categoriesOrTimeout.length) {
            console.log('[categories] Server responded before timeout, displaying combined results immediately')
            const serverCats = mergeLocalWithServerCategories(categoriesOrTimeout)
            const combinedShelves = combineServerAndLocalShelves(serverCats)

            // Update all state together to prevent flash of local content
            // Set flags first to ensure skeleton stays visible during shelf assignment
            this.isLoading = false
            this.firstLoad = false
            // Now update shelves and hide skeleton in same tick
            this.shelves = combinedShelves
            this.showingSkeleton = false
            console.log('[categories] Combined server + local shelves displayed', this.shelves.length, this.lastServerFetch)
            return
          }

          // Case 2: Timeout occurred, show local books only
          console.log('[categories] Server request timed out (5s), displaying local shelves')
          this.shelves = localCategories
          this.showingSkeleton = false
          this.isLoading = false
          this.firstLoad = false

          // Continue waiting for server response in background (if timeout occurred)
          if (categoriesOrTimeout === '__timeout__') {
            console.log('[categories] Waiting for server response in background...')
            try {
              const categories = await serverRequest

              // Case 3: Server eventually responded after timeout
              if (categories && categories.length) {
                console.log('[categories] Server responded after timeout, silently merging results')
                const serverCats = mergeLocalWithServerCategories(categories)

                // Smoothly merge server results without causing visible reload
                // Only update shelves that exist in server response
                serverCats.forEach((scat) => {
                  const existingShelf = this.shelves.find((s) => s && s.id === scat.id)
                  if (existingShelf) {
                    // Update existing shelf in-place to avoid DOM re-render flash
                    existingShelf.label = scat.label
                    existingShelf.type = scat.type
                    existingShelf.entities = scat.entities
                  } else {
                    // Add new server-only shelf
                    this.shelves.push(scat)
                  }
                })

                console.log('[categories] Server shelves silently merged after timeout', this.shelves.length)
              }
            } catch (err) {
              console.log('[categories] Server request failed after timeout, keeping local shelves only')
            }
          } else {
            // Server responded but with empty/invalid data
            console.warn('[categories] Server returned empty/invalid data, using local shelves only')
          }
        } else {
          // When offline or user/library not ready, show local categories
          console.log('[categories] Offline or not connected - showing local shelves only')

          // Show local books immediately (no need for delay)
          this.shelves = localCategories
          this.showingSkeleton = false
          this.isLoading = false
          this.firstLoad = false
          console.log('[categories] Local shelves set (offline/not connected)', this.shelves.length, this.lastLocalFetch)
        }
      } finally {
        this.isFetchingCategories = false
      }
    },
    libraryChanged() {
      if (this.currentLibraryId) {
        console.log(`[categories] libraryChanged so fetching categories`)
        // Reset loading state when library changes
        this.showingSkeleton = true
        this.isLoading = true
        this.firstLoad = true
        this.shelves = []
        this.fetchCategories()
      }
    },
    audiobookAdded(audiobook) {
      // TODO: Check if audiobook would be on this shelf
      if (!this.search) {
        this.fetchCategories()
      }
    },
    audiobookUpdated(audiobook) {
      this.shelves.forEach((shelf) => {
        if (shelf.type === 'books') {
          shelf.entities = shelf.entities.map((ent) => {
            if (ent.id === audiobook.id) {
              return audiobook
            }
            return ent
          })
        } else if (shelf.type === 'series') {
          shelf.entities.forEach((ent) => {
            ent.books = ent.books.map((book) => {
              if (book.id === audiobook.id) return audiobook
              return book
            })
          })
        }
      })
    },
    removeBookFromShelf(audiobook) {
      this.shelves.forEach((shelf) => {
        if (shelf.type === 'books') {
          shelf.entities = shelf.entities.filter((ent) => {
            return ent.id !== audiobook.id
          })
        } else if (shelf.type === 'series') {
          shelf.entities.forEach((ent) => {
            ent.books = ent.books.filter((book) => {
              return book.id !== audiobook.id
            })
          })
        }
      })
    },
    initListeners() {
      this.$eventBus.$on('library-changed', this.libraryChanged)
    },
    removeListeners() {
      this.$eventBus.$off('library-changed', this.libraryChanged)
    }
  },
  async mounted() {
    if (this.$route.query.error) {
      this.$toast.error(this.$route.query.error)
    }

    this.initListeners()
    await this.$store.dispatch('globals/loadLocalMediaProgress')

    // Wait briefly for connection/user/library to be established on first load
    // This prevents showing local books then immediately switching to server books
    if (this.firstLoad) {
      console.log('[categories] First load - waiting briefly (500ms) for connection to establish')
      console.log(`[categories] Before wait: networkConnected=${this.networkConnected}, user=${!!this.user}, libraryId=${this.currentLibraryId}`)
      await new Promise((resolve) => setTimeout(resolve, 500))
      console.log(`[categories] After wait: networkConnected=${this.networkConnected}, user=${!!this.user}, libraryId=${this.currentLibraryId}`)
      this.initialConnectionWaitComplete = true
    }

    console.log(`[categories] mounted so fetching categories`)
    this.fetchCategories()
  },
  beforeDestroy() {
    this.removeListeners()
  }
}
</script>

<style scoped>
/* Material 3 Home Page Loading Animations */
.content-loading {
  opacity: 0.3;
  transition: opacity 400ms cubic-bezier(0.2, 0, 0, 1);
}

.content-loaded {
  opacity: 1;
  animation: contentFadeIn 500ms cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}

@keyframes contentFadeIn {
  0% {
    opacity: 0;
    transform: translateY(16px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Staggered shelf animations */
.shelf-item {
  opacity: 0;
  transform: translateY(20px);
  animation: shelfSlideIn 600ms cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}

@keyframes shelfSlideIn {
  0% {
    opacity: 0;
    transform: translateY(20px);
  }
  70% {
    opacity: 0.8;
    transform: translateY(-2px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Shelf loading delays */
.shelf-delay-0 {
  animation-delay: 0ms;
}
.shelf-delay-1 {
  animation-delay: 150ms;
}
.shelf-delay-2 {
  animation-delay: 300ms;
}
.shelf-delay-3 {
  animation-delay: 450ms;
}
.shelf-delay-4 {
  animation-delay: 600ms;
}
.shelf-delay-5 {
  animation-delay: 750ms;
}
.shelf-delay-6 {
  animation-delay: 900ms;
}

/* Animate updates to existing shelves to reduce jarring flash when server merges */
.shelf-updating {
  animation: shelfUpdate 600ms cubic-bezier(0.2, 0, 0, 1) forwards;
}

@keyframes shelfUpdate {
  0% {
    opacity: 0.6;
    transform: translateY(6px) scale(0.995);
  }
  50% {
    opacity: 0.95;
    transform: translateY(-4px) scale(1.002);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* Shimmer styles for skeleton cards */
.skeleton-card {
  position: relative;
  --shimmer-duration: 1200ms;
}

.shimmer-block {
  position: relative;
  overflow: hidden;
}

.shimmer-block::after {
  content: '';
  position: absolute;
  top: 0;
  left: -150%;
  height: 100%;
  width: 150%;
  /* Use Material 3 on-surface token for shimmer highlight so it follows dynamic colors */
  background: linear-gradient(90deg, transparent, rgba(var(--md-sys-color-on-surface), 0.06), transparent);
  transform: translateX(0);
  animation: shimmer var(--shimmer-duration) linear infinite;
  animation-delay: var(--shimmer-delay, 0ms);
}

.shimmer-ltr .shimmer-block::after {
  animation-direction: normal;
}
.shimmer-rtl .shimmer-block::after {
  animation-direction: reverse;
}

@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

/* Reduce motion for accessibility */
@media (prefers-reduced-motion: reduce) {
  .content-loaded,
  .shelf-item {
    animation: simpleFadeIn 300ms ease-out forwards;
  }

  @keyframes simpleFadeIn {
    0% {
      opacity: 0;
    }
    100% {
      opacity: 1;
    }
  }

  .content-loading {
    transition: opacity 200ms ease-out;
  }
}
</style>
