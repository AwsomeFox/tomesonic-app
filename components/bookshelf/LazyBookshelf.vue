<template>
  <div id="bookshelf" class="w-full max-w-full h-full bg-surface-dynamic library-scroll-container">
    <!-- Loading skeleton for initial load (series grid) -->
    <div v-if="!initialized && useDirectSeriesGrid" class="w-full px-4 py-3">
      <div class="series-grid-view" :style="seriesGridStyle">
        <div v-for="n in seriesSkeletonCount" :key="`series-skel-${n}`" class="series-grid-skeleton loading-skeleton" :style="{ width: entityWidth + 'px', height: entityHeight + 'px', animationDelay: n * 70 + 'ms' }">
          <div class="w-full h-full bg-surface-container rounded-2xl overflow-hidden border border-outline-variant border-opacity-30 shadow-elevation-1">
            <div class="w-full h-full bg-surface-variant shimmer-block"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Loading skeleton for initial load (list view) -->
    <div v-else-if="!initialized" class="w-full px-2 py-2">
      <div v-for="n in 8" :key="n" class="w-full h-20 loading-skeleton border-b border-outline-variant border-opacity-40" :style="{ animationDelay: n * 100 + 'ms' }">
        <div class="h-full flex items-center px-2">
          <!-- Cover placeholder -->
          <div class="w-16 h-16 bg-surface-variant rounded-xl animate-pulse"></div>

          <!-- Content placeholder -->
          <div class="flex-grow pl-4 space-y-2">
            <div class="h-4 bg-surface-variant rounded-md w-3/4 animate-pulse"></div>
            <div class="h-3 bg-surface-variant rounded-md w-1/2 animate-pulse"></div>
            <div class="h-3 bg-surface-variant rounded-md w-1/3 animate-pulse"></div>
          </div>

          <!-- Play button placeholder -->
          <div class="w-12 h-12 bg-surface-variant rounded-full animate-pulse"></div>
        </div>
      </div>
    </div>

    <!-- Direct grid rendering for series page to avoid virtual-mount timing gaps -->
    <div v-if="useDirectSeriesGrid && initialized" class="w-full px-4 py-3">
      <div class="series-grid-view" :style="seriesGridStyle">
        <cards-lazy-series-card v-for="(entity, index) in seriesEntities" :key="entity.id || index" :index="index" :series-mount="entity" :width="entityWidth" :height="entityHeight" :book-cover-aspect-ratio="bookCoverAspectRatio" :is-alt-view-enabled="altViewEnabled" class="relative" />
      </div>
    </div>

    <!-- Actual shelves -->
    <template v-else v-for="shelf in totalShelves">
      <div :key="shelf" class="w-full px-2 bg-surface-dynamic shelf-list-view" :id="`shelf-${shelf - 1}`" :style="shelfContainerStyle"></div>
    </template>

    <div v-show="!entities.length && initialized" class="w-full py-16 text-center">
      <div v-if="page === 'collections'" class="py-4 text-on-surface text-title-large">{{ $strings.MessageNoCollections }}</div>
      <div v-else class="py-4 text-on-surface text-title-large capitalize">No {{ entityName }}</div>
      <ui-btn v-if="hasFilter" @click="clearFilter" variant="filled">{{ $strings.ButtonClearFilter }}</ui-btn>
    </div>
  </div>
</template>

<script>
import bookshelfCardsHelpers from '@/mixins/bookshelfCardsHelpers'
import { isBookEntityAudioCapable } from '@/plugins/audioFiltering'

const lazyBookshelfViewCache = new Map()
const LAZY_BOOKSHELF_CACHE_MAX = 40

function setLazyBookshelfCacheEntry(key, value) {
  if (!key) return
  if (lazyBookshelfViewCache.has(key)) {
    lazyBookshelfViewCache.delete(key)
  }
  lazyBookshelfViewCache.set(key, value)

  if (lazyBookshelfViewCache.size > LAZY_BOOKSHELF_CACHE_MAX) {
    const oldestKey = lazyBookshelfViewCache.keys().next().value
    if (oldestKey) {
      lazyBookshelfViewCache.delete(oldestKey)
    }
  }
}

