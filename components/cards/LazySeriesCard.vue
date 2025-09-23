<template>
  <div 
    ref="card" 
    :id="`series-card-${index}`" 
    :style="{ minWidth: width + 'px', maxWidth: width + 'px', height: height + 'px' }" 
    class="material-3-card rounded-2xl z-10 bg-surface-container cursor-pointer shadow-elevation-1 hover:shadow-elevation-3 transition-all duration-300 ease-expressive state-layer relative" 
    @click="clickCard"
  >
    <!-- Cover image container - fills entire card (first in DOM, lowest z-index) -->
    <div class="cover-container absolute inset-0 z-0">
      <!-- Loading placeholder -->
      <div v-show="seriesMount && !imageReady" class="absolute inset-0 flex items-center justify-center bg-surface-container z-10">
        <p :style="{ fontSize: sizeMultiplier * 0.8 + 'rem' }" class="text-on-surface-variant text-center">{{ seriesName }}</p>
      </div>

      <!-- Group cover for series -->
      <covers-group-cover
        v-if="seriesMount && bookItems.length"
        :id="seriesMount.id"
        :name="seriesName"
        :book-items="bookItems"
        :width="width"
        :height="height"
        :book-cover-aspect-ratio="bookCoverAspectRatio"
        class="w-full h-full"
        @ready="imageReady = true"
      />

      <!-- Material Symbol placeholder for empty series -->
      <div v-else-if="seriesMount" class="w-full h-full absolute inset-0 flex items-center justify-center bg-surface-container z-5">
        <span class="material-symbols text-6xl text-on-surface-variant">library_books</span>
      </div>

      <!-- Placeholder Cover Title -->
      <div v-if="!bookItems.length" class="absolute inset-0 flex flex-col items-center justify-center bg-primary p-4 z-10">
        <div class="text-center">
          <p class="text-on-primary font-medium mb-2" :style="{ fontSize: titleFontSize + 'rem' }">{{ seriesName }}</p>
          <p class="text-on-primary opacity-75" :style="{ fontSize: authorFontSize + 'rem' }">{{ booksInSeries }} {{ $strings.LabelBooks }}</p>
        </div>
      </div>
    </div>

    <!-- Alternative bookshelf title/author/sort with improved visibility -->
    <div v-if="isAltViewEnabled" class="absolute bottom-2 left-2 z-50 max-w-[80%]">
      <div class="bg-card-title-overlay backdrop-blur-md rounded-lg p-2 shadow-elevation-3 border border-outline border-opacity-25">
        <div :style="{ fontSize: 0.7 * sizeMultiplier + 'rem' }" class="flex items-center">
          <p class="truncate text-on-surface font-medium" :style="{ fontSize: 0.7 * sizeMultiplier + 'rem' }">
            {{ seriesName }}
          </p>
        </div>
        <p class="truncate text-on-surface-variant" :style="{ fontSize: 0.6 * sizeMultiplier + 'rem' }">{{ booksInSeries }} {{ $strings.LabelBooks }}</p>
      </div>
    </div>

    <!-- Books count badge with enhanced visibility -->
    <div v-if="booksInSeries > 1" class="absolute rounded-lg bg-secondary-container shadow-elevation-3 z-30 border border-outline-variant border-opacity-30" :style="{ top: '8px', right: '8px', padding: `${0.15 * sizeMultiplier}rem ${0.3 * sizeMultiplier}rem` }">
      <p class="text-on-secondary-container font-bold" :style="{ fontSize: sizeMultiplier * 0.7 + 'rem' }">{{ booksInSeries }}</p>
    </div>

    <!-- Series progress indicator if any books have progress -->
    <div v-if="seriesProgressPercent > 0" class="absolute top-2 left-2 z-40">
      <!-- Completed series check mark -->
      <div v-if="seriesIsFinished" class="bg-primary-container shadow-elevation-4 rounded-full border-2 border-outline-variant border-opacity-40 flex items-center justify-center backdrop-blur-sm" :style="{ width: 1.5 * sizeMultiplier + 'rem', height: 1.5 * sizeMultiplier + 'rem' }">
        <span class="material-symbols text-on-primary-container drop-shadow-sm" :style="{ fontSize: sizeMultiplier * 0.8 + 'rem' }">check</span>
      </div>
      <!-- Progress circle for incomplete series -->
      <div v-else class="relative rounded-full backdrop-blur-sm bg-surface-container bg-opacity-80 border-2 border-outline-variant border-opacity-40 shadow-elevation-3" :style="{ width: 1.5 * sizeMultiplier + 'rem', height: 1.5 * sizeMultiplier + 'rem' }">
        <!-- Background circle (subtle) -->
        <svg class="absolute inset-0 w-full h-full transform -rotate-90" viewBox="0 0 36 36">
          <path
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="rgba(var(--md-sys-color-outline-variant), 0.3)"
            stroke-width="2"
            stroke-dasharray="100, 100"
          />
          <!-- Progress circle -->
          <path
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="rgb(var(--md-sys-color-primary))"
            stroke-width="3"
            stroke-linecap="round"
            :stroke-dasharray="`${seriesProgressPercent * 100}, 100`"
            class="transition-all duration-300 ease-out"
          />
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
      imageReady: false
    }
  },
  computed: {
    sizeMultiplier() {
      const baseSize = this.bookCoverAspectRatio === 1 ? 192 : 120
      return this.width / baseSize
    },
    seriesName() {
      return this.seriesMount?.name || ''
    },
    bookItems() {
      return this.seriesMount?.books || []
    },
    booksInSeries() {
      return this.bookItems.length
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
      if (!this.bookItems.length) return 0
      
      let totalProgress = 0
      let booksWithProgress = 0
      
      this.bookItems.forEach(book => {
        if (book.userMediaProgress) {
          totalProgress += book.userMediaProgress.progress || 0
          booksWithProgress++
        }
      })
      
      if (booksWithProgress === 0) return 0
      return totalProgress / booksWithProgress
    },
    seriesIsFinished() {
      if (!this.bookItems.length) return false
      return this.bookItems.every(book => 
        book.userMediaProgress && book.userMediaProgress.isFinished
      )
    }
  },
  methods: {
    clickCard() {
      if (this.seriesMount?.id) {
        const routePath = `/bookshelf/series/${this.seriesMount.id}`
        this.$router.push(routePath)
      }
    }
  },
  mounted() {
    // Set image as ready after a short delay if no group cover
    if (!this.bookItems.length) {
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

.bg-card-title-overlay {
  background-color: rgba(var(--md-sys-color-surface), 0.85);
}
</style>