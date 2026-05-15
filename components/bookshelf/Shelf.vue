<template>
  <div class="w-full relative shelf-section">
    <!-- Material 3 Expressive shelf header: prominent title with an accent pip -->
    <div class="shelf-header px-4 pt-3 pb-2 flex items-center gap-2">
      <span class="shelf-accent-pip" />
      <p class="shelf-title text-on-surface" :style="{ fontSize: 1.0 * sizeMultiplier + 'rem' }">{{ label }}</p>
    </div>

    <div class="flex items-end px-3 max-w-full overflow-x-auto shelf-scroll-container" :class="altViewEnabled ? '' : 'bookshelfRow'" :style="{ height: shelfHeight + 'px', paddingBottom: entityPaddingBottom + 'px' }">
      <template v-for="(entity, index) in entities">
        <cards-lazy-book-card v-if="type === 'book' || type === 'podcast'" :key="`book-${entity.id}-${index}`" :index="index" :book-mount="entity" :width="bookWidth" :height="entityHeight" :book-cover-aspect-ratio="bookCoverAspectRatio" :is-alt-view-enabled="altViewEnabled" class="mx-1 relative" :class="getItemAnimationClass(index)" :style="getItemAnimationStyle(index)" />
        <cards-lazy-book-card v-if="type === 'episode'" :key="`episode-${entity.recentEpisode.id}-${index}`" :index="index" :book-mount="entity" :width="bookWidth" :height="entityHeight" :book-cover-aspect-ratio="bookCoverAspectRatio" :is-alt-view-enabled="altViewEnabled" class="mx-1 relative" :class="getItemAnimationClass(index)" :style="getItemAnimationStyle(index)" />
        <cards-lazy-series-card v-else-if="type === 'series'" :key="`series-${entity.id}-${index}`" :index="index" :series-mount="entity" :width="bookWidth" :height="entityHeight" :book-cover-aspect-ratio="bookCoverAspectRatio" :is-alt-view-enabled="altViewEnabled" is-categorized class="mx-1 relative" :class="getItemAnimationClass(index)" :style="getItemAnimationStyle(index)" />
        <cards-author-card v-else-if="type === 'authors'" :key="`author-${entity.id}-${index}`" :width="bookWidth" :height="bookWidth" :author="entity" :size-multiplier="sizeMultiplier" :navigation-mode="authorCardNavigationMode" :show-image="showAuthorImage" class="mx-1" :class="getItemAnimationClass(index)" :style="getItemAnimationStyle(index)" />
      </template>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    label: String,
    type: String,
    shelfId: {
      type: String,
      default: ''
    },
    entities: {
      type: Array,
      default: () => []
    },
    animateItems: {
      type: Boolean,
      default: true
    }
  },
  data() {
    return {}
  },
  computed: {
    entityPaddingBottom() {
      if (!this.altViewEnabled) return 0
      if (this.type === 'authors') return 8
      return 15 * this.sizeMultiplier // Consistent padding for all types
    },
    shelfHeight() {
      if (this.altViewEnabled) {
        var extraTitleSpace = this.type === 'authors' ? 5 : 25
        return this.entityHeight + extraTitleSpace * this.sizeMultiplier
      }
      return this.entityHeight + 8 // header now sits above the row, only a small breathing gap
    },
    bookWidth() {
      // Use base sizes that match card sizeMultiplier calculations
      if (this.isCoverSquareAspectRatio) return 192 // Base size for square covers
      return 120 // Base size for rectangular covers
    },
    bookHeight() {
      if (this.isCoverSquareAspectRatio) return this.bookWidth
      return this.bookWidth * 1.6
    },
    entityHeight() {
      if (this.type === 'authors') return this.bookWidth
      return this.bookHeight
    },
    sizeMultiplier() {
      var baseSize = this.isCoverSquareAspectRatio ? 192 : 120
      return this.bookWidth / baseSize
    },
    isCoverSquareAspectRatio() {
      return this.bookCoverAspectRatio === 1
    },
    bookCoverAspectRatio() {
      return this.$store.getters['libraries/getBookCoverAspectRatio']
    },
    altViewEnabled() {
      return this.$store.getters['getAltViewEnabled']
    },
    isNarratorContinueShelf() {
      return this.shelfId === 'continue-narrators'
    },
    authorCardNavigationMode() {
      if (this.shelfId === 'continue-authors') return 'author-detail'
      if (this.shelfId === 'continue-narrators') return 'narrator-detail'
      return 'library-filter-author'
    },
    showAuthorImage() {
      return !this.isNarratorContinueShelf
    }
  },
  methods: {
    getItemAnimationClass(index) {
      if (!this.animateItems) return []
      return ['item-loading-animation', `loading-delay-${Math.min(index, 8)}`]
    },
    getItemAnimationStyle(index) {
      if (!this.animateItems) return {}
      return { animationDelay: Math.min(index, 8) * 35 + 'ms' }
    }
  },
  mounted() {},
  beforeDestroy() {}
}
</script>

<style scoped>
/* Material 3 Expressive shelf header */
.shelf-section {
  padding-bottom: 4px;
}
.shelf-header {
  user-select: none;
}
.shelf-title {
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.15;
  margin: 0;
}
.shelf-accent-pip {
  display: inline-block;
  width: 6px;
  height: 18px;
  border-radius: 3px;
  background: linear-gradient(180deg, rgb(var(--md-sys-color-primary)) 0%, rgb(var(--md-sys-color-tertiary)) 100%);
  box-shadow: 0 0 0 2px rgba(var(--md-sys-color-primary), 0.12);
  flex-shrink: 0;
}

/* Material 3 Expressive Scroll Container */
.shelf-scroll-container {
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-x: contain;
  /* Promote to its own compositor layer and isolate paint so the row scrolls
     independently of neighbours on the home page. */
  contain: content;
  transform: translateZ(0);
  will-change: scroll-position;
}

/* Enhanced scroll effect for iOS/Android */
.shelf-scroll-container::-webkit-scrollbar {
  display: none;
}

/* Material 3 scroll behavior */
@supports (overscroll-behavior: bounce) {
  .shelf-scroll-container {
    overscroll-behavior-x: auto;
  }
}

/* Material 3 Loading Animations */
.item-loading-animation {
  opacity: 0;
  animation: materialLoadIn 220ms cubic-bezier(0.2, 0, 0, 1) forwards;
}

@keyframes materialLoadIn {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

/* Staggered loading delays for smooth sequential animation */
.loading-delay-0 {
  animation-delay: 0ms;
}
.loading-delay-1 {
  animation-delay: 35ms;
}
.loading-delay-2 {
  animation-delay: 70ms;
}
.loading-delay-3 {
  animation-delay: 105ms;
}
.loading-delay-4 {
  animation-delay: 140ms;
}
.loading-delay-5 {
  animation-delay: 175ms;
}
.loading-delay-6 {
  animation-delay: 210ms;
}
.loading-delay-7 {
  animation-delay: 245ms;
}
.loading-delay-8 {
  animation-delay: 280ms;
}

/* Shelf label animation */
.shelf-loading {
  animation: shelfLabelIn 240ms cubic-bezier(0.2, 0, 0, 1) forwards;
}

@keyframes shelfLabelIn {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

/* Reduce motion for users who prefer it */
@media (prefers-reduced-motion: reduce) {
  .item-loading-animation {
    animation: materialLoadInReduced 300ms ease-out forwards;
  }

  @keyframes materialLoadInReduced {
    0% {
      opacity: 0;
    }
    100% {
      opacity: 1;
    }
  }
}
</style>