export default {
  props: {
    page: String,
    seriesId: String,
    authorId: String,
    narratorName: String
  },
  mixins: [bookshelfCardsHelpers],
  data() {
    return {
      routeFullPath: null,
      entitiesPerShelf: 2,
      bookshelfHeight: 0,
      bookshelfWidth: 0,
      bookshelfMarginLeft: 0,
      shelvesPerPage: 0,
      currentPage: 0,
      booksPerFetch: 20,
      initialized: false,
      currentSFQueryString: null,
      isFetchingEntities: false,
      entities: [],
      totalEntities: 0,
      totalShelves: 0,
      entityComponentRefs: {},
      entityIndexesMounted: [],
      pagesLoaded: {},
      isFirstInit: false,
      pendingReset: false,
      localLibraryItems: [],
      listenersInitialized: false,
      lastHideNonAudiobooks: false,
      cacheKey: null
    }
  },
  created() {
    this.cacheKey = this.buildViewCacheKey()
    this.tryRestoreFromCache()
  },
  watch: {
    seriesId() {
      this.resetEntities()
    },
    authorId() {
      this.resetEntities()
    },
    narratorName() {
      this.resetEntities()
    }
  },
  computed: {
    user() {
      return this.$store.state.user.user
    },
    isBookEntity() {
      return this.entityName === 'books' || this.entityName === 'series-books' || this.entityName === 'author-books' || this.entityName === 'narrator-books'
    },
    shelfDividerHeightIndex() {
      if (this.isBookEntity) return 4
      return 6
    },
    bookshelfListView() {
      return this.$store.state.globals.bookshelfListView
    },
    showBookshelfListView() {
      // Keep list view for most pages, but use card grid for series browser.
      return this.entityName !== 'series'
    },
    useDirectSeriesGrid() {
      return this.entityName === 'series' && !this.showBookshelfListView
    },
    sortingIgnorePrefix() {
      return this.$store.getters['getServerSetting']('sortingIgnorePrefix')
    },
    entityName() {
      return this.page
    },
    hasFilter() {
      if (this.page === 'series' || this.page === 'collections' || this.page === 'playlists' || this.page === 'author-books' || this.page === 'narrator-books') return false
      return this.filterBy !== 'all'
    },
    orderBy() {
      return this.$store.getters['user/getUserSetting']('mobileOrderBy')
    },
    orderDesc() {
      return this.$store.getters['user/getUserSetting']('mobileOrderDesc')
    },
    filterBy() {
      return this.$store.getters['user/getUserSetting']('mobileFilterBy')
    },
    collapseSeries() {
      return this.$store.getters['user/getUserSetting']('collapseSeries')
    },
    collapseBookSeries() {
      return this.$store.getters['user/getUserSetting']('collapseBookSeries')
    },
    hideNonAudiobooks() {
      return this.$store.getters['getHideNonAudiobooksGlobal']
    },
    isCoverSquareAspectRatio() {
      return this.bookCoverAspectRatio === 1
    },
    bookCoverAspectRatio() {
      return this.$store.getters['libraries/getBookCoverAspectRatio']
    },
    bookWidth() {
      // Match Authors page card width when rendering the series grid so they
      // visually line up across tabs.
      if (this.entityName === 'series' && !this.isCoverSquareAspectRatio) {
        const containerWidth = this.bookshelfWidth || (typeof window !== 'undefined' ? window.innerWidth : 360)
        // Authors page uses cardWidth = (innerWidth - 64) / 2 (px-4 + p-2 per card)
        const cardWidth = Math.floor((containerWidth - 64) / 2)
        return Math.max(120, cardWidth)
      }
      // Simplified since we only need this for home page card sizing now
      // List view doesn't use this for sizing
      const baseWidth = this.isCoverSquareAspectRatio ? 192 : 120
      return baseWidth
    },
    bookHeight() {
      if (this.isCoverSquareAspectRatio || this.entityName === 'playlists') return this.bookWidth
      if (this.entityName === 'series') return this.bookWidth
      return this.bookWidth * 1.6
    },
    entityWidth() {
      if (this.showBookshelfListView) {
        return this.bookshelfWidth - 16 // Account for px-2 padding (8px each side)
      }
      return this.bookWidth
    },
    entityHeight() {
      if (this.showBookshelfListView) return 88
      return this.bookHeight
    },
    currentLibraryId() {
      return this.$store.state.libraries.currentLibraryId
    },
    currentLibraryMediaType() {
      return this.$store.getters['libraries/getCurrentLibraryMediaType']
    },
    shelfHeight() {
      if (this.showBookshelfListView) return this.entityHeight + 6 // Reduced from 8
      if (this.altViewEnabled) {
        var extraTitleSpace = this.isBookEntity ? 60 : 30 // Reduced from 80:40
        return this.entityHeight + extraTitleSpace * this.sizeMultiplier
      }
      return this.entityHeight + 24 // Reduced from 40
    },
    totalEntityCardWidth() {
      if (this.showBookshelfListView) return this.entityWidth

      // Use a compact card gap to match the home shelf spacing.
      return this.entityWidth + 8
    },
    altViewEnabled() {
      return this.$store.getters['getAltViewEnabled']
    },
    sizeMultiplier() {
      const baseSize = this.isCoverSquareAspectRatio ? 192 : 120
      return this.entityWidth / baseSize
    },
    shelfContainerStyle() {
      if (this.showBookshelfListView) {
        return { height: this.shelfHeight + 'px' }
      }
      return {
        height: this.shelfHeight + 'px',
        marginLeft: this.bookshelfMarginLeft + 'px'
      }
    },
    seriesEntities() {
      if (!Array.isArray(this.entities)) return []
      return this.entities.filter((entity) => !!entity)
    },
    seriesGridStyle() {
      const columns = Math.max(1, this.entitiesPerShelf || 1)
      return {
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, ${this.entityWidth}px)`,
        gap: '16px',
        justifyContent: 'center'
      }
    },
    seriesSkeletonCount() {
      const columns = Math.max(1, this.entitiesPerShelf || 1)
      return Math.max(columns * 4, 8)
    }
  },
  methods: {
    getPayloadTotal(payload) {
      if (!payload) return null
      const totalCandidates = [payload.total, payload.totalResults, payload.totalCount, payload.numResults, payload?.meta?.total]
      for (const candidate of totalCandidates) {
        const parsed = Number(candidate)
        if (Number.isFinite(parsed) && parsed >= 0) {
          return Math.floor(parsed)
        }
      }
      return null
    },
    resolveTotalEntities(payload, startIndex, previousTotal = 0) {
      const explicitTotal = this.getPayloadTotal(payload)
      if (explicitTotal !== null) return explicitTotal

      const resultsLength = Array.isArray(payload?.results) ? payload.results.length : 0
      return Math.max(previousTotal, startIndex + resultsLength)
    },
    getTargetColumnsForWidth(availableWidth) {
      if (!availableWidth || availableWidth <= 0) return 1
      const gutter = 8
      const targetColumns = Math.floor((availableWidth + gutter) / (this.bookWidth + gutter))
      return Math.max(1, Math.min(4, targetColumns))
    },
    buildViewCacheKey() {
      const searchParams = this.buildSearchParams()
      return [this.currentLibraryId || 'none', this.entityName || 'none', this.seriesId || '', this.authorId || '', this.narratorName || '', searchParams || '', this.showBookshelfListView ? 'list' : 'grid', this.hideNonAudiobooks ? 'audio' : 'all'].join('::')
    },
    tryRestoreFromCache() {
      const key = this.cacheKey || this.buildViewCacheKey()
      const cachedState = lazyBookshelfViewCache.get(key)
      if (!cachedState) return false

      this.currentSFQueryString = cachedState.currentSFQueryString || this.buildSearchParams()
      this.entities = Array.isArray(cachedState.entities) ? cachedState.entities.slice() : []
      this.totalEntities = Number(cachedState.totalEntities || this.entities.length || 0)
      this.totalShelves = Number(cachedState.totalShelves || 0)
      this.pagesLoaded = cachedState.pagesLoaded ? { ...cachedState.pagesLoaded } : {}
      this.initialized = true
      this.$eventBus.$emit('bookshelf-total-entities', this.totalEntities)
      return true
    },
    saveViewCache() {
      if (!this.cacheKey || !this.initialized) return

      setLazyBookshelfCacheEntry(this.cacheKey, {
        currentSFQueryString: this.currentSFQueryString,
        entities: Array.isArray(this.entities) ? this.entities.slice() : [],
        totalEntities: Number(this.totalEntities || 0),
        totalShelves: Number(this.totalShelves || 0),
        pagesLoaded: { ...this.pagesLoaded },
        timestamp: Date.now()
      })
    },
    clearViewCache() {
      if (!this.cacheKey) return
      lazyBookshelfViewCache.delete(this.cacheKey)
    },
    clearFilter() {
      this.$store.dispatch('user/updateUserSettings', {
        mobileFilterBy: 'all'
      })
    },
    shouldUseAudioOnlyDataset() {
      return this.hideNonAudiobooks && this.isBookEntity
    },
    async fetchEntities(page) {
      const isSeriesGrid = this.useDirectSeriesGrid || this.shouldUseAudioOnlyDataset()
      const fetchPage = isSeriesGrid ? 0 : page
      const fetchLimit = isSeriesGrid ? 1000 : this.booksPerFetch
      const startIndex = isSeriesGrid ? 0 : page * this.booksPerFetch

      this.isFetchingEntities = true

      if (!this.initialized) {
        this.currentSFQueryString = this.buildSearchParams()
      }

      const entityPath = this.entityName === 'books' || this.entityName === 'series-books' || this.entityName === 'author-books' || this.entityName === 'narrator-books' ? `items` : this.entityName
      const sfQueryString = this.currentSFQueryString ? this.currentSFQueryString + '&' : ''
      const fullQueryString = `?${sfQueryString}limit=${fetchLimit}&page=${fetchPage}&minified=1&include=rssfeed,numEpisodesIncomplete`

      let payload = await this.$nativeHttp.get(`/api/libraries/${this.currentLibraryId}/${entityPath}${fullQueryString}`).catch((error) => {
        console.error('failed to fetch books', error)
        return null
      })

      if (isSeriesGrid && payload && Array.isArray(payload.results)) {
        const aggregatedResults = [...payload.results]
        let resolvedTotal = this.resolveTotalEntities(payload, 0, aggregatedResults.length)
        let nextPage = 1
        const maxSeriesGridPages = 100

        while (aggregatedResults.length < resolvedTotal && nextPage < maxSeriesGridPages) {
          const nextQueryString = `?${sfQueryString}limit=${fetchLimit}&page=${nextPage}&minified=1&include=rssfeed,numEpisodesIncomplete`
          const nextPayload = await this.$nativeHttp.get(`/api/libraries/${this.currentLibraryId}/${entityPath}${nextQueryString}`).catch((error) => {
            console.error('failed to fetch additional series page', error)
            return null
          })

          if (!nextPayload || !Array.isArray(nextPayload.results) || !nextPayload.results.length) {
            break
          }

          aggregatedResults.push(...nextPayload.results)
          resolvedTotal = this.resolveTotalEntities(nextPayload, nextPage * fetchLimit, resolvedTotal)
          nextPage++
        }

        payload = {
          ...payload,
          results: aggregatedResults,
          total: aggregatedResults.length
        }
      }

      if (this.shouldUseAudioOnlyDataset() && payload && Array.isArray(payload.results)) {
        const filteredAudioResults = payload.results.filter((entity) => isBookEntityAudioCapable(entity))
        payload = {
          ...payload,
          results: filteredAudioResults,
          total: filteredAudioResults.length
        }
      }

      this.isFetchingEntities = false
      if (this.pendingReset) {
        this.pendingReset = false
        this.resetEntities()
        return
      }
      if (payload && payload.results) {
        console.log('Received payload', payload)
        if (!this.initialized) {
          const resolvedTotal = this.resolveTotalEntities(payload, startIndex, 0)
          this.initialized = true
          this.totalEntities = resolvedTotal
          this.totalShelves = Math.ceil(this.totalEntities / this.entitiesPerShelf)
          this.entities = new Array(this.totalEntities)
          this.$eventBus.$emit('bookshelf-total-entities', this.totalEntities)

          if (this.shouldUseAudioOnlyDataset()) {
            const virtualPageCount = Math.max(1, Math.ceil(this.totalEntities / this.booksPerFetch))
            for (let pageIndex = 0; pageIndex < virtualPageCount; pageIndex++) {
              this.pagesLoaded[pageIndex] = true
            }
          }
        } else {
          // Handle filter changes - recalculate total entities and shelves
          const previousTotal = this.totalEntities
          this.totalEntities = this.resolveTotalEntities(payload, startIndex, previousTotal)
          this.totalShelves = Math.ceil(this.totalEntities / this.entitiesPerShelf)

          if (previousTotal !== this.totalEntities) {
            const changeRatio = this.totalEntities / Math.max(previousTotal, 1)

            // If the change is significant (more than 3x increase), force a full reset
            if (changeRatio > 3) {
              console.log(`[LazyBookshelf] Significant entity change detected (${changeRatio.toFixed(1)}x) - forcing full reset`)
              this.resetEntities()
              return
            }

            // Clear old entity components to prevent stale data
            this.destroyEntityComponents()
            this.entityIndexesMounted = []
            this.entityComponentRefs = {}

            // Resize entities array and recalculate viewable area
            this.entities = new Array(this.totalEntities)
            this.$eventBus.$emit('bookshelf-total-entities', this.totalEntities)

            // Update the viewable area calculation
            this.initSizeData()

            // Ensure we mount entities for the expanded viewable area
            if (this.totalEntities > previousTotal) {
              // Use $nextTick to ensure DOM has updated with new totalShelves
              this.$nextTick(() => {
                // Force recalculate container dimensions after DOM update
                const bookshelf = document.getElementById('bookshelf')
                const bookshelfWrapper = document.getElementById('bookshelf-wrapper')
                if (bookshelf && bookshelfWrapper) {
                  const { clientWidth } = bookshelf
                  // Use the scroll container viewport height, not the content height
                  const { clientHeight: wrapperHeight } = bookshelfWrapper
                  this.bookshelfHeight = wrapperHeight
                  this.bookshelfWidth = clientWidth
                  console.log(`[LazyBookshelf] Updated dimensions - content: ${clientWidth}x${bookshelf.clientHeight}, viewport: ${clientWidth}x${wrapperHeight}`)

                  // Force recalculate viewport-based values
                  this.shelvesPerPage = Math.ceil(this.bookshelfHeight / this.shelfHeight) + 2
                  const entitiesPerPage = this.shelvesPerPage * this.entitiesPerShelf
                  this.booksPerFetch = Math.ceil(entitiesPerPage / 20) * 20

                  console.log(`[LazyBookshelf] Recalculated viewport - shelvesPerPage: ${this.shelvesPerPage}, booksPerFetch: ${this.booksPerFetch}`)
                }

                const currentScrollTop = window['bookshelf-wrapper']?.scrollTop || 0

                // Ensure we mount entities for the current scroll position with new viewport
                if (currentScrollTop === 0) {
                  const initialLastBookIndex = Math.min(this.totalEntities, this.shelvesPerPage * this.entitiesPerShelf)
                  console.log(`[LazyBookshelf] Mounting initial entities 0-${initialLastBookIndex}`)

                  // Load additional pages if needed for the expanded viewport
                  const lastBookPage = Math.floor(initialLastBookIndex / this.booksPerFetch)
                  for (let page = 0; page <= lastBookPage; page++) {
                    if (!this.pagesLoaded[page]) {
                      console.log(`[LazyBookshelf] Loading additional page ${page} for expanded viewport`)
                      this.loadPage(page)
                    }
                  }

                  this.mountEntites(0, initialLastBookIndex)
                } else {
                  // If not at top, ensure we handle the current scroll position with new viewport
                  this.handleScroll(currentScrollTop)
                }
              })
            }

            console.log(`[LazyBookshelf] Filter changed - entities: ${previousTotal} → ${this.totalEntities}, shelves: ${this.totalShelves}`)
          }
        }

        for (let i = 0; i < payload.results.length; i++) {
          const index = i + startIndex
          this.entities[index] = payload.results[i]
          if (this.entityComponentRefs[index]) {
            this.entityComponentRefs[index].setEntity(this.entities[index])

            if (this.isBookEntity) {
              const localLibraryItem = this.localLibraryItems.find((lli) => lli.libraryItemId == this.entities[index].id)
              if (localLibraryItem) {
                this.entityComponentRefs[index].setLocalLibraryItem(localLibraryItem)
              }
            }
          }
        }

        this.saveViewCache()
      }
    },
    async loadPage(page) {
      if (!this.currentLibraryId) {
        console.error('[LazyBookshelf] loadPage current library id not set')
        return
      }

      if (this.shouldUseAudioOnlyDataset() && this.initialized && page > 0) {
        this.pagesLoaded[page] = true
        return
      }

      this.pagesLoaded[page] = true
      await this.fetchEntities(page)
    },
    mountEntites(fromIndex, toIndex, immediate = false) {
      // Collect indexes that still need mounting so we can yield to the
      // browser between mounts. Creating many Vue instances synchronously
      // during a scroll event causes long frames and visible hitching, so we
      // chunk the work into idle/animation slots instead.
      const pending = []
      for (let i = fromIndex; i < toIndex; i++) {
        if (!this.entityIndexesMounted.includes(i)) {
          pending.push(i)
        }
      }
      if (!pending.length) return

      // When the caller requests an immediate pass (e.g. scrolling has come
      // to rest and we MUST show every card in the resting visible window),
      // mount everything synchronously. The browser is idle in this case so
      // there's no scroll frame to protect.
      if (immediate) {
        while (pending.length) {
          const idx = pending.shift()
          if (!this.entityIndexesMounted.includes(idx)) {
            this.cardsHelpers.mountEntityCard(idx)
          }
        }
        return
      }

      // Always mount the very first card synchronously to avoid a one-frame
      // gap at the top of the visible window on initial render.
      const first = pending.shift()
      this.cardsHelpers.mountEntityCard(first)
      if (!pending.length) return

      const scheduler = (cb) => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          return window.requestIdleCallback(cb, { timeout: 80 })
        }
        return setTimeout(cb, 0)
      }
      const mountChunk = (deadline) => {
        // If we don't have a deadline (setTimeout fallback), bound the chunk
        // to a small number of mounts so we don't block the main thread.
        const hasDeadline = deadline && typeof deadline.timeRemaining === 'function'
        let safety = 6
        while (pending.length && (hasDeadline ? deadline.timeRemaining() > 4 : safety-- > 0)) {
          const idx = pending.shift()
          // The index may have been mounted by a later scroll pass; skip it.
          if (!this.entityIndexesMounted.includes(idx)) {
            this.cardsHelpers.mountEntityCard(idx)
          }
        }
        if (pending.length) scheduler(mountChunk)
      }
      scheduler(mountChunk)
    },
    handleScroll(scrollTop, immediate = false) {
      if (this.useDirectSeriesGrid) return
      this.currScrollTop = scrollTop
      var firstShelfIndex = Math.floor(scrollTop / this.shelfHeight)
      var lastShelfIndex = Math.ceil((scrollTop + this.bookshelfHeight) / this.shelfHeight)
      lastShelfIndex = Math.min(this.totalShelves - 1, lastShelfIndex)

      var firstBookIndex = firstShelfIndex * this.entitiesPerShelf
      var lastBookIndex = lastShelfIndex * this.entitiesPerShelf + this.entitiesPerShelf
      lastBookIndex = Math.min(this.totalEntities, lastBookIndex)

      var firstBookPage = Math.floor(firstBookIndex / this.booksPerFetch)
      var lastBookPage = Math.floor(lastBookIndex / this.booksPerFetch)
      if (!this.pagesLoaded[firstBookPage]) {
        console.log('Must load next batch', firstBookPage, 'book index', firstBookIndex)
        this.loadPage(firstBookPage)
      }
      if (!this.pagesLoaded[lastBookPage]) {
        console.log('Must load last next batch', lastBookPage, 'book index', lastBookIndex)
        this.loadPage(lastBookPage)
      }

      // Remove entities out of view
      this.entityIndexesMounted = this.entityIndexesMounted.filter((_index) => {
        if (_index < firstBookIndex || _index >= lastBookIndex) {
          var el = document.getElementById(`book-card-${_index}`) || document.getElementById(`series-card-${_index}`)
          if (el) el.remove()
          return false
        }
        return true
      })
      this.mountEntites(firstBookIndex, lastBookIndex, immediate)
    },
    destroyEntityComponents() {
      for (const key in this.entityComponentRefs) {
        if (this.entityComponentRefs[key] && this.entityComponentRefs[key].destroy) {
          this.entityComponentRefs[key].destroy()
        }
      }
    },
    setDownloads() {
      if (this.entityName === 'books') {
        this.entities = []
        // TOOD: Sort and filter here
        this.totalEntities = this.entities.length
        this.totalShelves = Math.ceil(this.totalEntities / this.entitiesPerShelf)
      } else {
        // TODO: Support offline series and collections
        this.entities = []
        this.totalEntities = 0
        this.totalShelves = 0
      }
      this.$eventBus.$emit('bookshelf-total-entities', this.totalEntities)
    },
    async resetEntities() {
      if (this.isFetchingEntities) {
        this.pendingReset = true
        return
      }
      this.clearViewCache()
      this.cacheKey = this.buildViewCacheKey()

      if (this.tryRestoreFromCache()) {
        this.isFirstInit = true
        this.initSizeData()
        if (!this.useDirectSeriesGrid) {
          this.$nextTick(() => {
            const initialLastBookIndex = Math.min(this.totalEntities, this.shelvesPerPage * this.entitiesPerShelf)
            this.mountEntites(0, initialLastBookIndex)
          })
        }
        this.restoreScrollPosition()
        return
      }

      this.destroyEntityComponents()
      this.entityIndexesMounted = []
      this.entityComponentRefs = {}
      this.pagesLoaded = {}
      this.entities = []
      this.totalShelves = 0
      this.totalEntities = 0
      this.currentPage = 0
      this.initialized = false

      this.initSizeData()
      if (this.user) {
        await this.loadPage(0)
        var lastBookIndex = Math.min(this.totalEntities, this.shelvesPerPage * this.entitiesPerShelf)
        if (!this.useDirectSeriesGrid) {
          this.$nextTick(() => {
            this.mountEntites(0, lastBookIndex)
          })
        }
      } else {
        // Local only
      }
    },
    remountEntities() {
      // Remount when an entity is removed
      for (const key in this.entityComponentRefs) {
        if (this.entityComponentRefs[key]) {
          this.entityComponentRefs[key].destroy()
        }
      }
      this.entityComponentRefs = {}
      this.entityIndexesMounted.forEach((i) => {
        this.cardsHelpers.mountEntityCard(i)
      })
    },
    saveScrollPosition() {
      if (window['bookshelf-wrapper']) {
        this.$store.commit('setLastBookshelfScrollData', { scrollTop: window['bookshelf-wrapper'].scrollTop || 0, path: this.routeFullPath, name: this.page })
      }
    },
    restoreScrollPosition() {
      if (!window['bookshelf-wrapper']) return
      const savedScrollData = this.$store.state.lastBookshelfScrollData[this.page]
      if (!savedScrollData) return

      const { path, scrollTop } = savedScrollData
      if (path === this.routeFullPath) {
        window['bookshelf-wrapper'].scrollTop = scrollTop
      }
    },
    initSizeData() {
      var bookshelf = document.getElementById('bookshelf')
      var bookshelfWrapper = document.getElementById('bookshelf-wrapper')
      if (!bookshelf || !bookshelfWrapper) {
        console.error('Failed to init size data')
        return
      }
      var entitiesPerShelfBefore = this.entitiesPerShelf

      var { clientWidth } = bookshelf
      // Use the scroll container viewport height, not the content height
      var { clientHeight: wrapperHeight } = bookshelfWrapper
      this.bookshelfHeight = wrapperHeight
      this.bookshelfWidth = clientWidth
      console.log(`[LazyBookshelf] initSizeData - content: ${clientWidth}x${bookshelf.clientHeight}, viewport: ${clientWidth}x${wrapperHeight}`)

      if (this.showBookshelfListView) {
        this.entitiesPerShelf = 1
        this.bookshelfMarginLeft = 0
      } else {
        // Use responsive column calculation
        const availableWidth = this.bookshelfWidth - 32 // Account for padding
        this.entitiesPerShelf = this.getTargetColumnsForWidth(availableWidth)

        // Center the grid if there's extra space
        const usedWidth = this.entitiesPerShelf * this.totalEntityCardWidth - 8 // Remove last gap
        this.bookshelfMarginLeft = Math.max(0, (availableWidth - usedWidth) / 2)
      }

      this.shelvesPerPage = Math.ceil(this.bookshelfHeight / this.shelfHeight) + 2

      const entitiesPerPage = this.shelvesPerPage * this.entitiesPerShelf
      this.booksPerFetch = Math.ceil(entitiesPerPage / 20) * 20 // Round up to the nearest 20

      if (this.totalEntities) {
        this.totalShelves = Math.ceil(this.totalEntities / this.entitiesPerShelf)
      }
      return entitiesPerShelfBefore !== this.entitiesPerShelf // Column count has changed
    },
    async init() {
      if (this.isFirstInit) return
      this.cacheKey = this.buildViewCacheKey()

      if (this.tryRestoreFromCache()) {
        this.localLibraryItems = await this.$db.getLocalLibraryItems(this.currentLibraryMediaType)
        this.lastHideNonAudiobooks = !!this.hideNonAudiobooks
        this.isFirstInit = true
        this.initSizeData()
        if (!this.useDirectSeriesGrid) {
          this.$nextTick(() => {
            const initialLastBookIndex = Math.min(this.totalEntities, this.shelvesPerPage * this.entitiesPerShelf)
            this.mountEntites(0, initialLastBookIndex)
          })
        }
        this.restoreScrollPosition()
        return
      }

      if (!this.user) {
        // Offline support not available
        await this.resetEntities()
        this.$eventBus.$emit('bookshelf-total-entities', 0)
        return
      }

      this.localLibraryItems = await this.$db.getLocalLibraryItems(this.currentLibraryMediaType)
      console.log('Local library items loaded for lazy bookshelf', this.localLibraryItems.length)
      this.lastHideNonAudiobooks = !!this.hideNonAudiobooks

      this.isFirstInit = true
      this.initSizeData()
      await this.loadPage(0)
      var lastBookIndex = Math.min(this.totalEntities, this.shelvesPerPage * this.entitiesPerShelf)
      if (!this.useDirectSeriesGrid) {
        this.$nextTick(() => {
          this.mountEntites(0, lastBookIndex)
        })
      }
      this.restoreScrollPosition()
      this.saveViewCache()
    },
    scroll(e) {
      if (!e || !e.target) return
      if (!this.user) return
      // Keep a reference so the rAF / trailing handlers can always read the
      // CURRENT scrollTop instead of the value at scheduling time. Reading
      // the stale captured value during fast scrolls caused us to mount the
      // wrong window and miss visible cards once the user stopped.
      this._scrollEl = e.target

      // Schedule a rAF-throttled pass that reads the latest scrollTop. This
      // intentionally does NOT skip small deltas - the previous half-shelf
      // skip guard could drop the trailing scroll event, leaving the final
      // visible window unmounted.
      if (!this._scrollRafPending) {
        this._scrollRafPending = true
        requestAnimationFrame(() => {
          this._scrollRafPending = false
          const el = this._scrollEl
          if (!el) return
          const latest = el.scrollTop
          this._lastScrollHandled = latest
          this.handleScroll(latest)
        })
      }

      // Always re-arm a short trailing timer so that when the user stops
      // scrolling we run one final handleScroll with the resting scrollTop.
      // We pass immediate=true so every visible card mounts synchronously
      // (no requestIdleCallback deferral) — otherwise fast scroll-and-stop
      // can leave the resting window with only the first card mounted while
      // the rest sit pending in the idle queue.
      if (this._scrollTrailingTimer) clearTimeout(this._scrollTrailingTimer)
      this._scrollTrailingTimer = setTimeout(() => {
        this._scrollTrailingTimer = null
        const el = this._scrollEl
        if (!el) return
        const latest = el.scrollTop
        this._lastScrollHandled = latest
        this.handleScroll(latest, true)
      }, 90)
    },
    buildSearchParams() {
      if (this.page === 'search' || this.page === 'collections') {
        return ''
      } else if (this.page === 'series') {
        const seriesOrderBy = this.$store.state.globals.seriesOrderBy || 'name'
        const seriesOrderDesc = !!this.$store.state.globals.seriesOrderDesc
        let searchParams = new URLSearchParams()
        searchParams.set('sort', seriesOrderBy)
        searchParams.set('desc', seriesOrderDesc ? 1 : 0)
        return searchParams.toString()
      }

      let searchParams = new URLSearchParams()
      if (this.page === 'series-books') {
        searchParams.set('filter', `series.${this.$encode(this.seriesId)}`)
        if (this.collapseBookSeries) {
          searchParams.set('collapseseries', 1)
        }
      } else if (this.page === 'author-books') {
        const authorFilterValue = this.authorId || '__missing_author__'
        searchParams.set('filter', `authors.${this.$encode(authorFilterValue)}`)
      } else if (this.page === 'narrator-books') {
        const narratorFilterValue = this.narratorName || '__missing_narrator__'
        searchParams.set('filter', `narrators.${this.$encode(narratorFilterValue)}`)
      } else {
        if (this.filterBy && this.filterBy !== 'all') {
          searchParams.set('filter', this.filterBy)
        }
        if (this.orderBy) {
          searchParams.set('sort', this.orderBy)
          searchParams.set('desc', this.orderDesc ? 1 : 0)
        }
        if (this.collapseSeries) {
          searchParams.set('collapseseries', 1)
        }
      }
      return searchParams.toString()
    },
    checkUpdateSearchParams() {
      const newSearchParams = this.buildSearchParams()
      let currentQueryString = window.location.search
      if (currentQueryString && currentQueryString.startsWith('?')) currentQueryString = currentQueryString.slice(1)

      if (newSearchParams === '' && !currentQueryString) {
        return false
      }
      if (newSearchParams !== this.currentSFQueryString || newSearchParams !== currentQueryString) {
        const queryString = newSearchParams ? `?${newSearchParams}` : ''
        let newurl = window.location.protocol + '//' + window.location.host + window.location.pathname + queryString
        window.history.replaceState({ path: newurl }, '', newurl)

        this.routeFullPath = window.location.pathname + (window.location.search || '') // Update for saving scroll position
        return true
      }

      return false
    },
    settingsUpdated() {
      const nextHideNonAudiobooks = !!this.hideNonAudiobooks
      if (nextHideNonAudiobooks !== this.lastHideNonAudiobooks) {
        this.lastHideNonAudiobooks = nextHideNonAudiobooks
        this.resetEntities()
        return
      }

      const wasUpdated = this.checkUpdateSearchParams()
      if (wasUpdated) {
        this.resetEntities()
      }
    },
    libraryChanged() {
      if (this.currentLibraryMediaType !== 'book' && (this.page === 'series' || this.page === 'collections' || this.page === 'series-books' || this.page === 'author-books' || this.page === 'narrator-books')) {
        this.$router.replace('/bookshelf')
        return
      }

      if (this.hasFilter) {
        this.clearFilter()
      } else {
        this.resetEntities()
      }
    },
    seriesOrderChanged() {
      if (this.page === 'series' || this.entityName === 'series') {
        this.resetEntities()
      }
    },
    libraryItemAdded(libraryItem) {
      console.log('libraryItem added', libraryItem)
      // TODO: Check if item would be on this shelf
      this.resetEntities()
    },
    libraryItemUpdated(libraryItem) {
      console.log('Item updated', libraryItem)
      if (this.entityName === 'books' || this.entityName === 'series-books' || this.entityName === 'author-books' || this.entityName === 'narrator-books') {
        var indexOf = this.entities.findIndex((ent) => ent && ent.id === libraryItem.id)
        if (indexOf >= 0) {
          this.entities[indexOf] = libraryItem
          if (this.entityComponentRefs[indexOf]) {
            this.entityComponentRefs[indexOf].setEntity(libraryItem)

            if (this.isBookEntity) {
              var localLibraryItem = this.localLibraryItems.find((lli) => lli.libraryItemId == libraryItem.id)
              if (localLibraryItem) {
                this.entityComponentRefs[indexOf].setLocalLibraryItem(localLibraryItem)
              }
            }
          }
        }
      }
    },
    libraryItemRemoved(libraryItem) {
      if (this.entityName === 'books' || this.entityName === 'series-books' || this.entityName === 'author-books' || this.entityName === 'narrator-books') {
        var indexOf = this.entities.findIndex((ent) => ent && ent.id === libraryItem.id)
        if (indexOf >= 0) {
          this.entities = this.entities.filter((ent) => ent.id !== libraryItem.id)
          this.totalEntities = this.entities.length
          this.$eventBus.$emit('bookshelf-total-entities', this.totalEntities)
          this.executeRebuild()
        }
      }
    },
    libraryItemsAdded(libraryItems) {
      console.log('items added', libraryItems)
      // TODO: Check if item would be on this shelf
      this.resetEntities()
    },
    libraryItemsUpdated(libraryItems) {
      libraryItems.forEach((ab) => {
        this.libraryItemUpdated(ab)
      })
    },
    screenOrientationChange() {
      setTimeout(() => {
        console.log('LazyBookshelf Screen orientation change')
        this.resetEntities()
      }, 50)
    },
    initListeners() {
      if (this.listenersInitialized) return
      const bookshelf = document.getElementById('bookshelf-wrapper')
      if (bookshelf) {
        bookshelf.addEventListener('scroll', this.scroll, { passive: true })
      }

      this.$eventBus.$on('library-changed', this.libraryChanged)
      this.$eventBus.$on('user-settings', this.settingsUpdated)
      this.$eventBus.$on('series-order-change', this.seriesOrderChanged)

      this.$socket.$on('item_updated', this.libraryItemUpdated)
      this.$socket.$on('item_added', this.libraryItemAdded)
      this.$socket.$on('item_removed', this.libraryItemRemoved)
      this.$socket.$on('items_updated', this.libraryItemsUpdated)
      this.$socket.$on('items_added', this.libraryItemsAdded)

      if (screen.orientation) {
        // Not available on ios
        screen.orientation.addEventListener('change', this.screenOrientationChange)
      } else {
        document.addEventListener('orientationchange', this.screenOrientationChange)
      }
      this.listenersInitialized = true
    },
    removeListeners() {
      if (!this.listenersInitialized) return
      const bookshelf = document.getElementById('bookshelf-wrapper')
      if (bookshelf) {
        bookshelf.removeEventListener('scroll', this.scroll)
      }

      this.$eventBus.$off('library-changed', this.libraryChanged)
      this.$eventBus.$off('user-settings', this.settingsUpdated)
      this.$eventBus.$off('series-order-change', this.seriesOrderChanged)

      this.$socket.$off('item_updated', this.libraryItemUpdated)
      this.$socket.$off('item_added', this.libraryItemAdded)
      this.$socket.$off('item_removed', this.libraryItemRemoved)
      this.$socket.$off('items_updated', this.libraryItemsUpdated)
      this.$socket.$off('items_added', this.libraryItemsAdded)

      if (screen.orientation) {
        // Not available on ios
        screen.orientation.removeEventListener('change', this.screenOrientationChange)
      } else {
        document.removeEventListener('orientationchange', this.screenOrientationChange)
      }
      this.listenersInitialized = false
    }
  },
  updated() {
    this.routeFullPath = window.location.pathname + (window.location.search || '')
  },
  mounted() {
    this.routeFullPath = window.location.pathname + (window.location.search || '')

    this.init()
    this.initListeners()
  },
  activated() {
    this.routeFullPath = window.location.pathname + (window.location.search || '')
    this.restoreScrollPosition()
    this.initListeners()
  },
  deactivated() {
    this.saveScrollPosition()
    this.saveViewCache()
    this.removeListeners()
  },
  beforeDestroy() {
    if (this._scrollTrailingTimer) {
      clearTimeout(this._scrollTrailingTimer)
      this._scrollTrailingTimer = null
    }
    this.saveViewCache()
    this.removeListeners()
    this.saveScrollPosition()
  }
}
</script>

<style>
/* Material 3 Expressive Vertical Scroll Container */
.library-scroll-container {
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}

/* Paint optimization: each shelf is an isolated layout/paint scope so the
   browser can skip layout/paint work for shelves outside the viewport. This
   significantly reduces scroll jank on long libraries. */
.shelf-list-view {
  contain: layout paint style;
  content-visibility: auto;
}

/* Loading skeleton animations */
.loading-skeleton {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
  animation: skeletonSlideIn 600ms cubic-bezier(0.2, 0, 0, 1) forwards;
}

.series-grid-skeleton {
  border-radius: 16px;
  overflow: hidden;
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
  background: linear-gradient(90deg, transparent, rgba(var(--md-sys-color-on-surface), 0.06), transparent);
  animation: shimmer 1200ms linear infinite;
}

@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

@keyframes skeletonSlideIn {
  0% {
    opacity: 0;
    transform: translateY(20px) scale(0.95);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* Grid layout styles */
.shelf-grid-view {
  /* Grid layout is set via inline styles for dynamic columns */
  position: relative;
}

.shelf-list-view {
  position: relative;
}
</style>
