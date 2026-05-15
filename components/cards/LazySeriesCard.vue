<template>
  <div ref="card" :id="`series-card-${index}`" :style="{ minWidth: width + 'px', maxWidth: width + 'px', height: height + 'px' }" class="material-3-card series-card-shell expressive-card p-0 rounded-2xl z-10 bg-surface-container cursor-pointer shadow-elevation-1 hover:shadow-elevation-3 transition-all duration-300 ease-expressive state-layer relative overflow-hidden" @click="clickCard">
    <!-- Cover image container - fills entire card (first in DOM, lowest z-index) -->
    <div class="cover-container series-image-container z-0" :class="{ 'image-only': !isAltViewEnabled }">
      <!-- Loading placeholder -->
      <div v-show="hasSeriesData && !imageReady" class="absolute inset-0 flex items-center justify-center bg-surface-container z-10">
        <p :style="{ fontSize: sizeMultiplier * 0.8 + 'rem' }" class="text-on-surface-variant text-center">{{ seriesName }}</p>
      </div>

      <!-- Full-bleed series collage -->
      <div v-if="hasSeriesData && coverBookItems.length" class="series-collage" :class="`count-${Math.min(coverBookItems.length, 4)}`">
        <img v-for="(book, idx) in coverBookItems.slice(0, 4)" :key="book.id || idx" :src="coverSrcFor(book)" loading="lazy" decoding="async" class="series-collage-item" />
      </div>

      <!-- Material Symbol placeholder for empty series -->
      <div v-else-if="hasSeriesData" class="w-full h-full absolute inset-0 flex items-center justify-center bg-surface-container z-5">
        <span class="material-symbols text-6xl text-on-surface-variant">library_books</span>
      </div>

      <!-- Placeholder Cover Title -->
      <div v-if="!coverBookItems.length" class="absolute inset-0 flex flex-col items-center justify-center bg-primary p-4 z-10">
        <div class="text-center">
          <p class="text-on-primary font-medium mb-2" :style="{ fontSize: titleFontSize + 'rem' }">{{ seriesName }}</p>
          <p class="text-on-primary opacity-75" :style="{ fontSize: authorFontSize + 'rem' }">{{ booksInSeries }} {{ $strings.LabelBooks }}</p>
        </div>
      </div>
    </div>

    <div v-if="isAltViewEnabled" class="series-meta absolute left-0 right-0 bottom-0 z-20">
      <p class="series-name" :style="{ fontSize: sizeMultiplier * 0.86 + 'rem' }">
        <span class="series-name-text">{{ seriesName }}</span>
      </p>
      <p class="series-books" :style="{ fontSize: sizeMultiplier * 0.74 + 'rem' }">
        <span class="material-symbols text-label-small mr-1">menu_book</span>
        <span class="series-books-text">{{ booksInSeries }} {{ $strings.LabelBooks }}</span>
      </p>
    </div>

    <!-- Unread-and-not-in-progress books left badge -->
    <div v-if="booksLeftToStart >= 0" class="expressive-books-left absolute z-30 flex items-center gap-1" :style="{ top: '8px', right: '8px', padding: `${0.2 * sizeMultiplier}rem ${0.55 * sizeMultiplier}rem` }">
      <span class="material-symbols text-on-tertiary-container" :style="{ fontSize: sizeMultiplier * 0.85 + 'rem' }">menu_book</span>
      <p class="text-on-tertiary-container font-bold leading-none" :style="{ fontSize: sizeMultiplier * 0.75 + 'rem' }">{{ booksLeftToStart }}</p>
    </div>

    <!-- Series progress indicator if any books have progress -->
    <div v-if="seriesProgressPercent > 0" class="absolute top-2 left-2 z-40">
      <!-- Completed series check mark -->
      <div v-if="seriesIsFinished" class="expressive-badge expressive-badge--finished rounded-full flex items-center justify-center" :style="{ width: 1.75 * sizeMultiplier + 'rem', height: 1.75 * sizeMultiplier + 'rem' }">
        <span class="material-symbols text-on-tertiary-container" :style="{ fontSize: sizeMultiplier * 0.95 + 'rem' }">check</span>
      </div>
      <!-- Progress circle for incomplete series -->
      <div v-else class="expressive-progress-ring relative rounded-full" :style="{ width: 1.75 * sizeMultiplier + 'rem', height: 1.75 * sizeMultiplier + 'rem' }">
        <!-- Background circle (subtle) -->
        <svg class="absolute inset-0 w-full h-full transform -rotate-90" viewBox="0 0 36 36">
          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="rgba(var(--md-sys-color-outline-variant), 0.45)" stroke-width="3" stroke-dasharray="100, 100" />
          <!-- Progress circle -->
          <path class="expressive-progress-ring__fill" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="url(#expressiveProgressGradient)" stroke-width="4" stroke-linecap="round" :stroke-dasharray="`${seriesProgressPercent * 100}, 100`" />
        </svg>
        <svg width="0" height="0" class="absolute">
          <defs>
            <linearGradient id="expressiveProgressGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="rgb(var(--md-sys-color-secondary))" />
              <stop offset="100%" stop-color="rgb(var(--md-sys-color-primary))" />
            </linearGradient>
          </defs>
        </svg>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    index: Number,
    seriesMount: {
      type: Object,
      default: () => null
    },
    width: Number,
    height: Number,
    bookCoverAspectRatio: Number,
    isAltViewEnabled: Boolean,
    isCategorized: Boolean
  },
  data() {
    return {
      imageReady: false,
      seriesEntity: null,
      fetchedCoverBooks: []
    }
  },
  watch: {
    seriesMount: {
      immediate: true,
      handler(newVal) {
        this.seriesEntity = newVal || null
        this.fetchedCoverBooks = []
        this.maybeFetchCoverBooks()
      }
    },
    coverBookItems: {
      immediate: true,
      handler(newItems) {
        if (Array.isArray(newItems) && newItems.length) {
          this.$nextTick(() => {
            this.imageReady = true
          })
        }
      }
    }
  },
  computed: {
    seriesData() {
      return this.seriesEntity || this.seriesMount || {}
    },
    hasSeriesData() {
      return !!(this.seriesData?.id || this.seriesData?.name)
    },
    sizeMultiplier() {
      const baseSize = this.bookCoverAspectRatio === 1 ? 192 : 120
      return this.width / baseSize
    },
    seriesName() {
      return this.seriesData?.name || ''
    },
    coverBookItems() {
      if (Array.isArray(this.seriesData?.coverBooks) && this.seriesData.coverBooks.length) {
        return this.seriesData.coverBooks.slice(0, 4)
      }
      if (Array.isArray(this.seriesData?.books) && this.seriesData.books.length) {
        return this.seriesData.books.slice(0, 4)
      }
      return this.fetchedCoverBooks
    },
    progressBookItems() {
      return this.seriesMount?.books || this.coverBookItems
    },
    booksInSeries() {
      const series = this.seriesData || {}
      const totalCandidates = [series.numBooks, series.audiobookCount, series.booksCount, series.totalBooks, series.numItems, series?.stats?.numBooks]
      for (const candidate of totalCandidates) {
        const parsed = Number(candidate)
        if (Number.isFinite(parsed) && parsed >= 0) {
          return parsed
        }
      }
      return this.progressBookItems.length
    },
    startedBooksCount() {
      if (this.seriesData) {
        const startedCandidates = [this.seriesData.numStartedBooks, this.seriesData.startedBooksCount, this.seriesData.numBooksStarted, this.seriesData?.stats?.numStartedBooks]
        for (const candidate of startedCandidates) {
          const parsed = Number(candidate)
          if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed
          }
        }
      }

      if (!Array.isArray(this.progressBookItems) || !this.progressBookItems.length) return 0

      const startedIds = new Set()
      this.progressBookItems.forEach((book) => {
        const bookId = book?.id || book?.libraryItemId
        if (!bookId) return

        const progress = book?.userMediaProgress || null
        if (progress && (progress.isFinished || (progress.progress || 0) > 0)) {
          startedIds.add(bookId)
        }
      })

      // Continue-series home shelves can omit progress details even when these are known in-progress items.
      // Do not apply this fallback on full series pages, or every badge trends to zero remaining.
      if (!startedIds.size && this.isCategorized) {
        this.progressBookItems.forEach((book) => {
          const bookId = book?.id || book?.libraryItemId
          if (bookId) startedIds.add(bookId)
        })
      }

      return startedIds.size
    },
    booksLeftToStart() {
      const totalBooks = Number(this.booksInSeries || 0)
      const startedBooks = Number(this.startedBooksCount || 0)
      return Math.max(0, totalBooks - startedBooks)
    },
    titleFontSize() {
      if (this.seriesName.length > 30) return 0.6 * this.sizeMultiplier
      if (this.seriesName.length > 15) return 0.7 * this.sizeMultiplier
      return 0.8 * this.sizeMultiplier
    },
    authorFontSize() {
      return 0.6 * this.sizeMultiplier
    },
    seriesProgressPercent() {
      if (!this.progressBookItems.length) return 0

      let totalProgress = 0
      let booksWithProgress = 0

      this.progressBookItems.forEach((book) => {
        if (book.userMediaProgress) {
          totalProgress += book.userMediaProgress.progress || 0
          booksWithProgress++
        }
      })

      if (booksWithProgress === 0) return 0
      return totalProgress / booksWithProgress
    },
    seriesIsFinished() {
      if (!this.progressBookItems.length) return false
      return this.progressBookItems.every((book) => book.userMediaProgress && book.userMediaProgress.isFinished)
    }
  },
  methods: {
    setSelectionMode() {},
    setEntity(seriesEntity) {
      this.seriesEntity = seriesEntity || null
      this.fetchedCoverBooks = []
      this.maybeFetchCoverBooks()
      this.imageReady = Array.isArray(this.coverBookItems) && this.coverBookItems.length > 0
    },
    async maybeFetchCoverBooks() {
      if (Array.isArray(this.coverBookItems) && this.coverBookItems.length) return
      const seriesId = this.seriesData?.id
      const libraryId = this.seriesData?.libraryId
      if (!seriesId || !libraryId) return

      const searchParams = new URLSearchParams()
      searchParams.set('filter', `series.${this.$encode(seriesId)}`)
      searchParams.set('limit', '4')
      searchParams.set('page', '0')
      searchParams.set('minified', '1')

      const payload = await this.$nativeHttp.get(`/api/libraries/${libraryId}/items?${searchParams.toString()}`).catch((error) => {
        console.error('Failed to fetch series cover books', error)
        return null
      })

      if (payload?.results?.length) {
        this.fetchedCoverBooks = payload.results.slice(0, 4)
      }
    },
    coverSrcFor(book) {
      return this.$store.getters['globals/getLibraryItemCoverSrc'](book, '')
    },
    clickCard() {
      if (this.seriesData?.id) {
        const encodedSeriesId = encodeURIComponent(String(this.seriesData.id))
        const routePath = `/bookshelf/series/${encodedSeriesId}`
        this.$router.push(routePath)
      }
    },
    destroy() {
      this.$destroy()
      if (this.$el && this.$el.parentNode) {
        this.$el.parentNode.removeChild(this.$el)
      } else if (this.$el && this.$el.remove) {
        this.$el.remove()
      }
    }
  },
  mounted() {
    // Set image as ready after a short delay if no group cover
    if (!this.coverBookItems.length) {
      setTimeout(() => {
        this.imageReady = true
      }, 100)
    }
  }
}
</script>

