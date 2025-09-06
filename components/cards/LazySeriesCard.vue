<template>
  <div ref="card" :id="`series-card-${index}`" :style="{ minWidth: width + 'px', maxWidth: width + 'px', height: height + 'px' }" class="material-3-card rounded-2xl cursor-pointer z-30 bg-surface-container shadow-elevation-1 hover:shadow-elevation-3 transition-all duration-300 ease-expressive state-layer overflow-hidden relative" @click="clickCard">
    <!-- Series cover container - single representative image -->
    <div class="cover-container absolute inset-0 overflow-hidden z-0">
      <!-- Blurred background for aspect ratio mismatch -->
      <div v-show="showCoverBg" class="absolute inset-0 z-0">
        <div class="absolute cover-bg inset-0" ref="coverBg" />
      </div>

      <!-- Loading placeholder -->
      <div v-show="series && !imageReady" class="absolute inset-0 flex items-center justify-center bg-surface-container z-10">
        <p :style="{ fontSize: sizeMultiplier * 0.8 + 'rem' }" class="text-on-surface-variant text-center">{{ title }}</p>
      </div>

      <!-- Series cover image - use first book's cover -->
      <covers-book-cover
        v-if="series && firstBook && hasCover"
        ref="cover"
        :library-item="firstBook"
        :width="width"
        :book-cover-aspect-ratio="bookCoverAspectRatio"
        :show-resolution="false"
        :show-progress="false"
        raw
        @imageLoaded="imageLoaded"
        class="w-full h-full transition-opacity duration-300"
        :style="{
          opacity: imageReady ? 1 : 0
        }"
      />

      <!-- Placeholder for series without covers -->
      <div v-if="series && (!firstBook || !hasCover)" class="absolute inset-0 flex flex-col items-center justify-center bg-primary p-4 z-10">
        <div class="text-center">
          <p class="text-on-primary font-medium mb-2" :style="{ fontSize: titleFontSize + 'rem' }">{{ title }}</p>
          <p class="text-on-primary opacity-75" :style="{ fontSize: subtitleFontSize + 'rem' }">{{ books.length }} {{ books.length === 1 ? 'Book' : 'Books' }}</p>
        </div>
      </div>
    </div>

    <!-- Series book count badge -->
    <div class="absolute top-2 right-2 z-30">
      <div class="bg-primary-container shadow-elevation-3 rounded-full border border-outline-variant border-opacity-30 flex items-center justify-center px-2 py-1">
        <span class="text-on-primary-container font-bold text-xs">{{ books.length }}</span>
      </div>
    </div>

    <!-- Progress indicator with enhanced visibility -->
    <div v-if="seriesPercentInProgress > 0" class="absolute bottom-0 left-0 w-full h-1.5 z-40 rounded-bl-2xl rounded-br-2xl overflow-hidden">
      <!-- Blurred background for incomplete portion to improve visibility -->
      <div class="w-full h-full bg-surface-dynamic bg-opacity-60 backdrop-blur-sm rounded-bl-2xl rounded-br-2xl shadow-elevation-2"></div>
      <!-- Progress fill that starts from the corner -->
      <div
        class="absolute top-0 left-0 h-full shadow-elevation-4 ring-1 ring-surface-variant ring-opacity-50"
        :class="isSeriesFinished ? 'bg-tertiary' : 'bg-primary'"
        :style="{
          width: Math.max(seriesPercentInProgress * 100, seriesPercentInProgress > 0 ? 4 : 0) + '%',
          borderRadius: seriesPercentInProgress < 1 ? '0 4px 4px 0' : '8px 8px 8px 8px'
        }"
      ></div>
    </div>

    <!-- Series title overlay -->
    <div class="absolute bottom-2 left-2 z-50 max-w-[70%]">
      <div class="bg-surface-container bg-opacity-95 backdrop-blur-md rounded-lg p-2 shadow-elevation-2 border border-outline-variant border-opacity-20">
        <p class="truncate text-on-surface font-bold drop-shadow-sm" :style="{ fontSize: labelFontSize * 0.8 + 'rem' }">{{ title }}</p>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    index: Number,
    width: Number,
    height: Number,
    bookCoverAspectRatio: Number,
    seriesMount: {
      type: Object,
      default: () => null
    },
    isAltViewEnabled: Boolean,
    isCategorized: Boolean
  },
  data() {
    return {
      series: null,
      isSelectionMode: false,
      selected: false,
      imageReady: false,
      showCoverBg: false
    }
  },
  computed: {
    labelFontSize() {
      if (this.width < 160) return 0.75
      return 0.875
    },
    titleFontSize() {
      return Math.min(this.sizeMultiplier * 0.8, 1.1)
    },
    subtitleFontSize() {
      return Math.min(this.sizeMultiplier * 0.7, 0.9)
    },
    sizeMultiplier() {
      // Use same calculation as book cards for consistent sizing
      var baseSize = this.bookCoverAspectRatio === 1 ? 192 : 120
      return this.width / baseSize
    },
    title() {
      return this.series ? this.series.name : ''
    },
    books() {
      return this.series ? this.series.books || [] : []
    },
    firstBook() {
      return this.books.length > 0 ? this.books[0] : null
    },
    hasCover() {
      return this.firstBook && this.firstBook.media && this.firstBook.media.coverPath
    },
    seriesBookProgress() {
      return this.books
        .map((libraryItem) => {
          return this.store.getters['user/getUserMediaProgress'](libraryItem.id)
        })
        .filter((p) => !!p)
    },
    seriesBooksFinished() {
      return this.seriesBookProgress.filter((p) => p.isFinished)
    },
    hasSeriesBookInProgress() {
      return this.seriesBookProgress.some((p) => !p.isFinished && p.progress > 0)
    },
    seriesPercentInProgress() {
      let totalFinishedAndInProgress = this.seriesBooksFinished.length
      if (this.hasSeriesBookInProgress) totalFinishedAndInProgress += 1
      return Math.min(1, Math.max(0, totalFinishedAndInProgress / this.books.length))
    },
    isSeriesFinished() {
      return this.books.length === this.seriesBooksFinished.length
    },
    store() {
      return this.$store || this.$nuxt.$store
    },
    currentLibraryId() {
      return this.store.state.libraries.currentLibraryId
    },
    seriesId() {
      return this.series ? this.series.id : null
    }
  },
  methods: {
    setEntity(_series) {
      this.series = _series
    },
    setSelectionMode(val) {
      this.isSelectionMode = val
    },
    imageLoaded() {
      this.imageReady = true
      // Set up blurred background effect similar to book cards
      this.$nextTick(() => {
        if (this.$refs.cover && this.hasCover) {
          this.showCoverBg = true
          this.$nextTick(() => {
            if (this.$refs.coverBg) {
              const coverSrc = this.$refs.cover.$el?.querySelector('img')?.src || this.$refs.cover.coverSrc
              if (coverSrc) {
                this.$refs.coverBg.style.backgroundImage = `url("${coverSrc}")`
                this.$refs.coverBg.style.filter = 'blur(8px)'
                this.$refs.coverBg.style.transform = 'scale(1.1)'
                this.$refs.coverBg.style.backgroundSize = 'cover'
                this.$refs.coverBg.style.backgroundPosition = 'center center'
                this.$refs.coverBg.style.backgroundRepeat = 'no-repeat'
              }
            }
          })
        }
      })
    },
    clickCard() {
      if (!this.series) return
      var router = this.$router || this.$nuxt.$router
      router.push(`/bookshelf/series/${this.seriesId}`)
    },
    destroy() {
      // destroy the vue listeners, etc
      this.$destroy()

      // remove the element from the DOM
      if (this.$el && this.$el.parentNode) {
        this.$el.parentNode.removeChild(this.$el)
      } else if (this.$el && this.$el.remove) {
        this.$el.remove()
      }
    }
  },
  mounted() {
    if (this.seriesMount) {
      this.setEntity(this.seriesMount)
    }
  },
  beforeDestroy() {}
}
</script>

