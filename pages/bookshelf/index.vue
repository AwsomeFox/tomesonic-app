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
        <template v-for="shelf in shelves">
          <bookshelf-shelf :key="shelf.id" :label="getShelfLabel(shelf)" :entities="shelf.entities" :type="shelf.type" :animate-items="false" />
        </template>
      </div>
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
      initialConnectionWaitComplete: false,
      seriesIdLookupByLibrary: {},
      seriesRefsByLibraryItemId: {},
      seriesCountByIdByLibrary: {},
      seriesCoverBooksByLibrarySeries: {},
      seriesStartedBookCountByLibrarySeries: {},
      pullDistance: 0,
      isPullRefreshing: false,
      isPullGestureActive: false,
      pullGestureAxis: 'none',
      pullStartY: 0,
      pullStartX: 0,
      pullTriggerDistance: 86,
      pullMaxDistance: 132,
      _bookshelfWrapperEl: null
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
      wrapper.addEventListener('touchmove', this.onPullMove, { passive: false })
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

      if (wrapper.scrollTop > 0 || deltaY <= 0) {
        this.pullDistance = 0
        return
      }

      this.pullDistance = this.getPullDistanceWithResistance(deltaY)
      event.preventDefault()
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
    unwrapBookEntity(bookEntity) {
      if (!bookEntity) return null
      return bookEntity.libraryItem || bookEntity.item || bookEntity.libraryItemWrapper || bookEntity
    },
    getBookProgress(bookEntity) {
      const source = this.unwrapBookEntity(bookEntity) || bookEntity
      return bookEntity?.userMediaProgress || source?.userMediaProgress || bookEntity?.mediaProgress || source?.mediaProgress || bookEntity?.progress || source?.progress || null
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
            libraryId: source?.libraryId || null
          }
        }

        const nestedSeries = candidate.series || null
        const id = candidate.id || candidate.seriesId || nestedSeries?.id || nestedSeries?.seriesId || null
        const name = candidate.name || nestedSeries?.name || metadataSeriesName || 'Unknown Series'

        if (!id && !name) return null
        return {
          id,
          name,
          libraryId: candidate.libraryId || nestedSeries?.libraryId || source?.libraryId || null
        }
      }

      if (collapsedSeries?.id || collapsedSeries?.seriesId || collapsedSeries?.name || collapsedSeries?.title) {
        const collapsedSeriesRef = parseSeriesRef({
          id: collapsedSeries.id,
          seriesId: collapsedSeries.seriesId,
          name: collapsedSeries.name || collapsedSeries.title,
          libraryId: collapsedSeries.libraryId || source?.libraryId || null
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
          libraryId: source?.libraryId || null
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

      this.$set(this.seriesIdLookupByLibrary, libraryId, nameToId)
      this.$set(this.seriesCountByIdByLibrary, libraryId, countById)
      return nameToId
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

      const coverBooks = results.slice(0, 4)
      this.$set(this.seriesCoverBooksByLibrarySeries, cacheKey, coverBooks)
      this.$set(this.seriesStartedBookCountByLibrarySeries, cacheKey, startedBooks)
      return coverBooks
    },
    getSeriesStartedBookCountForSeries(libraryId, seriesId) {
      if (!libraryId || !seriesId) return 0
      const cacheKey = `${libraryId}::${seriesId}`
      return Number(this.seriesStartedBookCountByLibrarySeries[cacheKey] || 0)
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
        if (seriesRef.id) return seriesRef
        const nameCandidates = this.getNormalizedSeriesNameCandidates(seriesRef.name)
        if (!nameCandidates.length) return seriesRef

        let resolvedId = null
        nameCandidates.some((nameKey) => {
          const found = knownSeriesIdsByName.get(nameKey)
          if (found) {
            resolvedId = found
            return true
          }
          return false
        })

        if (!resolvedId) return seriesRef
        return {
          ...seriesRef,
          id: resolvedId
        }
      }

      const upsertSeries = (seriesRef, sourceBook = null, score = 0) => {
        if (!seriesRef?.id) return

        const resolvedLibraryId = seriesRef.libraryId || sourceBook?.libraryId || null
        const resolvedCount = Number(seriesRef.numBooks || seriesRef.audiobookCount || 0) || this.getSeriesCountForId(seriesRef.id, resolvedLibraryId) || 0

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
        if (!existing.libraryId && (seriesRef.libraryId || sourceBook?.libraryId)) {
          existing.libraryId = seriesRef.libraryId || sourceBook?.libraryId
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

            upsertSeries(
              {
                id: seriesEntity.id,
                name: seriesEntity.name || 'Unknown Series',
                libraryId: seriesEntity.libraryId || null
              },
              null,
              seriesScore
            )

            seriesBooks.forEach((seriesBook) => {
              upsertSeries(
                {
                  id: seriesEntity.id,
                  name: seriesEntity.name || 'Unknown Series',
                  libraryId: seriesEntity.libraryId || seriesBook?.libraryId || null
                },
                seriesBook,
                seriesBook?.userMediaProgress?.lastUpdate || 0
              )
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
            libraryId: seriesEntity.libraryId,
            numBooks: seriesEntity.numBooks || seriesEntity.audiobookCount || seriesEntity.books?.length || 0,
            numStartedBooks: Number(seriesEntity.numStartedBooks || 0),
            coverBooks: Array.isArray(seriesEntity.coverBooks) ? seriesEntity.coverBooks : [],
            books: seriesEntity.books
          }
        })
        .filter((seriesEntity) => {
          const totalBooks = Number(seriesEntity.numBooks || 0)
          // Keep unknown counts (0) and multi-book series; explicitly hide single-book series.
          return totalBooks === 0 || totalBooks > 1
        })

      if (!normalizedSeries.length) return serverCategories

      await this.enrichSeriesCoverBooks(normalizedSeries)

      if (continueSeriesShelf) {
        continueSeriesShelf.type = 'series'
        continueSeriesShelf.entities = normalizedSeries
        if (!continueSeriesShelf.label) continueSeriesShelf.label = this.$strings.LabelContinueSeries
        if (!continueSeriesShelf.labelStringKey) continueSeriesShelf.labelStringKey = 'LabelContinueSeries'
        return serverCategories
      }

      const newContinueSeriesShelf = {
        id: 'continue-series',
        label: this.$strings.LabelContinueSeries,
        labelStringKey: 'LabelContinueSeries',
        type: 'series',
        entities: normalizedSeries
      }

      const continueReadingIndex = serverCategories.findIndex((shelf) => this.isContinueReadingShelf(shelf))
      if (continueReadingIndex >= 0) {
        serverCategories.splice(continueReadingIndex + 1, 0, newContinueSeriesShelf)
      } else {
        serverCategories.unshift(newContinueSeriesShelf)
      }

      return serverCategories
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
    async fetchCategories(options = {}) {
      const forceRefresh = !!options.force
      console.log(`[categories] fetchCategories networkConnected=${this.networkConnected}, user=${!!this.user}, currentLibraryId=${this.currentLibraryId}, lastServerFetch=${this.lastServerFetch}, lastLocalFetch=${this.lastLocalFetch}, force=${forceRefresh}`)

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
          // Wait up to 5 seconds for server books to load
          const serverTimeoutMs = 5000
          const serverRequest = this.$nativeHttp.get(`/api/libraries/${this.currentLibraryId}/personalized?minified=1&include=rssfeed,numEpisodesIncomplete,series`, { connectTimeout: 10000 }).catch((error) => {
            console.error('[categories] Failed to fetch categories', error)
            return null
          })

          const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('__timeout__'), serverTimeoutMs))
          const categoriesOrTimeout = await Promise.race([serverRequest, timeoutPromise])

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
          const mergeLocalWithServerCategories = async (serverPayload) => {
            const extractedCategories = this.extractServerCategories(serverPayload)
            if (!extractedCategories.length) return []

            await this.enrichContinueShelvesWithExpandedSeries(extractedCategories)

            const shouldLoadSeriesLookup = extractedCategories.some((shelf) => this.isContinueReadingShelf(shelf) && shelf?.type === 'book' && Array.isArray(shelf?.entities) && shelf.entities.length)
            const seriesLookup = shouldLoadSeriesLookup ? await this.getSeriesLookupForLibrary(this.currentLibraryId) : null

            let normalizedCategories = extractedCategories
            try {
              const maybeNormalized = await this.normalizeContinueSeriesCategories(extractedCategories, seriesLookup)
              normalizedCategories = Array.isArray(maybeNormalized) ? maybeNormalized : extractedCategories
            } catch (error) {
              console.error('[categories] Failed to normalize continue-series categories, falling back to raw server categories', error)
              normalizedCategories = extractedCategories
            }

            return attachLocalItemsToServerCategories(normalizedCategories)
          }

          // Helper function to combine server and local-only shelves
          const combineServerAndLocalShelves = (serverCats) => {
            if (!Array.isArray(serverCats) || !serverCats.length) return localCategories
            const localOnlyShelves = localCategories.filter((cat) => !serverCats.find((sc) => sc.id === cat.id) && cat.type === this.currentLibraryMediaType)
            return [...serverCats, ...localOnlyShelves]
          }

          const initialServerCategories = this.extractServerCategories(categoriesOrTimeout)

          // Case 1: Server responded before timeout
          if (categoriesOrTimeout !== '__timeout__' && initialServerCategories.length) {
            console.log('[categories] Server responded before timeout, displaying combined results immediately')
            const fastServerCats = attachLocalItemsToServerCategories(initialServerCategories)
            const combinedShelves = combineServerAndLocalShelves(fastServerCats)

            // Update all state together to prevent flash of local content
            // Set flags first to ensure skeleton stays visible during shelf assignment
            this.isLoading = false
            this.firstLoad = false
            // Now update shelves and hide skeleton in same tick
            this.shelves = combinedShelves
            this.showingSkeleton = false
            console.log('[categories] Combined server + local shelves displayed', this.shelves.length, this.lastServerFetch)

            // Continue heavier continue-series enrichment in background to avoid delaying first paint.
            ;(async () => {
              try {
                const enrichedServerCats = await mergeLocalWithServerCategories(categoriesOrTimeout)
                if (!Array.isArray(enrichedServerCats) || !enrichedServerCats.length) return

                const enrichedCombinedShelves = combineServerAndLocalShelves(enrichedServerCats)
                enrichedCombinedShelves.forEach((incomingShelf) => {
                  const existingShelf = this.shelves.find((s) => s && s.id === incomingShelf.id)
                  if (existingShelf) {
                    existingShelf.label = incomingShelf.label
                    existingShelf.type = incomingShelf.type
                    existingShelf.entities = incomingShelf.entities
                  } else {
                    this.shelves.push(incomingShelf)
                  }
                })
              } catch (error) {
                console.error('[categories] Background continue-series enrichment failed', error)
              }
            })()

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
              const delayedServerCategories = this.extractServerCategories(categories)

              // Case 3: Server eventually responded after timeout
              if (delayedServerCategories.length) {
                console.log('[categories] Server responded after timeout, silently merging results')
                const serverCats = await mergeLocalWithServerCategories(categories)

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
      this.$nextTick(() => {
        this.bindPullToRefresh()
      })
    },
    removeListeners() {
      this.$eventBus.$off('library-changed', this.libraryChanged)
      this.unbindPullToRefresh()
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