<style scoped>
.material-3-card {
  overflow: hidden;
  position: relative;
  border: 1px solid rgba(var(--md-sys-color-outline-variant), 0.35);
  box-shadow: var(--md-sys-elevation-level1);
  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1), box-shadow 180ms cubic-bezier(0.2, 0, 0, 1);
}

.series-card-shell {
  display: block;
  padding: 0 !important;
}

.series-image-container {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: rgb(var(--md-sys-color-surface-container));
  border-radius: inherit;
}

.series-image-container.image-only {
  border-radius: inherit;
}

.series-image-container:not(.image-only) {
  border-radius: inherit;
}

.series-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px 12px;
  background: transparent;
  isolation: isolate;
}

.series-meta::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  background: linear-gradient(180deg, rgba(var(--md-sys-color-surface-container), 0) 2%, rgba(var(--md-sys-color-surface-container), 0.9) 50%, rgba(var(--md-sys-color-surface-container-high), 0.99) 100%);
  backdrop-filter: blur(10px) brightness(0.62) saturate(0.82);
  -webkit-backdrop-filter: blur(10px) brightness(0.62) saturate(0.82);
}

.series-meta > * {
  position: relative;
  z-index: 1;
}

.series-name {
  font-weight: 600;
  color: rgb(var(--md-sys-color-on-media));
  line-height: 1.2;
  margin: 0;
  padding-left: 3px;
  padding-right: 3px;
}