<style scoped>
/* Material 3 Expressive Series Card Styles */
.material-3-card {
  transition: box-shadow 300ms cubic-bezier(0.2, 0, 0, 1), transform 300ms cubic-bezier(0.2, 0, 0, 1);
}

.material-3-card::before {
  content: '';
  position: absolute;
  border-radius: inherit;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: transparent;
  transition: background-color 200ms cubic-bezier(0.2, 0, 0, 1);
  pointer-events: none;
  z-index: 1;
}

.material-3-card:hover {
  transform: translateY(-2px);
}

.material-3-card:hover::before {
  background-color: rgba(var(--md-sys-color-on-surface), 0.08);
}

.material-3-card:active {
  transform: translateY(0px);
}

.material-3-card:active::before {
  background-color: rgba(var(--md-sys-color-on-surface), 0.12);
}

/* Ensure content stays above state layer, but exclude cover container and absolutely positioned elements */
.material-3-card > *:not(.cover-container):not(.absolute) {
  position: relative;
  z-index: 2;
}

/* Force cover images to fit container */
.material-3-card .covers-group-cover,
.material-3-card .covers-group-cover > div,
.material-3-card .covers-group-cover img,
.material-3-card img {
  object-fit: cover;
  object-position: center center;
}

/* Ensure cover container fills the square card */
.material-3-card > div:first-child {
  width: 100%;
  height: 100%;
}

/* Enhanced text visibility */
.drop-shadow-sm {
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
}

/* Ensure overlays are always visible */
.bg-opacity-95 {
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* Expressive easing definition */
.ease-expressive {
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}

/* Legacy class support */
.categoryPlacard {
  transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
}

.material-3-card:hover .categoryPlacard {
  transform: scale(1.02);
}

/* Hide scrollbars for smooth scrolling experience */
.scrollbar-hide {
  -ms-overflow-style: none; /* Internet Explorer 10+ */
  scrollbar-width: none; /* Firefox */
}

.scrollbar-hide::-webkit-scrollbar {
  display: none; /* Safari and Chrome */
}

/* Smooth scrolling behavior */
.scrollbar-hide {
  scroll-behavior: smooth;
}

/* Line clamp utility for text truncation */
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
