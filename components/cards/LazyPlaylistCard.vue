<template>
  <div ref="card" :id="`playlist-card-${index}`" :style="{ width: width + 'px', height: height + 'px' }" class="material-3-card absolute top-0 left-0 rounded-2xl z-30 cursor-pointer overflow-hidden shadow-elevation-2" @click="clickCard">
    <!-- Background cover with square aspect ratio -->
    <div class="absolute inset-0 w-full h-full z-0">
      <covers-playlist-cover ref="cover" :items="items" :width="width" :height="height" class="w-full h-full object-cover" />
    </div>

    <!-- Title placard with enhanced visibility -->
    <div class="categoryPlacard absolute z-40 left-0 right-0 mx-auto -bottom-6 h-6 rounded-md text-center" :style="{ width: Math.min(160, width) + 'px' }">
      <div class="w-full h-full flex items-center justify-center rounded-lg border backdrop-blur-md bg-surface-container bg-opacity-95 shadow-lg drop-shadow-sm" :class="isAltViewEnabled ? 'altBookshelfLabel' : 'border-outline-variant'" :style="{ padding: `0rem ${0.5 * sizeMultiplier}rem` }">
        <p class="truncate text-on-surface font-medium drop-shadow-sm" :style="{ fontSize: labelFontSize + 'rem' }">{{ title }}</p>
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
    playlistMount: {
      type: Object,
      default: () => null
    },
    isAltViewEnabled: Boolean
  },
  data() {
    return {
      playlist: null,
      isSelectionMode: false
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
      return this.playlist ? this.playlist.name : ''
    },
    items() {
      return this.playlist ? this.playlist.items || [] : []
    },
    store() {
      return this.$store || this.$nuxt.$store
    },
    currentLibraryId() {
      return this.store.state.libraries.currentLibraryId
    }
  },
  methods: {
    setEntity(playlist) {
      this.playlist = playlist
    },
    setSelectionMode(val) {
      this.isSelectionMode = val
    },
    clickCard() {
      if (!this.playlist) return
      var router = this.$router || this.$nuxt.$router
      router.push(`/playlist/${this.playlist.id}`)
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
    if (this.playlistMount) {
      this.setEntity(this.playlistMount)
    }
  }
}
</script>

<style scoped>
/* Material 3 Expressive Playlist Card Styles */
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

/* Force square aspect ratio for playlist covers */
.material-3-card .covers-playlist-cover,
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