.series-name-text {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 16px;
  padding-right: 16px;
  margin-left: -13px;
  margin-right: -13px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}

.series-books {
  display: flex;
  align-items: center;
  color: rgb(var(--md-sys-color-on-media-variant));
  font-weight: 500;
  line-height: 1.2;
  margin: 0;
  min-width: 0;
  padding-left: 3px;
  padding-right: 3px;
}

.series-books .material-symbols {
  flex: 0 0 auto;
  color: inherit;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.82);
}

.series-books-text {
  display: block;
  max-width: 100%;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 16px;
  padding-right: 16px;
  margin-left: -13px;
  margin-right: -13px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.82);
}

.series-collage {
  position: absolute;
  inset: 0;
  display: grid;
}

.series-collage.count-1 {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
}

.series-collage.count-2 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr;
}

.series-collage.count-3,
.series-collage.count-4 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}

.series-collage.count-3 .series-collage-item:nth-child(3) {
  grid-column: 1 / span 2;
}

.series-collage-item {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
}

.material-3-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--md-sys-elevation-level2);
}

.material-3-card:active {
  transform: translateY(0);
}

/* Material 3 Expressive press response */
.expressive-card {
  transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 220ms cubic-bezier(0.2, 0, 0, 1);
}
.expressive-card:active {
  transform: scale(0.97);
}

