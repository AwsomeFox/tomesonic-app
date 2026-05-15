<template>
  <div class="w-full h-full min-h-full relative">
    <div
      class="pull-refresh-indicator"
      :class="{
        visible: pullDistance > 0 || isPullRefreshing,
        ready: pullDistance >= pullTriggerDistance,
        refreshing: isPullRefreshing
      }"
      :style="pullIndicatorStyle"
    >
      <span class="material-symbols pull-refresh-icon">{{ isPullRefreshing ? 'autorenew' : 'south' }}</span>
      <span class="pull-refresh-label">{{ pullRefreshLabel }}</span>
    </div>

    <div class="home-page-content" :class="{ 'is-pull-dragging': isPullGestureActive && pullGestureAxis === 'vertical' }" :style="pullContentStyle">
      <!-- Shelf-shaped Material 3 skeletons to match the loaded home layout -->
      <div v-if="showingSkeleton" class="w-full py-3">
        <div v-for="shelfIndex in skeletonShelfCount" :key="`shelf-skel-${shelfIndex}`" class="px-4 pb-5">
          <div
            class="h-5 mb-3 rounded-md bg-surface-variant shimmer-block"
            :class="shelfIndex % 2 === 0 ? 'shimmer-ltr' : 'shimmer-rtl'"
            :style="{
              '--shimmer-delay': shelfIndex * 120 + 'ms',
              width: 120 + (shelfIndex % 3) * 36 + 'px'
            }"
          ></div>

          <div class="flex items-end overflow-x-hidden overflow-y-visible gap-2" :style="{ height: skeletonShelfHeight + 'px', paddingBottom: skeletonEntityPaddingBottom + 'px' }">
            <div
              v-for="cardIndex in skeletonCardsPerShelf"
              :key="`card-skel-${shelfIndex}-${cardIndex}`"
              :class="['bg-surface-container rounded-2xl shadow-elevation-1 overflow-hidden skeleton-card', cardIndex % 2 === 0 ? 'shimmer-rtl' : 'shimmer-ltr']"
              :style="{
                '--shimmer-delay': shelfIndex * 120 + cardIndex * 90 + 'ms',
                width: bookSkeletonWidth + 'px',
                height: bookSkeletonHeight + 'px'
              }"
            >
              <div class="w-full h-full bg-surface-variant shimmer-block relative">
                <div v-if="altViewEnabled" class="absolute left-0 right-0 bottom-0 px-3 py-2 space-y-2">
                  <div class="h-3.5 bg-surface shimmer-block rounded-md w-4/5"></div>
                  <div class="h-3 bg-surface shimmer-block rounded-md w-3/5"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!showingSkeleton" class="w-full" :class="{ 'py-3': altViewEnabled }" :style="contentPaddingStyle">
        <div v-for="shelf in shelves" :key="shelf.id" class="home-shelf-row">
          <bookshelf-shelf :label="getShelfLabel(shelf)" :entities="shelf.entities" :type="shelf.type" :shelf-id="shelf.id" :animate-items="false" />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { clearAudioPeopleStatsCache, getAudioPeopleStatsForLibrary, isBookEntityAudioCapable } from '@/plugins/audioFiltering'

const homeShelfCache = new Map()
const HOME_SHELF_CACHE_MAX = 8

function setHomeShelfCacheEntry(key, value) {
  if (!key) return
  if (homeShelfCache.has(key)) {
    homeShelfCache.delete(key)
  }
  homeShelfCache.set(key, value)

  if (homeShelfCache.size > HOME_SHELF_CACHE_MAX) {
    const oldestKey = homeShelfCache.keys().next().value
    if (oldestKey) {
      homeShelfCache.delete(oldestKey)
    }
  }
}

