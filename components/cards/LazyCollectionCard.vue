<template>
  <div ref="card" :id="`collection-card-${index}`" :style="{ width: width + 'px', height: height + 'px' }" class="material-3-card rounded-2xl cursor-pointer z-30 bg-surface-container shadow-elevation-1 hover:shadow-elevation-3 transition-all duration-300 ease-expressive state-layer overflow-hidden relative" @click="clickCard">
    <!-- Collection cover container - fills entire card -->
    <div class="absolute inset-0 rounded-2xl overflow-hidden z-0">
      <covers-collection-cover ref="cover" :book-items="books" :width="width" :height="height" :book-cover-aspect-ratio="bookCoverAspectRatio" class="w-full h-full" />
    </div>

    <!-- Collection title placard with enhanced visibility -->
    <div class="categoryPlacard absolute z-50 left-0 right-0 mx-auto -bottom-6 h-6 rounded-lg text-center shadow-elevation-3" :style="{ width: Math.min(240, width) + 'px' }">
      <div class="w-full h-full flex items-center justify-center rounded-lg bg-surface-container bg-opacity-95 backdrop-blur-md border border-outline-variant border-opacity-20" :style="{ padding: `0rem ${0.5 * sizeMultiplier}rem` }">
        <p class="truncate text-on-surface font-bold drop-shadow-sm" :style="{ fontSize: labelFontSize + 'rem' }">{{ title }}</p>
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
    isAltViewEnabled: Boolean
  },
  data() {
    return {
      collection: null,
      isSelectionMode: false,
      selected: false
    }
  },
  computed: {
    labelFontSize() {
      if (this.width < 160) return 0.75
      return 0.875
    },
    sizeMultiplier() {
      if (this.bookCoverAspectRatio === 1) return this.width / (120 * 1.6 * 2)
      return this.width / 240
    },
    title() {
      return this.collection ? this.collection.name : ''
    },
    books() {
      return this.collection ? this.collection.books || [] : []
    },
    store() {
      return this.$store || this.$nuxt.$store
    },
    currentLibraryId() {
      return this.store.state.libraries.currentLibraryId
    }
  },
  methods: {
    setEntity(_collection) {
      this.collection = _collection
    },
    setSelectionMode(val) {
      this.isSelectionMode = val
    },
    clickCard() {
      if (!this.collection) return
      var router = this.$router || this.$nuxt.$router
      router.push(`/collection/${this.collection.id}`)
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
  mounted() {}
}
</script>

<style scoped>
/* Material 3 Expressive Collection Card Styles */
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

/* Force square aspect ratio for collection covers */
.material-3-card .covers-collection-cover,
.material-3-card img {
  aspect-ratio: 1 / 1;
  object-fit: cover;
  object-position: center center;
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
</style>