/* Expressive badges & books-left pill */
@keyframes expressivePopIn {
  0% {
    transform: scale(0.4);
    opacity: 0;
  }
  60% {
    transform: scale(1.12);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
.expressive-badge {
  animation: expressivePopIn 320ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  border: 2px solid rgba(var(--md-sys-color-surface), 0.65);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18), 0 0 0 2px rgba(var(--md-sys-color-tertiary), 0.25);
}
.expressive-badge--finished {
  background: linear-gradient(135deg, rgb(var(--md-sys-color-tertiary-container)) 0%, rgb(var(--md-sys-color-primary-container)) 100%);
}
.expressive-progress-ring {
  background: rgba(var(--md-sys-color-surface-container), 0.82);
  border: 2px solid rgba(var(--md-sys-color-surface), 0.6);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.22);
}
.expressive-progress-ring__fill {
  filter: drop-shadow(0 0 3px rgba(var(--md-sys-color-primary), 0.7));
  transition: stroke-dasharray 480ms cubic-bezier(0.2, 0, 0, 1);
}
.expressive-books-left {
  background: linear-gradient(135deg, rgb(var(--md-sys-color-tertiary-container)) 0%, rgb(var(--md-sys-color-secondary-container)) 100%);
  border-radius: 999px;
  border: 2px solid rgba(var(--md-sys-color-surface), 0.65);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18), 0 0 0 2px rgba(var(--md-sys-color-tertiary), 0.2);
  animation: expressivePopIn 320ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

.state-layer::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: transparent;
  border-radius: inherit;
  transition: background-color 0.2s ease-in-out;
  pointer-events: none;
}

.state-layer:hover::before {
  background-color: rgba(var(--md-sys-color-on-surface), 0.08);
}

.state-layer:active::before {
  background-color: rgba(var(--md-sys-color-on-surface), 0.12);
}
</style>