export default {
  name: 'BookshelfHomePage',
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
      initialConnectionWaitComplete: false,
      seriesIdLookupByLibrary: {},
      seriesRefsByLibraryItemId: {},
      seriesCountByIdByLibrary: {},
      seriesCoverBooksByLibrarySeries: {},
      seriesStartedBookCountByLibrarySeries: {},
      seriesTotalBookCountByLibrarySeries: {},
      authorLookupByLibrary: {},
      authorCountByIdByLibrary: {},
      pullDistance: 0,
      isPullRefreshing: false,
      isPullGestureActive: false,
      pullGestureAxis: 'none',
      pullStartY: 0,
      pullStartX: 0,
      pullTriggerDistance: 86,
      pullMaxDistance: 132,
      _bookshelfWrapperEl: null,
      listenersInitialized: false,
      isPageActive: true,
      loadedLibraryId: null,
      restoredFromCacheAt: 0
    }
  },
  watch: {
    networkConnected(newVal) {
      if (!this.isPageActive) return
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
      if (!this.isPageActive) return
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
      if (!this.isPageActive) return
      // When library ID changes (but not on initial load)
      if (newVal && oldVal && newVal !== oldVal) {
        console.log('[categories] Library ID switched from', oldVal, 'to', newVal, '- resetting and refetching')
        clearAudioPeopleStatsCache(oldVal)
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
    },
    hideNonAudiobooks(newVal, oldVal) {
      if (!this.isPageActive) return
      if (newVal === oldVal) return

      clearAudioPeopleStatsCache(this.currentLibraryId)
      this.fetchCategories({ force: true })
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
    hideNonAudiobooks() {
      return this.$store.getters['getHideNonAudiobooksGlobal']
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
    skeletonShelfCount() {
      return 4
    },
    skeletonCardsPerShelf() {
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 390
      const cardsThatFit = Math.ceil((viewportWidth - 32) / (this.bookSkeletonWidth + 8))
      return Math.max(4, Math.min(8, cardsThatFit + 1))
    },
    skeletonShelfHeight() {
      if (this.altViewEnabled) {
        return this.bookSkeletonHeight + 25
      }
      return this.bookSkeletonHeight + 24
    },
    skeletonEntityPaddingBottom() {
      if (!this.altViewEnabled) return 0
      return 15
    },
    pullProgress() {
      if (!this.pullTriggerDistance) return 0
      return Math.min(1, this.pullDistance / this.pullTriggerDistance)
    },
    pullRefreshLabel() {
      if (this.isPullRefreshing) return 'Refreshing...'
      if (this.pullDistance >= this.pullTriggerDistance) return 'Release to refresh'
      return 'Pull to refresh'
    },
    pullIndicatorStyle() {
      // Keep indicator hidden above content until user starts pulling.
      const translateY = Math.min(18, -52 + this.pullDistance)
      return {
        transform: `translate(-50%, ${translateY}px)`
      }
    },
    pullContentStyle() {
      if (this.pullDistance <= 0) return {}
      return {
        transform: `translate3d(0, ${this.pullDistance}px, 0)`
      }
    }
  },
  methods: {
    getShelfLabel(shelf) {
      if (shelf.labelStringKey && this.$strings[shelf.labelStringKey]) return this.$strings[shelf.labelStringKey]
      return shelf.label
    },
    buildHomeShelfCacheKey() {
      return [this.currentLibraryId || 'none', this.hideNonAudiobooks ? 'audio' : 'all'].join('::')
    },
    hasSuspiciousContinueSeriesCounts(shelves = this.shelves) {
      if (!Array.isArray(shelves) || !shelves.length) return false

      const continueSeriesShelf = shelves.find((shelf) => this.isContinueSeriesShelf(shelf) && shelf?.type === 'series' && Array.isArray(shelf.entities))
      if (!continueSeriesShelf) return false

      return continueSeriesShelf.entities.some((seriesEntity) => {
        const total = Number(seriesEntity?.numBooks || 0)
        // Continue-series should represent multi-book series; 0/1 here indicates stale
        // or incomplete normalization data and should trigger a fresh server refresh.
        return !Number.isFinite(total) || total <= 1
      })
    },
    restoreHomeShelfCache() {
      const cacheKey = this.buildHomeShelfCacheKey()
      const cachedEntry = homeShelfCache.get(cacheKey)
      if (!cachedEntry) return false

      this.shelves = Array.isArray(cachedEntry.shelves) ? cachedEntry.shelves.map((shelf) => ({ ...shelf })) : []
      this.showingSkeleton = !this.shelves.length
      this.isLoading = false
      this.firstLoad = !this.shelves.length
      this.lastServerFetch = Number(cachedEntry.lastServerFetch || 0)
      this.lastServerFetchLibraryId = this.currentLibraryId || null
      this.loadedLibraryId = this.currentLibraryId || this.loadedLibraryId
      this.restoredFromCacheAt = Date.now()
      return this.shelves.length > 0
    },
    saveHomeShelfCache() {
      if (!this.currentLibraryId || !Array.isArray(this.shelves) || !this.shelves.length) return
      const cacheKey = this.buildHomeShelfCacheKey()
      setHomeShelfCacheEntry(cacheKey, {
        shelves: this.shelves.map((shelf) => ({ ...shelf })),
        lastServerFetch: this.lastServerFetch,
        savedAt: Date.now()
      })
    },
    getBookshelfWrapper() {
      return document.getElementById('bookshelf-wrapper')
    },
    bindPullToRefresh() {
      const wrapper = this.getBookshelfWrapper()
      if (!wrapper) return

      if (this._bookshelfWrapperEl === wrapper) return
      this.unbindPullToRefresh()

      this._bookshelfWrapperEl = wrapper
      wrapper.addEventListener('touchstart', this.onPullStart, { passive: true })
      // Keep this passive so normal vertical scroll is never blocked by pull-to-refresh logic.
      wrapper.addEventListener('touchmove', this.onPullMove, { passive: true })
      wrapper.addEventListener('touchend', this.onPullEnd, { passive: true })
      wrapper.addEventListener('touchcancel', this.onPullEnd, { passive: true })
    },
    unbindPullToRefresh() {
      if (!this._bookshelfWrapperEl) return

      this._bookshelfWrapperEl.removeEventListener('touchstart', this.onPullStart)
      this._bookshelfWrapperEl.removeEventListener('touchmove', this.onPullMove)
      this._bookshelfWrapperEl.removeEventListener('touchend', this.onPullEnd)
      this._bookshelfWrapperEl.removeEventListener('touchcancel', this.onPullEnd)
      this._bookshelfWrapperEl = null
    },
    onPullStart(event) {
      if (this.isPullRefreshing || this.isFetchingCategories) return

      const wrapper = this._bookshelfWrapperEl || this.getBookshelfWrapper()
      if (!wrapper || wrapper.scrollTop > 0) return
      if (!event.touches || !event.touches.length) return

      const touch = event.touches[0]
      this.isPullGestureActive = true
      this.pullGestureAxis = 'none'
      this.pullStartY = touch.clientY
      this.pullStartX = touch.clientX
    },
    onPullMove(event) {
      if (!this.isPullGestureActive || this.isPullRefreshing) return
      if (!event.touches || !event.touches.length) return

      const wrapper = this._bookshelfWrapperEl || this.getBookshelfWrapper()
      if (!wrapper) {
        this.cancelPullGesture(true)
        return
      }

      const touch = event.touches[0]
      const deltaY = touch.clientY - this.pullStartY
      const deltaX = touch.clientX - this.pullStartX

      if (this.pullGestureAxis === 'none' && (Math.abs(deltaY) > 6 || Math.abs(deltaX) > 6)) {
        this.pullGestureAxis = Math.abs(deltaY) > Math.abs(deltaX) ? 'vertical' : 'horizontal'
      }

      if (this.pullGestureAxis === 'horizontal') {
        this.cancelPullGesture(true)
        return
      }

      // If user starts regular vertical scrolling, immediately release pull handling.
      if (wrapper.scrollTop > 0 || deltaY <= 0) {
        this.cancelPullGesture(true)
        return
      }

      const nextPullDistance = this.getPullDistanceWithResistance(deltaY)
      if (Math.abs(nextPullDistance - this.pullDistance) >= 1) {
        this.pullDistance = nextPullDistance
      }
    },
    async onPullEnd() {
      if (!this.isPullGestureActive) return

      const shouldRefresh = this.pullGestureAxis === 'vertical' && this.pullDistance >= this.pullTriggerDistance
      this.isPullGestureActive = false
      this.pullGestureAxis = 'none'

      if (shouldRefresh) {
        await this.triggerPullRefresh()
      } else {
        this.pullDistance = 0
      }
    },
    cancelPullGesture(resetDistance = false) {
      this.isPullGestureActive = false
      this.pullGestureAxis = 'none'
      if (resetDistance) this.pullDistance = 0
    },
    getPullDistanceWithResistance(rawDistance) {
      const easedDistance = rawDistance * 0.45
      return Math.min(this.pullMaxDistance, easedDistance)
    },
    async triggerPullRefresh() {
      if (this.isPullRefreshing) return

      this.isPullRefreshing = true
      this.pullDistance = 56

      try {
        if (this.$hapticsImpactLight) {
          await this.$hapticsImpactLight()
        }
      } catch (error) {
        // Ignore haptics failures and continue refresh.
      }

      try {
        await this.fetchCategories({ force: true })
      } finally {
        this.isPullRefreshing = false
        this.pullDistance = 0
      }
    },
    isContinueSeriesShelf(shelf) {
      return shelf?.id === 'continue-series' || shelf?.labelStringKey === 'LabelContinueSeries'
    },
    isContinueReadingShelf(shelf) {
      return shelf?.id === 'continue-reading' || shelf?.id === 'continue-listening' || shelf?.labelStringKey === 'LabelContinueReading' || shelf?.labelStringKey === 'LabelContinueListening'
    },
    isContinueAuthorsShelf(shelf) {
      return shelf?.id === 'continue-authors'
    },
    isContinueNarratorsShelf(shelf) {
      return shelf?.id === 'continue-narrators'
    },
    unwrapBookEntity(bookEntity) {
      if (!bookEntity) return null
      return bookEntity.libraryItem || bookEntity.item || bookEntity.libraryItemWrapper || bookEntity
    },
    getNormalizedPersonNameCandidates(name) {
      if (!name || typeof name !== 'string') return []
      const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ')

      if (!normalized) return []
      return [normalized]
    },
    getBookProgress(bookEntity) {
      const source = this.unwrapBookEntity(bookEntity) || bookEntity
      return bookEntity?.userMediaProgress || source?.userMediaProgress || bookEntity?.mediaProgress || source?.mediaProgress || bookEntity?.progress || source?.progress || null
    },
    getAuthorRefsFromBookEntity(bookEntity) {
      const source = this.unwrapBookEntity(bookEntity) || bookEntity
      const refs = []
      const metadata = source?.media?.metadata || source?.metadata || source?.mediaMetadata || null

      const parseAuthorRef = (candidate) => {
        if (!candidate) return null

        if (typeof candidate === 'string') {
          return {
            id: null,
            name: candidate,
            libraryId: source?.libraryId || null
          }
        }

        const nestedAuthor = candidate.author || null
        const id = candidate.id || candidate.authorId || nestedAuthor?.id || null
        const name = candidate.name || nestedAuthor?.name || candidate.authorName || null
        if (!name && !id) return null

        return {
          id,
          name: name || 'Unknown Author',
          libraryId: candidate.libraryId || nestedAuthor?.libraryId || source?.libraryId || null,
          numBooks: Number(candidate.numBooks || nestedAuthor?.numBooks || 0)
        }
      }

      const rawAuthors = metadata?.authors || source?.authors || source?.media?.authors
      const authors = Array.isArray(rawAuthors) ? rawAuthors : rawAuthors ? [rawAuthors] : []
      authors.forEach((authorRef) => {
        const parsed = parseAuthorRef(authorRef)
        if (parsed) refs.push(parsed)
      })

      const fallbackAuthorName = metadata?.authorName || metadata?.author || source?.authorName || source?.author || source?.media?.authorName || source?.media?.author || null
      if (!refs.length && fallbackAuthorName) {
        const parsedFallback = parseAuthorRef(fallbackAuthorName)
        if (parsedFallback) refs.push(parsedFallback)
      }

      const deduped = []
      const keys = new Set()
      refs.forEach((ref) => {
        const key = ref.id || (ref.name ? `name:${ref.name.toLowerCase()}` : null)
        if (key && !keys.has(key)) {
          keys.add(key)
          deduped.push(ref)
        }
      })

      return deduped
    },
    getNarratorRefsFromBookEntity(bookEntity) {
      const source = this.unwrapBookEntity(bookEntity) || bookEntity
      const refs = []
      const metadata = source?.media?.metadata || source?.metadata || source?.mediaMetadata || null

      const toNarratorNameList = (rawValue) => {
        if (!rawValue) return []

        if (Array.isArray(rawValue)) {
          return rawValue.flatMap((value) => toNarratorNameList(value)).filter((value, index, arr) => arr.indexOf(value) === index)
        }

        if (typeof rawValue === 'string') {
          return rawValue
            .split(/[,;]\s*/)
            .map((value) => value.trim())
            .filter(Boolean)
        }

        return []
      }

      const parseNarratorRef = (candidate) => {
        if (!candidate) return null

        if (typeof candidate === 'string') {
          return {
            name: candidate,
            libraryId: source?.libraryId || null
          }
        }

        const name = candidate.name || candidate.narratorName || candidate.narrator || candidate.displayName || null
        if (!name) return null

        return {
          name,
          libraryId: candidate.libraryId || source?.libraryId || null
        }
      }

      const rawNarrators = metadata?.narrators || source?.narrators || source?.media?.narrators
      const narrators = Array.isArray(rawNarrators) ? rawNarrators : rawNarrators ? [rawNarrators] : []
      narrators.forEach((narratorRef) => {
        const parsed = parseNarratorRef(narratorRef)
        if (parsed) refs.push(parsed)
      })

      // Some book payloads expose narrators as a single string (e.g. narratorName)
      // rather than an array. Expand those into narrator refs as a fallback.
      const fallbackNarratorNames = [metadata?.narratorName, metadata?.narrator, source?.narratorName, source?.narrator, source?.media?.narratorName, source?.media?.narrator]
      fallbackNarratorNames.forEach((fallbackValue) => {
        toNarratorNameList(fallbackValue).forEach((narratorName) => {
          const parsed = parseNarratorRef(narratorName)
          if (parsed) refs.push(parsed)
        })
      })

      const deduped = []
      const keys = new Set()
      refs.forEach((ref) => {
        const normalizedName = this.getNormalizedPersonNameCandidates(ref.name)[0]
        if (!normalizedName) return
        if (keys.has(normalizedName)) return
        keys.add(normalizedName)
        deduped.push(ref)
      })

      return deduped
    },
    getSeriesRefsFromBookEntity(bookEntity) {
      const source = this.unwrapBookEntity(bookEntity) || bookEntity
      const refs = []
      const metadata = source?.media?.metadata || source?.metadata || source?.mediaMetadata || null
      const metadataSeriesName = metadata?.seriesName || source?.seriesName || source?.media?.seriesName || null
      const collapsedSeries = source?.collapsedSeries || source?.media?.collapsedSeries || null
      const parseSeriesRef = (candidate) => {
        if (!candidate) return null

        if (typeof candidate === 'string') {
          return {
            id: null,
            name: candidate,
            libraryId: source?.libraryId || this.currentLibraryId || null
          }
        }

        const nestedSeries = candidate.series || null
        const id = candidate.id || candidate.seriesId || nestedSeries?.id || nestedSeries?.seriesId || null
        const name = candidate.name || nestedSeries?.name || metadataSeriesName || 'Unknown Series'

        if (!id && !name) return null
        return {
          id,
          name,
          libraryId: candidate.libraryId || nestedSeries?.libraryId || source?.libraryId || this.currentLibraryId || null
        }
      }

      if (collapsedSeries?.id || collapsedSeries?.seriesId || collapsedSeries?.name || collapsedSeries?.title) {
        const collapsedSeriesRef = parseSeriesRef({
          id: collapsedSeries.id,
          seriesId: collapsedSeries.seriesId,
          name: collapsedSeries.name || collapsedSeries.title,
          libraryId: collapsedSeries.libraryId || source?.libraryId || this.currentLibraryId || null
        })
        if (collapsedSeriesRef) refs.push(collapsedSeriesRef)
      }

      const rawMetadataSeries = metadata?.series || source?.series || source?.media?.series
      const metadataSeries = Array.isArray(rawMetadataSeries) ? rawMetadataSeries : rawMetadataSeries ? [rawMetadataSeries] : []
      metadataSeries.forEach((seriesRef) => {
        const parsedSeriesRef = parseSeriesRef(seriesRef)
        if (parsedSeriesRef) refs.push(parsedSeriesRef)
      })

      if (!refs.length && metadataSeriesName) {
        refs.push({
          id: null,
          name: metadataSeriesName,
          libraryId: source?.libraryId || this.currentLibraryId || null
        })
      }

      const deduped = []
      const keys = new Set()
      refs.forEach((ref) => {
        const key = ref.id || (ref.name ? `name:${ref.name.toLowerCase()}` : null)
        if (key && !keys.has(key)) {
          keys.add(key)
          deduped.push(ref)
        }
      })

      return deduped
    },
    async getSeriesLookupForLibrary(libraryId) {
      if (!libraryId) return {}
      if (this.seriesIdLookupByLibrary[libraryId]) return this.seriesIdLookupByLibrary[libraryId]

      const nameToId = {}
      const countById = {}
      const limit = 1000
      let page = 0
      let keepPaging = true

      while (keepPaging && page < 20) {
        const payload = await this.$nativeHttp.get(`/api/libraries/${libraryId}/series?minified=1&limit=${limit}&page=${page}`, { connectTimeout: 10000 }).catch((error) => {
          console.error('[categories] Failed to load series lookup', error)
          return null
        })

        if (!payload) break

        const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : []

        results.forEach((seriesEntity) => {
          if (!seriesEntity?.id || !seriesEntity?.name) return
          const resolvedCount = Number(seriesEntity.numBooks || seriesEntity.audiobookCount || seriesEntity.totalBooks || (Array.isArray(seriesEntity.books) ? seriesEntity.books.length : 0) || 0)
          if (resolvedCount > 0) {
            countById[seriesEntity.id] = resolvedCount
          }
          this.getNormalizedSeriesNameCandidates(seriesEntity.name).forEach((nameKey) => {
            nameToId[nameKey] = seriesEntity.id
          })
          if (seriesEntity.nameIgnorePrefix) {
            this.getNormalizedSeriesNameCandidates(seriesEntity.nameIgnorePrefix).forEach((nameKey) => {
              nameToId[nameKey] = seriesEntity.id
            })
          }
        })

        if (!Array.isArray(payload?.results)) {
          keepPaging = false
        } else {
          const total = payload?.total || results.length
          page += 1
          keepPaging = page * limit < total
        }
      }

      // Some servers omit total-count fields from minified series payloads. When that
      // happens, run a second non-minified pass to backfill authoritative numBooks.
      if (Object.keys(nameToId).length > 0 && Object.keys(countById).length === 0) {
        let fullPage = 0
        let keepFullPaging = true

        while (keepFullPaging && fullPage < 20) {
          const fullPayload = await this.$nativeHttp.get(`/api/libraries/${libraryId}/series?limit=${limit}&page=${fullPage}`, { connectTimeout: 12000 }).catch(() => null)
          if (!fullPayload) break

          const fullResults = Array.isArray(fullPayload?.results) ? fullPayload.results : Array.isArray(fullPayload) ? fullPayload : []

          fullResults.forEach((seriesEntity) => {
            if (!seriesEntity?.id || !seriesEntity?.name) return

            const totalCandidates = [seriesEntity.numBooks, seriesEntity.audiobookCount, seriesEntity.totalBooks, seriesEntity.numItems, Array.isArray(seriesEntity.books) ? seriesEntity.books.length : 0]
            for (const candidate of totalCandidates) {
              const parsed = Number(candidate)
              if (Number.isFinite(parsed) && parsed > 0) {
                countById[seriesEntity.id] = parsed
                break
              }
            }

            // Ensure name lookup is fully hydrated from the richer payload as well.
            this.getNormalizedSeriesNameCandidates(seriesEntity.name).forEach((nameKey) => {
              nameToId[nameKey] = seriesEntity.id
            })
            if (seriesEntity.nameIgnorePrefix) {
              this.getNormalizedSeriesNameCandidates(seriesEntity.nameIgnorePrefix).forEach((nameKey) => {
                nameToId[nameKey] = seriesEntity.id
              })
            }
          })

          if (!Array.isArray(fullPayload?.results)) {
            keepFullPaging = false
          } else {
            const total = Number(fullPayload?.total || fullResults.length)
            fullPage += 1
            keepFullPaging = fullPage * limit < total
          }
        }
      }

      this.$set(this.seriesIdLookupByLibrary, libraryId, nameToId)
      this.$set(this.seriesCountByIdByLibrary, libraryId, countById)
      return nameToId
    },
    async getAuthorLookupForLibrary(libraryId) {
      if (!libraryId) return {}
      if (this.authorLookupByLibrary[libraryId]) return this.authorLookupByLibrary[libraryId]

      const lookupByName = {}
      const countById = {}

      const payload = await this.$nativeHttp.get(`/api/libraries/${libraryId}/authors`, { connectTimeout: 10000 }).catch((error) => {
        console.error('[categories] Failed to load author lookup', error)
        return null
      })

      const authors = Array.isArray(payload?.authors) ? payload.authors : Array.isArray(payload) ? payload : []
      authors.forEach((authorEntity) => {
        if (!authorEntity?.id || !authorEntity?.name) return
        const normalizedCandidates = this.getNormalizedPersonNameCandidates(authorEntity.name)
        normalizedCandidates.forEach((nameKey) => {
          lookupByName[nameKey] = {
            id: authorEntity.id,
            name: authorEntity.name,
            numBooks: Number(authorEntity.numBooks || authorEntity.totalBooks || 0)
          }
        })

        const resolvedCount = Number(authorEntity.numBooks || authorEntity.totalBooks || 0)
        if (resolvedCount > 0) {
          countById[authorEntity.id] = resolvedCount
        }
      })

      this.$set(this.authorLookupByLibrary, libraryId, lookupByName)
      this.$set(this.authorCountByIdByLibrary, libraryId, countById)
      return lookupByName
    },
    async getPeopleStatsForCurrentLibrary(options = {}) {
      if (!this.currentLibraryId) {
        return {
          authorTotalsById: {},
          authorTotalsByName: {},
          authorAudioCountsById: {},
          authorAudioCountsByName: {},
          narratorTotalsByName: {},
          narratorAudioCountsByName: {}
        }
      }

      return getAudioPeopleStatsForLibrary({
        libraryId: this.currentLibraryId,
        nativeHttp: this.$nativeHttp,
        encode: this.$encode,
        includeEbookOnly: !!this.hideNonAudiobooks,
        forceRefresh: !!options.forceRefresh
      })
    },
    getAuthorBooksCountFromPeopleStats(authorEntity, peopleStats, fallbackCount = 0) {
      if (!authorEntity || !peopleStats) return Number(fallbackCount || 0)

      const authorId = authorEntity.id
      const hasIdTotal = authorId ? Object.prototype.hasOwnProperty.call(peopleStats.authorTotalsById || {}, authorId) : false
      const hasIdAudio = authorId ? Object.prototype.hasOwnProperty.call(peopleStats.authorAudioCountsById || {}, authorId) : false

      const idCountFromTotals = hasIdTotal ? Number(peopleStats.authorTotalsById?.[authorId] || 0) : null
      const idCountFromAudio = hasIdAudio ? Number(peopleStats.authorAudioCountsById?.[authorId] || 0) : null

      const normalizedName = this.getNormalizedPersonNameCandidates(authorEntity.name)[0]
      const hasNameTotal = normalizedName ? Object.prototype.hasOwnProperty.call(peopleStats.authorTotalsByName || {}, normalizedName) : false
      const hasNameAudio = normalizedName ? Object.prototype.hasOwnProperty.call(peopleStats.authorAudioCountsByName || {}, normalizedName) : false

      const nameCountFromTotals = hasNameTotal ? Number(peopleStats.authorTotalsByName?.[normalizedName] || 0) : null
      const nameCountFromAudio = hasNameAudio ? Number(peopleStats.authorAudioCountsByName?.[normalizedName] || 0) : null

      if (this.hideNonAudiobooks) {
        if (idCountFromAudio !== null) return Math.max(0, Number(idCountFromAudio || 0))
        if (nameCountFromAudio !== null) return Math.max(0, Number(nameCountFromAudio || 0))
      }

      if (idCountFromTotals !== null) return Math.max(0, Number(idCountFromTotals || 0))
      if (nameCountFromTotals !== null) return Math.max(0, Number(nameCountFromTotals || 0))

      return Number(fallbackCount || 0)
    },
    getNarratorBooksCountFromPeopleStats(narratorEntity, peopleStats, fallbackCount = 0) {
      if (!narratorEntity || !peopleStats) return Number(fallbackCount || 0)

      const normalizedName = this.getNormalizedPersonNameCandidates(narratorEntity.name)[0]
      if (!normalizedName) return Number(fallbackCount || 0)

      if (this.hideNonAudiobooks) {
        if (Object.prototype.hasOwnProperty.call(peopleStats.narratorAudioCountsByName || {}, normalizedName)) {
          const audioCount = Number(peopleStats.narratorAudioCountsByName?.[normalizedName] || 0)
          return Math.max(0, audioCount)
        }
      }

      if (Object.prototype.hasOwnProperty.call(peopleStats.narratorTotalsByName || {}, normalizedName)) {
        const totalCount = Number(peopleStats.narratorTotalsByName?.[normalizedName] || 0)
        return Math.max(0, totalCount)
      }

      return Number(fallbackCount || 0)
    },
    isAudioCapableBookEntity(entity) {
      return isBookEntityAudioCapable(entity)
    },
    getSeriesCountForId(seriesId, libraryId = null) {
      if (!seriesId) return 0

      if (libraryId && this.seriesCountByIdByLibrary[libraryId]?.[seriesId]) {
        return this.seriesCountByIdByLibrary[libraryId][seriesId]
      }

      const libraryIds = Object.keys(this.seriesCountByIdByLibrary)
      for (let i = 0; i < libraryIds.length; i += 1) {
        const lookup = this.seriesCountByIdByLibrary[libraryIds[i]]
        if (lookup?.[seriesId]) return lookup[seriesId]
      }

      return 0
    },
    async getSeriesCoverBooksForSeries(libraryId, seriesId) {
      if (!libraryId || !seriesId) return []
      const cacheKey = `${libraryId}::${seriesId}`
      if (Array.isArray(this.seriesCoverBooksByLibrarySeries[cacheKey]) && this.seriesStartedBookCountByLibrarySeries[cacheKey] !== undefined) {
        return this.seriesCoverBooksByLibrarySeries[cacheKey]
      }

      const encodedSeriesId = this.$encode ? this.$encode(seriesId) : btoa(seriesId)
      const payload = await this.$nativeHttp.get(`/api/libraries/${libraryId}/items?minified=1&sort=media.metadata.title&filter=series.${encodedSeriesId}&limit=1000&page=0`, { connectTimeout: 10000 }).catch(() => null)

      const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : []

      const startedBooks = results.reduce((count, book) => {
        const progress = this.$store.getters['user/getUserMediaProgress'](book?.id)
        if (progress && (progress.isFinished || Number(progress.progress || 0) > 0)) {
          return count + 1
        }
        return count
      }, 0)

      const totalCandidates = [payload?.total, payload?.totalResults, payload?.numResults, payload?.count, results.length]
      let totalBooks = 0
      for (const candidate of totalCandidates) {
        const parsed = Number(candidate)
        if (Number.isFinite(parsed) && parsed > 0) {
          totalBooks = parsed
          break
        }
      }

      const coverBooks = results.slice(0, 4)
      this.$set(this.seriesCoverBooksByLibrarySeries, cacheKey, coverBooks)
      this.$set(this.seriesStartedBookCountByLibrarySeries, cacheKey, startedBooks)
      this.$set(this.seriesTotalBookCountByLibrarySeries, cacheKey, totalBooks)
      return coverBooks
    },
    getSeriesStartedBookCountForSeries(libraryId, seriesId) {
      if (!libraryId || !seriesId) return 0
      const cacheKey = `${libraryId}::${seriesId}`
      return Number(this.seriesStartedBookCountByLibrarySeries[cacheKey] || 0)
    },
    getSeriesTotalBookCountForSeries(libraryId, seriesId) {
      if (!libraryId || !seriesId) return 0
      const cacheKey = `${libraryId}::${seriesId}`
      return Number(this.seriesTotalBookCountByLibrarySeries[cacheKey] || 0)
    },
    async getSeriesTotalBookCountBySeriesId(seriesId) {
      if (!seriesId) return 0
      const encodedSeriesId = encodeURIComponent(seriesId)
      const seriesPayload = await this.$nativeHttp.get(`/api/series/${encodedSeriesId}`, { connectTimeout: 10000 }).catch(() => null)
      if (!seriesPayload) return 0

      const totalCandidates = [seriesPayload?.numBooks, seriesPayload?.audiobookCount, seriesPayload?.totalBooks, seriesPayload?.numItems, Array.isArray(seriesPayload?.books) ? seriesPayload.books.length : 0]
      for (const candidate of totalCandidates) {
        const parsed = Number(candidate)
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed
        }
      }

      return 0
    },
    async enrichSeriesCoverBooks(normalizedSeries) {
      if (!Array.isArray(normalizedSeries) || !normalizedSeries.length) return

      await Promise.all(
        normalizedSeries.map(async (seriesEntity) => {
          if (!seriesEntity?.id || !seriesEntity?.libraryId) {
            seriesEntity.coverBooks = Array.isArray(seriesEntity?.books) ? seriesEntity.books.slice(0, 4) : []
            seriesEntity.numStartedBooks = 0
            return
          }

          const coverBooks = await this.getSeriesCoverBooksForSeries(seriesEntity.libraryId, seriesEntity.id)
          if (coverBooks.length) {
            seriesEntity.coverBooks = coverBooks
          } else {
            seriesEntity.coverBooks = Array.isArray(seriesEntity?.books) ? seriesEntity.books.slice(0, 4) : []
          }
          seriesEntity.numStartedBooks = this.getSeriesStartedBookCountForSeries(seriesEntity.libraryId, seriesEntity.id)
          // Prefer the authoritative total from the per-series items fetch over whatever
          // the personalized/categories payload reported (often missing or 1 for continue-series).
          let resolvedTotal = this.getSeriesTotalBookCountForSeries(seriesEntity.libraryId, seriesEntity.id)

          // Some continue-series entries carry a non-canonical id that can return 0/1
          // from the items filter endpoint. If we have a better canonical id by name
          // in the library lookup, prefer that count.
          if (resolvedTotal <= 1 && seriesEntity?.name) {
            const lookupByName = this.seriesIdLookupByLibrary[seriesEntity.libraryId] || {}
            const nameCandidates = this.getNormalizedSeriesNameCandidates(seriesEntity.name)
            for (let i = 0; i < nameCandidates.length; i += 1) {
              const mappedSeriesId = lookupByName[nameCandidates[i]]
              if (!mappedSeriesId) continue
              const mappedCount = Number(this.getSeriesCountForId(mappedSeriesId, seriesEntity.libraryId) || 0)
              if (mappedCount > resolvedTotal) {
                resolvedTotal = mappedCount
              }
            }
          }

          // Final fallback: query the canonical series endpoint directly for true totals
          // when all shelf/minified-derived sources still report 0/1.
          if (resolvedTotal <= 1) {
            const lookupByName = this.seriesIdLookupByLibrary[seriesEntity.libraryId] || {}
            const mappedIdCandidates = seriesEntity?.name
              ? this.getNormalizedSeriesNameCandidates(seriesEntity.name)
                  .map((nameKey) => lookupByName[nameKey])
                  .filter(Boolean)
              : []

            const endpointIdsToTry = Array.from(new Set([seriesEntity.id, ...mappedIdCandidates].filter(Boolean)))
            for (let i = 0; i < endpointIdsToTry.length; i += 1) {
              const endpointSeriesId = endpointIdsToTry[i]
              const endpointTotal = await this.getSeriesTotalBookCountBySeriesId(endpointSeriesId)
              if (endpointTotal > resolvedTotal) {
                resolvedTotal = endpointTotal
                if (endpointSeriesId !== seriesEntity.id) {
                  seriesEntity.id = endpointSeriesId
                }
              }
            }
          }

          if (resolvedTotal > 0) {
            seriesEntity.numBooks = resolvedTotal
            if (seriesEntity.libraryId && seriesEntity.id) {
              const cacheKey = `${seriesEntity.libraryId}::${seriesEntity.id}`
              this.$set(this.seriesTotalBookCountByLibrarySeries, cacheKey, resolvedTotal)

              if (!this.seriesCountByIdByLibrary[seriesEntity.libraryId]) {
                this.$set(this.seriesCountByIdByLibrary, seriesEntity.libraryId, {})
              }
              this.$set(this.seriesCountByIdByLibrary[seriesEntity.libraryId], seriesEntity.id, resolvedTotal)
            }
          }
        })
      )
    },
    getNormalizedSeriesNameCandidates(name) {
      if (!name || typeof name !== 'string') return []

      const candidates = new Set()
      const normalized = name.trim().toLowerCase()
      if (!normalized) return []

      candidates.add(normalized)

      const withoutHashNumber = normalized.replace(/\s*#\d+(\.\d+)?$/i, '').trim()
      if (withoutHashNumber) candidates.add(withoutHashNumber)

      const withoutBookNumber = normalized.replace(/(?:,\s*|\s+)(book|volume|vol\.|part)\s+\d+(\.\d+)?$/i, '').trim()
      if (withoutBookNumber) candidates.add(withoutBookNumber)

      return Array.from(candidates)
    },
    async enrichContinueShelvesWithExpandedSeries(serverCategories) {
      if (!Array.isArray(serverCategories) || !serverCategories.length) return

      const continueShelves = serverCategories.filter((shelf) => this.isContinueReadingShelf(shelf) && shelf?.type === 'book' && Array.isArray(shelf?.entities) && shelf.entities.length)
      if (!continueShelves.length) return

      const unresolvedItems = []
      continueShelves.forEach((shelf) => {
        shelf.entities.forEach((bookEntity) => {
          const sourceBook = this.unwrapBookEntity(bookEntity) || bookEntity
          const refs = this.getSeriesRefsFromBookEntity(sourceBook)
          const hasSeriesId = refs.some((ref) => !!ref?.id)
          if (!hasSeriesId && sourceBook?.id) {
            unresolvedItems.push({ bookEntity, sourceBookId: sourceBook.id })
          }
        })
      })

      if (!unresolvedItems.length) return

      const uniqueIds = Array.from(new Set(unresolvedItems.map((item) => item.sourceBookId)))
      await Promise.all(
        uniqueIds.map(async (itemId) => {
          if (this.seriesRefsByLibraryItemId[itemId]) return

          const expandedItem = await this.$nativeHttp.get(`/api/items/${itemId}?expanded=1`, { connectTimeout: 10000 }).catch(() => null)
          if (!expandedItem) {
            this.$set(this.seriesRefsByLibraryItemId, itemId, [])
            return
          }

          const refs = this.getSeriesRefsFromBookEntity(expandedItem).filter((ref) => !!ref?.id)
          this.$set(this.seriesRefsByLibraryItemId, itemId, refs)
        })
      )

      unresolvedItems.forEach(({ bookEntity, sourceBookId }) => {
        const refs = this.seriesRefsByLibraryItemId[sourceBookId] || []
        if (!refs.length) return

        if (!bookEntity.media) {
          this.$set(bookEntity, 'media', {})
        }
        if (!bookEntity.media.metadata) {
          this.$set(bookEntity.media, 'metadata', {})
        }

        this.$set(
          bookEntity.media.metadata,
          'series',
          refs.map((ref) => ({ id: ref.id, name: ref.name }))
        )

        if (!bookEntity.media.metadata.seriesName && refs[0]?.name) {
          this.$set(bookEntity.media.metadata, 'seriesName', refs[0].name)
        }
      })
    },
    extractServerCategories(serverPayload) {
      if (Array.isArray(serverPayload)) return serverPayload
      if (Array.isArray(serverPayload?.shelves)) return serverPayload.shelves
      if (Array.isArray(serverPayload?.categories)) return serverPayload.categories
      if (Array.isArray(serverPayload?.results)) return serverPayload.results
      return []
    },
    async normalizeContinueSeriesCategories(serverCategories, seriesLookup = null) {
      if (!Array.isArray(serverCategories) || !serverCategories.length) return serverCategories || []

      const continueSeriesShelf = serverCategories.find((shelf) => this.isContinueSeriesShelf(shelf))
      const continueReadingShelf = serverCategories.find((shelf) => this.isContinueReadingShelf(shelf) && shelf.type === 'book')
      const seriesMap = new Map()
      const knownSeriesIdsByName = new Map()

      if (seriesLookup) {
        Object.keys(seriesLookup).forEach((seriesNameKey) => {
          const seriesId = seriesLookup[seriesNameKey]
          if (seriesNameKey && seriesId) {
            knownSeriesIdsByName.set(seriesNameKey, seriesId)
          }
        })
      }

      serverCategories.forEach((shelf) => {
        if (shelf?.type !== 'series' || !Array.isArray(shelf.entities)) return
        shelf.entities.forEach((seriesEntity) => {
          if (!seriesEntity?.id || !seriesEntity?.name) return
          this.getNormalizedSeriesNameCandidates(seriesEntity.name).forEach((nameKey) => {
            knownSeriesIdsByName.set(nameKey, seriesEntity.id)
          })
        })
      })

      if (continueSeriesShelf && continueSeriesShelf.type === 'book' && Array.isArray(continueSeriesShelf.entities)) {
        continueSeriesShelf.entities.forEach((bookEntity) => {
          const refs = this.getSeriesRefsFromBookEntity(bookEntity)
          refs.forEach((ref) => {
            if (ref?.id && ref?.name) {
              this.getNormalizedSeriesNameCandidates(ref.name).forEach((nameKey) => {
                knownSeriesIdsByName.set(nameKey, ref.id)
              })
            }
          })
        })
      }

      const resolveSeriesRef = (seriesRef) => {
        if (!seriesRef) return null
        const resolvedLibraryId = seriesRef.libraryId || this.currentLibraryId || null
        const originalId = seriesRef.id || null
        const nameCandidates = this.getNormalizedSeriesNameCandidates(seriesRef.name)
        let mappedId = null

        if (nameCandidates.length) {
          nameCandidates.some((nameKey) => {
            const found = knownSeriesIdsByName.get(nameKey)
            if (found) {
              mappedId = found
              return true
            }
            return false
          })
        }

        let resolvedId = originalId || mappedId

        // Some continue-series payloads provide a non-canonical id that carries a 0/1 count.
        // When we can map a canonical id from the normalized series name, prefer it.
        if (originalId && mappedId && originalId !== mappedId) {
          resolvedId = mappedId
        }

        if (!resolvedId) {
          return {
            ...seriesRef,
            libraryId: resolvedLibraryId
          }
        }

        return {
          ...seriesRef,
          id: resolvedId,
          libraryId: resolvedLibraryId
        }
      }

      const upsertSeries = (seriesRef, sourceBook = null, score = 0) => {
        if (!seriesRef?.id) return

        const resolvedLibraryId = seriesRef.libraryId || sourceBook?.libraryId || this.currentLibraryId || null
        const hintedCount = Number(seriesRef.numBooks || seriesRef.audiobookCount || seriesRef.totalBooks || seriesRef.booksCount || 0)
        const lookupCount = Number(this.getSeriesCountForId(seriesRef.id, resolvedLibraryId) || 0)
        const resolvedCount = Math.max(Number.isFinite(hintedCount) ? hintedCount : 0, Number.isFinite(lookupCount) ? lookupCount : 0)

        const existing = seriesMap.get(seriesRef.id)
        if (!existing) {
          seriesMap.set(seriesRef.id, {
            id: seriesRef.id,
            name: seriesRef.name || 'Unknown Series',
            libraryId: resolvedLibraryId,
            numBooks: resolvedCount,
            coverBooks: [],
            books: sourceBook ? [sourceBook] : [],
            _score: score || 0
          })
          return
        }

        if ((!existing.name || existing.name === 'Unknown Series') && seriesRef.name) existing.name = seriesRef.name
        if (!existing.libraryId && (seriesRef.libraryId || sourceBook?.libraryId || this.currentLibraryId)) {
          existing.libraryId = seriesRef.libraryId || sourceBook?.libraryId || this.currentLibraryId
        }

        if (resolvedCount > (existing.numBooks || 0)) {
          existing.numBooks = resolvedCount
        }

        const sourceBookId = sourceBook?.id || sourceBook?.libraryItemId || sourceBook?.media?.id
        if (sourceBookId && !existing.books.find((b) => (b?.id || b?.libraryItemId || b?.media?.id) === sourceBookId)) {
          existing.books.push(sourceBook)
        }

        if (score > existing._score) {
          existing._score = score
        }
      }

      if (continueSeriesShelf && Array.isArray(continueSeriesShelf.entities)) {
        if (continueSeriesShelf.type === 'series') {
          continueSeriesShelf.entities.forEach((seriesEntity) => {
            if (!seriesEntity?.id) return
            const seriesBooks = Array.isArray(seriesEntity.books) ? seriesEntity.books : []
            const seriesScore = seriesBooks.reduce((maxScore, book) => {
              const bookScore = book?.userMediaProgress?.lastUpdate || 0
              return Math.max(maxScore, bookScore)
            }, 0)

            const resolvedSeriesRef = resolveSeriesRef({
              id: seriesEntity.id,
              name: seriesEntity.name || 'Unknown Series',
              libraryId: seriesEntity.libraryId || this.currentLibraryId || null,
              numBooks: seriesEntity.numBooks || seriesEntity.audiobookCount || seriesEntity.totalBooks || 0
            })

            upsertSeries(resolvedSeriesRef, null, seriesScore)

            seriesBooks.forEach((seriesBook) => {
              const resolvedBookSeriesRef = resolveSeriesRef({
                id: seriesEntity.id,
                name: seriesEntity.name || 'Unknown Series',
                libraryId: seriesEntity.libraryId || seriesBook?.libraryId || this.currentLibraryId || null,
                numBooks: seriesEntity.numBooks || seriesEntity.audiobookCount || seriesEntity.totalBooks || 0
              })

              upsertSeries(resolvedBookSeriesRef, seriesBook, seriesBook?.userMediaProgress?.lastUpdate || 0)
            })
          })
        } else {
          continueSeriesShelf.entities.forEach((bookEntity) => {
            const bookProgress = this.getBookProgress(bookEntity)
            const sourceBook = this.unwrapBookEntity(bookEntity) || bookEntity
            const score = bookProgress?.lastUpdate || sourceBook?.updatedAt || sourceBook?.addedAt || 0
            const seriesRefs = this.getSeriesRefsFromBookEntity(sourceBook)
            seriesRefs.forEach((seriesRef) => {
              const resolvedSeriesRef = resolveSeriesRef(seriesRef)
              upsertSeries(resolvedSeriesRef, sourceBook, score)
            })
          })
        }
      }

      const continueReadingShelves = serverCategories.filter((shelf) => this.isContinueReadingShelf(shelf) && shelf.type === 'book' && Array.isArray(shelf.entities))
      continueReadingShelves.forEach((shelf) => {
        shelf.entities.forEach((bookEntity) => {
          const progress = this.getBookProgress(bookEntity)
          const sourceBook = this.unwrapBookEntity(bookEntity) || bookEntity

          if (this.hideNonAudiobooks && !this.isAudioCapableBookEntity(sourceBook)) {
            return
          }

          const score = progress?.lastUpdate || sourceBook?.updatedAt || sourceBook?.addedAt || 0
          const seriesRefs = this.getSeriesRefsFromBookEntity(sourceBook)
          if (!seriesRefs.length) return

          seriesRefs.forEach((seriesRef) => {
            const resolvedSeriesRef = resolveSeriesRef(seriesRef)
            upsertSeries(resolvedSeriesRef, sourceBook, score)
          })
        })
      })

      const normalizedSeries = Array.from(seriesMap.values())
        .sort((a, b) => {
          if (b._score !== a._score) return b._score - a._score
          return (a.name || '').localeCompare(b.name || '')
        })
        .map((seriesEntity) => {
          return {
            id: seriesEntity.id,
            name: seriesEntity.name || 'Unknown Series',
            libraryId: seriesEntity.libraryId || this.currentLibraryId || null,
            // Tentative; will be overwritten with the authoritative total by enrichSeriesCoverBooks below.
            numBooks: seriesEntity.numBooks || seriesEntity.audiobookCount || 0,
            numStartedBooks: Number(seriesEntity.numStartedBooks || 0),
            coverBooks: Array.isArray(seriesEntity.coverBooks) ? seriesEntity.coverBooks : [],
            books: seriesEntity.books
          }
        })

      if (!normalizedSeries.length) return serverCategories

      // Resolve real per-series totals/started counts from the items endpoint, then filter
      // single-book series so we don't accidentally hide multi-book series whose initial
      // numBooks was wrong (e.g. 0 or 1 from minified/personalized payloads).
      await this.enrichSeriesCoverBooks(normalizedSeries)

      const dedupedSeriesById = new Map()
      normalizedSeries.forEach((seriesEntity) => {
        if (!seriesEntity?.id) return

        const existing = dedupedSeriesById.get(seriesEntity.id)
        if (!existing) {
          dedupedSeriesById.set(seriesEntity.id, seriesEntity)
          return
        }

        const existingCount = Number(existing.numBooks || 0)
        const nextCount = Number(seriesEntity.numBooks || 0)
        if (nextCount > existingCount) {
          existing.numBooks = nextCount
        }

        const existingStarted = Number(existing.numStartedBooks || 0)
        const nextStarted = Number(seriesEntity.numStartedBooks || 0)
        if (nextStarted > existingStarted) {
          existing.numStartedBooks = nextStarted
        }

        if ((!existing.name || existing.name === 'Unknown Series') && seriesEntity.name) {
          existing.name = seriesEntity.name
        }
        if (!existing.libraryId && seriesEntity.libraryId) {
          existing.libraryId = seriesEntity.libraryId
        }

        if ((!Array.isArray(existing.coverBooks) || !existing.coverBooks.length) && Array.isArray(seriesEntity.coverBooks) && seriesEntity.coverBooks.length) {
          existing.coverBooks = seriesEntity.coverBooks
        }

        if (Array.isArray(seriesEntity.books) && seriesEntity.books.length) {
          const existingBookIds = new Set((existing.books || []).map((book) => book?.id || book?.libraryItemId || book?.media?.id).filter(Boolean))
          const mergedBooks = [...(existing.books || [])]
          seriesEntity.books.forEach((book) => {
            const bookId = book?.id || book?.libraryItemId || book?.media?.id
            if (bookId && !existingBookIds.has(bookId)) {
              existingBookIds.add(bookId)
              mergedBooks.push(book)
            }
          })
          existing.books = mergedBooks
        }
      })

      const normalizedDedupedSeries = Array.from(dedupedSeriesById.values())

      const filteredSeries = normalizedDedupedSeries.filter((seriesEntity) => {
        const totalBooks = Number(seriesEntity.numBooks || 0)
        return totalBooks === 0 || totalBooks > 1
      })

      if (!filteredSeries.length) return serverCategories

      if (continueSeriesShelf) {
        continueSeriesShelf.type = 'series'
        continueSeriesShelf.entities = filteredSeries
        if (!continueSeriesShelf.label) continueSeriesShelf.label = this.$strings.LabelContinueSeries
        if (!continueSeriesShelf.labelStringKey) continueSeriesShelf.labelStringKey = 'LabelContinueSeries'
        return serverCategories
      }

      const newContinueSeriesShelf = {
        id: 'continue-series',
        label: this.$strings.LabelContinueSeries,
        labelStringKey: 'LabelContinueSeries',
        type: 'series',
        entities: filteredSeries
      }

      const continueReadingIndex = serverCategories.findIndex((shelf) => this.isContinueReadingShelf(shelf))
      if (continueReadingIndex >= 0) {
        serverCategories.splice(continueReadingIndex + 1, 0, newContinueSeriesShelf)
      } else {
        serverCategories.unshift(newContinueSeriesShelf)
      }

      return serverCategories
    },
    async normalizeContinuePeopleCategories(serverCategories, authorLookup = null, options = {}) {
      if (!Array.isArray(serverCategories) || !serverCategories.length) return serverCategories || []

      const includeRemoteStats = options.includeRemoteStats !== false

      const continueReadingShelves = serverCategories.filter((shelf) => this.isContinueReadingShelf(shelf) && shelf?.type === 'book' && Array.isArray(shelf?.entities) && shelf.entities.length)
      if (!continueReadingShelves.length) return serverCategories

      const authorMap = new Map()
      const narratorMap = new Map()

      const resolveAuthorRef = (authorRef) => {
        if (!authorRef) return null

        const resolvedLibraryId = authorRef.libraryId || this.currentLibraryId || null
        if (authorRef.id) {
          return {
            ...authorRef,
            libraryId: resolvedLibraryId,
            numBooks: Number(authorRef.numBooks || this.authorCountByIdByLibrary[resolvedLibraryId]?.[authorRef.id] || 0)
          }
        }

        const nameCandidates = this.getNormalizedPersonNameCandidates(authorRef.name)
        if (!nameCandidates.length) return null

        let resolved = null
        nameCandidates.some((nameKey) => {
          const lookupHit = authorLookup?.[nameKey]
          if (lookupHit?.id) {
            resolved = {
              id: lookupHit.id,
              name: lookupHit.name || authorRef.name,
              libraryId: resolvedLibraryId,
              numBooks: Number(lookupHit.numBooks || 0)
            }
            return true
          }
          return false
        })

        return resolved
      }

      const upsertAuthor = (authorRef, sourceBook, score = 0) => {
        if (!authorRef?.id || !authorRef?.name) return

        const bookId = sourceBook?.id || sourceBook?.libraryItemId || null
        const existing = authorMap.get(authorRef.id)
        if (!existing) {
          const entry = {
            id: authorRef.id,
            name: authorRef.name,
            libraryId: authorRef.libraryId || sourceBook?.libraryId || this.currentLibraryId || null,
            numBooks: Number(authorRef.numBooks || 0),
            _score: score || 0,
            _bookIds: new Set(),
            _books: []
          }
          if (bookId) {
            entry._bookIds.add(bookId)
            if (sourceBook && entry._books.length < 4) {
              entry._books.push(sourceBook)
            }
          }
          authorMap.set(authorRef.id, entry)
          return
        }

        if ((!existing.name || existing.name === 'Unknown Author') && authorRef.name) {
          existing.name = authorRef.name
        }
        if (!existing.libraryId && (authorRef.libraryId || sourceBook?.libraryId || this.currentLibraryId)) {
          existing.libraryId = authorRef.libraryId || sourceBook?.libraryId || this.currentLibraryId || null
        }
        if (Number(authorRef.numBooks || 0) > Number(existing.numBooks || 0)) {
          existing.numBooks = Number(authorRef.numBooks || 0)
        }
        if (score > existing._score) {
          existing._score = score
        }
        if (bookId) {
          existing._bookIds.add(bookId)
          if (sourceBook && existing._books.length < 4) {
            const alreadyAdded = existing._books.some((book) => {
              const existingBookId = book?.id || book?.libraryItemId || null
              return existingBookId && existingBookId === bookId
            })
            if (!alreadyAdded) {
              existing._books.push(sourceBook)
            }
          }
        }
      }

      const upsertNarrator = (narratorRef, sourceBook, score = 0) => {
        if (!narratorRef?.name) return

        const normalizedName = this.getNormalizedPersonNameCandidates(narratorRef.name)[0]
        if (!normalizedName) return

        const bookId = sourceBook?.id || sourceBook?.libraryItemId || null
        const existing = narratorMap.get(normalizedName)
        if (!existing) {
          const entry = {
            id: `narrator:${this.$encode(narratorRef.name)}`,
            name: narratorRef.name,
            libraryId: narratorRef.libraryId || sourceBook?.libraryId || this.currentLibraryId || null,
            numBooks: 0,
            _score: score || 0,
            _bookIds: new Set(),
            _books: []
          }
          if (bookId) {
            entry._bookIds.add(bookId)
            if (sourceBook && entry._books.length < 4) {
              entry._books.push(sourceBook)
            }
          }
          narratorMap.set(normalizedName, entry)
          return
        }

        if (score > existing._score) {
          existing._score = score
        }
        if (!existing.libraryId && (narratorRef.libraryId || sourceBook?.libraryId || this.currentLibraryId)) {
          existing.libraryId = narratorRef.libraryId || sourceBook?.libraryId || this.currentLibraryId || null
        }
        if (bookId) {
          existing._bookIds.add(bookId)
          if (sourceBook && existing._books.length < 4) {
            const alreadyAdded = existing._books.some((book) => {
              const existingBookId = book?.id || book?.libraryItemId || null
              return existingBookId && existingBookId === bookId
            })
            if (!alreadyAdded) {
              existing._books.push(sourceBook)
            }
          }
        }
      }

      continueReadingShelves.forEach((shelf) => {
        shelf.entities.forEach((bookEntity) => {
          const progress = this.getBookProgress(bookEntity)
          const sourceBook = this.unwrapBookEntity(bookEntity) || bookEntity
          const score = progress?.lastUpdate || sourceBook?.updatedAt || sourceBook?.addedAt || 0

          const authorRefs = this.getAuthorRefsFromBookEntity(sourceBook)
          authorRefs.forEach((authorRef) => {
            const resolvedAuthorRef = resolveAuthorRef(authorRef)
            upsertAuthor(resolvedAuthorRef, sourceBook, score)
          })

          const narratorRefs = this.getNarratorRefsFromBookEntity(sourceBook)
          narratorRefs.forEach((narratorRef) => {
            upsertNarrator(narratorRef, sourceBook, score)
          })
        })
      })

      const peopleStats = includeRemoteStats ? await this.getPeopleStatsForCurrentLibrary() : null

      const normalizedAuthors = Array.from(authorMap.values())
        .sort((a, b) => {
          if (b._score !== a._score) return b._score - a._score
          return (a.name || '').localeCompare(b.name || '')
        })
        .map((authorEntity) => {
          const observedBooks = authorEntity._bookIds?.size || 0
          const fallbackCount = Number(authorEntity.numBooks || observedBooks || 0)
          return {
            id: authorEntity.id,
            name: authorEntity.name || 'Unknown Author',
            libraryId: this.currentLibraryId || null,
            numBooks: includeRemoteStats ? this.getAuthorBooksCountFromPeopleStats(authorEntity, peopleStats, fallbackCount) : fallbackCount,
            coverBooks: Array.isArray(authorEntity._books) ? authorEntity._books.slice(0, 4) : []
          }
        })

      const filteredAuthors = normalizedAuthors.filter((authorEntity) => {
        const totalBooks = Number(authorEntity?.numBooks || 0)
        if (this.hideNonAudiobooks && totalBooks <= 0) return false
        if (includeRemoteStats && totalBooks === 1) return false
        return true
      })

      const normalizedNarrators = Array.from(narratorMap.values())
        .sort((a, b) => {
          if (b._score !== a._score) return b._score - a._score
          return (a.name || '').localeCompare(b.name || '')
        })
        .map((narratorEntity) => {
          const observedBooks = narratorEntity._bookIds?.size || 0
          const fallbackCount = Number(observedBooks || narratorEntity.numBooks || 0)
          return {
            id: narratorEntity.id,
            name: narratorEntity.name,
            libraryId: narratorEntity.libraryId || this.currentLibraryId || null,
            numBooks: includeRemoteStats ? this.getNarratorBooksCountFromPeopleStats(narratorEntity, peopleStats, fallbackCount) : fallbackCount,
            coverBooks: Array.isArray(narratorEntity._books) ? narratorEntity._books.slice(0, 4) : []
          }
        })

      const filteredNarrators = normalizedNarrators.filter((narratorEntity) => {
        const totalBooks = Number(narratorEntity?.numBooks || 0)
        if (this.hideNonAudiobooks && totalBooks <= 0) return false
        if (includeRemoteStats && totalBooks === 1) return false
        return true
      })

      // Remove existing continue-people shelves first, then re-insert in deterministic order.
      const peopleShelfIndexes = []
      serverCategories.forEach((shelf, index) => {
        if (this.isContinueAuthorsShelf(shelf) || this.isContinueNarratorsShelf(shelf)) {
          peopleShelfIndexes.push(index)
        }
      })
      peopleShelfIndexes
        .sort((a, b) => b - a)
        .forEach((index) => {
          serverCategories.splice(index, 1)
        })

      const continueSeriesIndex = serverCategories.findIndex((shelf) => this.isContinueSeriesShelf(shelf))
      const continueReadingIndex = serverCategories.findIndex((shelf) => this.isContinueReadingShelf(shelf))
      const baseInsertIndex = continueSeriesIndex >= 0 ? continueSeriesIndex : continueReadingIndex

      let insertIndex = baseInsertIndex >= 0 ? baseInsertIndex + 1 : 0

      if (filteredAuthors.length) {
        serverCategories.splice(insertIndex, 0, {
          id: 'continue-authors',
          label: `Continue ${this.$strings.LabelAuthors || 'Authors'}`,
          type: 'authors',
          entities: filteredAuthors
        })
        insertIndex += 1
      }

      if (filteredNarrators.length) {
        serverCategories.splice(insertIndex, 0, {
          id: 'continue-narrators',
          label: `Continue ${this.$strings.LabelNarrators || 'Narrators'}`,
          type: 'authors',
          entities: filteredNarrators
        })
      }

      return serverCategories
    },
    async applyAudiobookOnlyFilterToCategories(serverCategories) {
      if (!Array.isArray(serverCategories) || !serverCategories.length) return serverCategories || []
      if (!this.hideNonAudiobooks) return serverCategories

      const peopleStats = await this.getPeopleStatsForCurrentLibrary()

      return serverCategories
        .map((shelf) => {
          if (!Array.isArray(shelf?.entities)) return shelf

          if (shelf.type === 'book') {
            const entities = shelf.entities.filter((entity) => this.isAudioCapableBookEntity(entity))
            return {
              ...shelf,
              entities
            }
          }

          if (shelf.type === 'series') {
            const entities = shelf.entities
              .map((seriesEntity) => {
                const filteredBooks = Array.isArray(seriesEntity?.books) ? seriesEntity.books.filter((book) => this.isAudioCapableBookEntity(book)) : []
                const filteredCoverBooks = Array.isArray(seriesEntity?.coverBooks) ? seriesEntity.coverBooks.filter((book) => this.isAudioCapableBookEntity(book)).slice(0, 4) : filteredBooks.slice(0, 4)

                // Do not collapse total series count to filteredBooks.length here.
                // Continue-series entities often carry only sampled/in-progress books in
                // `books`, so length can be 1 even when the true series total is much larger.
                const countCandidates = [seriesEntity?.audiobookCount, seriesEntity?.numBooks, seriesEntity?.totalBooks, filteredBooks.length, filteredCoverBooks.length]
                let resolvedTotal = 0
                for (const candidate of countCandidates) {
                  const parsed = Number(candidate)
                  if (Number.isFinite(parsed) && parsed > resolvedTotal) {
                    resolvedTotal = parsed
                  }
                }

                return {
                  ...seriesEntity,
                  books: filteredBooks,
                  coverBooks: filteredCoverBooks,
                  numBooks: resolvedTotal
                }
              })
              .filter((seriesEntity) => Array.isArray(seriesEntity.books) && seriesEntity.books.length > 0)

            return {
              ...shelf,
              entities
            }
          }

          if (shelf.type === 'authors') {
            const isNarratorShelf = this.isContinueNarratorsShelf(shelf) || shelf.entities.some((entity) => `${entity?.id || ''}`.startsWith('narrator:'))
            const entities = shelf.entities
              .map((entity) => {
                if (isNarratorShelf) {
                  return {
                    ...entity,
                    numBooks: this.getNarratorBooksCountFromPeopleStats(entity, peopleStats, Number(entity?.numBooks || 0))
                  }
                }

                return {
                  ...entity,
                  numBooks: this.getAuthorBooksCountFromPeopleStats(entity, peopleStats, Number(entity?.numBooks || 0))
                }
              })
              .filter((entity) => Number(entity?.numBooks || 0) > 0)

            return {
              ...shelf,
              entities
            }
          }

          return shelf
        })
        .filter((shelf) => !Array.isArray(shelf?.entities) || shelf.entities.length > 0)
    },
    applyShelvesInOrder(incomingShelves) {
      if (!Array.isArray(incomingShelves)) return

      const existingById = {}
      this.shelves.forEach((shelf) => {
        if (shelf?.id) {
          existingById[shelf.id] = shelf
        }
      })

      const orderedShelves = incomingShelves.map((incomingShelf) => {
        const existingShelf = incomingShelf?.id ? existingById[incomingShelf.id] : null
        if (!existingShelf) return incomingShelf

        existingShelf.label = incomingShelf.label
        existingShelf.labelStringKey = incomingShelf.labelStringKey
        existingShelf.type = incomingShelf.type
        existingShelf.entities = incomingShelf.entities
        existingShelf.localOnly = incomingShelf.localOnly
        return existingShelf
      })

      this.shelves = orderedShelves
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
          if (this.hideNonAudiobooks && !this.isAudioCapableBookEntity(item)) {
            return
          }

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
    async fetchCategories(options = {}) {
      const forceRefresh = !!options.force
      if (forceRefresh && this.currentLibraryId) {
        clearAudioPeopleStatsCache(this.currentLibraryId)
      }
      if (!this.isPageActive) {
        console.log('[categories] fetchCategories skipped because page is inactive')
        return
      }
      if (this.currentLibraryId) {
        this.loadedLibraryId = this.currentLibraryId
      }
      console.log(`[categories] fetchCategories networkConnected=${this.networkConnected}, user=${!!this.user}, currentLibraryId=${this.currentLibraryId}, lastServerFetch=${this.lastServerFetch}, lastLocalFetch=${this.lastLocalFetch}, force=${forceRefresh}`)

      if (this.isFetchingCategories) {
        console.log('[categories] fetchCategories already in progress, skipping')
        return
      }
      this.isFetchingCategories = true

      try {
        // Check connection status once at the start and use it consistently throughout
        const hasInternetConnection = !!this.networkConnected
        const isConnectedToServerWithInternet = this.user && this.currentLibraryId && this.networkConnected
        console.log(`[categories] hasInternetConnection=${hasInternetConnection} isConnectedToServerWithInternet=${isConnectedToServerWithInternet}`)

        // Do not render local-only shelves when internet is available.
        // Wait for server context (user + library) and keep/return to skeleton instead.
        if (hasInternetConnection && !isConnectedToServerWithInternet) {
          const showingLocalOnlyShelves = this.shelves.length > 0 && this.lastServerFetch === 0
          if (showingLocalOnlyShelves) {
            this.shelves = []
          }
          this.showingSkeleton = true
          this.isLoading = true
          console.log('[categories] Internet is available but server context is not ready yet. Waiting before rendering shelves.')
          return
        }

        // Check if we should skip this fetch (too soon after last fetch)
        if (isConnectedToServerWithInternet) {
          if (!forceRefresh && this.lastServerFetch && Date.now() - this.lastServerFetch < 5000 && this.lastServerFetchLibraryId == this.currentLibraryId) {
            console.log(`[categories] fetchCategories server fetch was ${Date.now() - this.lastServerFetch}ms ago so not doing it.`)
            this.isFetchingCategories = false
            return
          }

          console.log(`[categories] fetchCategories fetching from server. Last was ${this.lastServerFetch ? Date.now() - this.lastServerFetch + 'ms' : 'Never'} ago. lastServerFetchLibraryId=${this.lastServerFetchLibraryId} and currentLibraryId=${this.currentLibraryId}`)
          this.lastServerFetchLibraryId = this.currentLibraryId
          this.lastServerFetch = Date.now()
          this.lastLocalFetch = 0
        } else {
          if (!forceRefresh && this.lastLocalFetch && Date.now() - this.lastLocalFetch < 5000) {
            console.log(`[categories] fetchCategories local fetch was ${Date.now() - this.lastLocalFetch}ms ago so not doing it.`)
            this.isFetchingCategories = false
            return
          }

          console.log(`[categories] fetchCategories fetching from local. Last was ${this.lastLocalFetch ? Date.now() - this.lastLocalFetch + 'ms' : 'Never'} ago`)
          this.lastServerFetchLibraryId = null
          this.lastServerFetch = 0
          this.lastLocalFetch = Date.now()
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
          const serverPayload = await this.$nativeHttp.get(`/api/libraries/${this.currentLibraryId}/personalized?minified=1&include=rssfeed,numEpisodesIncomplete,series`, { connectTimeout: 15000 }).catch((error) => {
            console.error('[categories] Failed to fetch categories', error)
            return null
          })

          const attachLocalItemsToServerCategories = (serverCats) => {
            if (!Array.isArray(serverCats)) return []

            return serverCats.map((cat) => {
              if ((cat.type == 'book' || cat.type == 'podcast' || cat.type == 'episode') && Array.isArray(cat.entities)) {
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

          // Helper function to merge local items with server categories
          const mergeLocalWithServerCategories = async (incomingServerPayload) => {
            const extractedCategories = this.extractServerCategories(incomingServerPayload)
            if (!extractedCategories.length) return []

            await this.enrichContinueShelvesWithExpandedSeries(extractedCategories)

            const shouldLoadContinueLookups = extractedCategories.some((shelf) => {
              const hasEntities = Array.isArray(shelf?.entities) && shelf.entities.length
              if (!hasEntities) return false

              if (this.isContinueReadingShelf(shelf) && shelf?.type === 'book') {
                return true
              }

              if (this.isContinueSeriesShelf(shelf) && (shelf?.type === 'book' || shelf?.type === 'series')) {
                return true
              }

              return false
            })
            const seriesLookup = shouldLoadContinueLookups ? await this.getSeriesLookupForLibrary(this.currentLibraryId) : null
            const authorLookup = shouldLoadContinueLookups ? await this.getAuthorLookupForLibrary(this.currentLibraryId) : null

            let normalizedCategories = extractedCategories
            try {
              const maybeNormalized = await this.normalizeContinueSeriesCategories(extractedCategories, seriesLookup)
              normalizedCategories = Array.isArray(maybeNormalized) ? maybeNormalized : extractedCategories
            } catch (error) {
              console.error('[categories] Failed to normalize continue-series categories, falling back to raw server categories', error)
              normalizedCategories = extractedCategories
            }

            try {
              const maybePeopleNormalized = await this.normalizeContinuePeopleCategories(normalizedCategories, authorLookup, {
                includeRemoteStats: true
              })
              normalizedCategories = Array.isArray(maybePeopleNormalized) ? maybePeopleNormalized : normalizedCategories
            } catch (error) {
              console.error('[categories] Failed to normalize continue-author/narrator categories, continuing without people shelves', error)
            }

            try {
              const maybeAudioFiltered = await this.applyAudiobookOnlyFilterToCategories(normalizedCategories)
              normalizedCategories = Array.isArray(maybeAudioFiltered) ? maybeAudioFiltered : normalizedCategories
            } catch (error) {
              console.error('[categories] Failed to apply audiobook-only filtering on home categories', error)
            }

            return attachLocalItemsToServerCategories(normalizedCategories)
          }

          // Helper function to combine server and local-only shelves
          const combineServerAndLocalShelves = (serverCats) => {
            if (!Array.isArray(serverCats) || !serverCats.length) return localCategories
            const localOnlyShelves = localCategories.filter((cat) => !serverCats.find((sc) => sc.id === cat.id) && cat.type === this.currentLibraryMediaType)
            return [...serverCats, ...localOnlyShelves]
          }

          const serverCategories = await mergeLocalWithServerCategories(serverPayload)
          if (Array.isArray(serverCategories) && serverCategories.length) {
            const combinedShelves = combineServerAndLocalShelves(serverCategories)
            this.shelves = combinedShelves
            this.showingSkeleton = false
            this.isLoading = false
            this.firstLoad = false
            this.saveHomeShelfCache()
            console.log('[categories] Server shelves displayed after full enrichment', this.shelves.length, this.lastServerFetch)
            return
          }

          console.warn('[categories] Server returned empty/invalid data, falling back to local shelves')
          this.shelves = localCategories
          this.showingSkeleton = false
          this.isLoading = false
          this.firstLoad = false
          this.saveHomeShelfCache()
        } else {
          // When offline or user/library not ready, show local categories
          console.log('[categories] Offline or not connected - showing local shelves only')

          // Cold-start guard: on first load, if we haven't completed the initial
          // connection wait yet, hold the skeleton instead of flashing local-only
          // shelves that will be replaced by the server fetch a moment later.
          if (this.firstLoad && !this.initialConnectionWaitComplete) {
            console.log('[categories] First load before initialConnectionWaitComplete - holding skeleton')
            this.showingSkeleton = !this.shelves.length
            this.isLoading = true
            this.lastLocalFetch = 0
            return
          }

          // Show local books immediately (no need for delay)
          this.shelves = localCategories
          this.showingSkeleton = false
          this.isLoading = false
          this.firstLoad = false
          this.saveHomeShelfCache()
          console.log('[categories] Local shelves set (offline/not connected)', this.shelves.length, this.lastLocalFetch)
        }
      } finally {
        this.isFetchingCategories = false
      }
    },
    libraryChanged() {
      if (this.currentLibraryId) {
        console.log(`[categories] libraryChanged so fetching categories`)
        clearAudioPeopleStatsCache()
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
      if (this.listenersInitialized) return
      this.$eventBus.$on('library-changed', this.libraryChanged)
      this.$nextTick(() => {
        this.bindPullToRefresh()
      })
      this.listenersInitialized = true
    },
    removeListeners() {
      if (!this.listenersInitialized) return
      this.$eventBus.$off('library-changed', this.libraryChanged)
      this.unbindPullToRefresh()
      this.listenersInitialized = false
    }
  },
  async mounted() {
    this.isPageActive = true
    if (this.$route.query.error) {
      this.$toast.error(this.$route.query.error)
    }

    this.initListeners()
    await this.$store.dispatch('globals/loadLocalMediaProgress')

    const restoredFromCache = this.restoreHomeShelfCache()
    const cacheLooksStaleForContinueSeries = restoredFromCache && this.hasSuspiciousContinueSeriesCounts(this.shelves)
    if (restoredFromCache && !cacheLooksStaleForContinueSeries && this.lastServerFetch && Date.now() - this.lastServerFetch < 30000) {
      console.log('[categories] Restored home shelves from cache and skipping immediate refetch')
      this.initialConnectionWaitComplete = true
      return
    }

    if (cacheLooksStaleForContinueSeries) {
      console.log('[categories] Restored cache has stale continue-series totals; forcing immediate refetch')
    }

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
  activated() {
    this.isPageActive = true
    this.initListeners()
    if (!this.shelves.length) {
      this.fetchCategories()
      return
    }

    if (this.currentLibraryId && this.loadedLibraryId && this.currentLibraryId !== this.loadedLibraryId) {
      this.showingSkeleton = true
      this.isLoading = true
      this.firstLoad = true
      this.shelves = []
      this.fetchCategories()
    }
  },
  deactivated() {
    this.isPageActive = false
    this.saveHomeShelfCache()
    this.cancelPullGesture(true)
    this.removeListeners()
  },
  beforeDestroy() {
    this.saveHomeShelfCache()
    this.cancelPullGesture(true)
    this.removeListeners()
  }
}
</script>

<style scoped>
.home-page-content {
  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1);
  will-change: transform;
}

.home-shelf-row {
  content-visibility: auto;
  contain-intrinsic-size: 260px;
  /* Promote each shelf to its own compositor layer so cross-row paints
     don't bleed during vertical scrolling on the home page. */
  contain: content;
  transform: translateZ(0);
  will-change: transform;
}

.home-page-content.is-pull-dragging {
  transition: none;
}

.pull-refresh-indicator {
  position: absolute;
  top: 0;
  left: 50%;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(var(--md-sys-color-outline-variant), 0.4);
  background: rgba(var(--md-sys-color-surface-container-high), 0.92);
  color: rgb(var(--md-sys-color-on-surface-variant));
  opacity: 0;
  pointer-events: none;
  box-shadow: var(--md-sys-elevation-level1);
}

.pull-refresh-indicator.visible {
  opacity: 1;
}

.pull-refresh-indicator.ready {
  color: rgb(var(--md-sys-color-primary));
}

.pull-refresh-indicator.refreshing .pull-refresh-icon {
  animation: pullRefreshSpin 900ms linear infinite;
}

.pull-refresh-icon {
  font-size: 18px;
}

.pull-refresh-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

@keyframes pullRefreshSpin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* Material 3 Home Page Loading Animations */
.content-loading {
  opacity: 0.3;
  transition: opacity 240ms cubic-bezier(0.2, 0, 0, 1);
}

.content-loaded {
  opacity: 1;
  animation: contentFadeIn 220ms cubic-bezier(0.2, 0, 0, 1) forwards;
}

@keyframes contentFadeIn {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

/* Staggered shelf animations */
.shelf-item {
  opacity: 0;
  animation: shelfSlideIn 240ms cubic-bezier(0.2, 0, 0, 1) forwards;
}

@keyframes shelfSlideIn {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

/* Shelf loading delays */
.shelf-delay-0 {
  animation-delay: 0ms;
}
.shelf-delay-1 {
  animation-delay: 60ms;
}
.shelf-delay-2 {
  animation-delay: 120ms;
}
.shelf-delay-3 {
  animation-delay: 180ms;
}
.shelf-delay-4 {
  animation-delay: 240ms;
}
.shelf-delay-5 {
  animation-delay: 300ms;
}
.shelf-delay-6 {
  animation-delay: 360ms;
}

/* Animate updates to existing shelves to reduce jarring flash when server merges */
.shelf-updating {
  animation: shelfUpdate 220ms cubic-bezier(0.2, 0, 0, 1) forwards;
}

@keyframes shelfUpdate {
  0% {
    opacity: 0.78;
  }
  100% {
    opacity: 1;
  }
}

/* Shimmer styles for skeleton cards */
.skeleton-card {
  position: relative;
  --shimmer-duration: 2200ms;
  flex-shrink: 0;
  contain: paint;
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
  background: linear-gradient(90deg, transparent, rgba(var(--md-sys-color-on-surface), 0.04), transparent);
  transform: translateX(0);
  will-change: transform;
  animation: shimmer var(--shimmer-duration) linear 1;
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

  .shimmer-block::after {
    animation: none;
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
