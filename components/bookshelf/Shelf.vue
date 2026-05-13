<template>
  <div class="w-full relative">
    <div v-if="altViewEnabled" class="px-5 pb-2 pt-3 shelf-loading">
      <p class="font-semibold" :style="{ fontSize: sizeMultiplier + 'rem' }">{{ label }}</p>
    </div>

    <div class="flex items-end px-3 max-w-full overflow-x-auto shelf-scroll-container" :class="altViewEnabled ? '' : 'bookshelfRow'" :style="{ height: shelfHeight + 'px', paddingBottom: entityPaddingBottom + 'px' }">
      <template v-for="(entity, index) in entities">
        <cards-lazy-book-card v-if="type === 'book' || type === 'podcast'" :key="entity.id" :index="index" :book-mount="entity" :width="bookWidth" :height="entityHeight" :book-cover-aspect-ratio="bookCoverAspectRatio" :is-alt-view-enabled="altViewEnabled" class="mx-1 relative" :class="getItemAnimationClass(index)" :style="getItemAnimationStyle(index)" />
        <cards-lazy-book-card v-if="type === 'episode'" :key="entity.recentEpisode.id" :index="index" :book-mount="entity" :width="bookWidth" :height="entityHeight" :book-cover-aspect-ratio="bookCoverAspectRatio" :is-alt-view-enabled="altViewEnabled" class="mx-1 relative" :class="getItemAnimationClass(index)" :style="getItemAnimationStyle(index)" />
        <cards-lazy-series-card v-else-if="type === 'series'" :key="entity.id" :index="index" :series-mount="entity" :width="bookWidth" :height="entityHeight" :book-cover-aspect-ratio="bookCoverAspectRatio" :is-alt-view-enabled="altViewEnabled" is-categorized class="mx-1 relative" :class="getItemAnimationClass(index)" :style="getItemAnimationStyle(index)" />
        <cards-author-card v-else-if="type === 'authors'" :key="entity.id" :width="bookWidth" :height="bookWidth" :author="entity" :size-multiplier="sizeMultiplier" class="mx-1" :class="getItemAnimationClass(index)" :style="getItemAnimationStyle(index)" />
      </template>
    </div>

    <div v-if="!altViewEnabled" class="absolute text-center categoryPlacardtransform z-30 bottom-0.5 left-4 md:left-8 w-36 rounded-md shelf-loading" style="height: 18px">
      <div class="w-full h-full flex items-center justify-center rounded-sm border shinyBlack">
        <p class="transform text-xs">{{ label }}</p>
      </div>
    </div>
    <div v-if="!altViewEnabled" class="w-full h-1 z-40 bookshelfDivider"></div>
  </div>
</template>

<script>
export default {
  props: {
    label: String,
    type: String,
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
      return this.entityHeight + 24 // Original spacing for bookshelf view
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
/* Material 3 Expressive Scroll Container */
.shelf-scroll-container {
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-x: contain;
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
