<template>
  <div class="w-full h-full flex flex-col">
    <!-- Tab switcher -->
    <div class="flex items-center justify-center px-4 pt-4 pb-2">
      <div class="bg-surface-container rounded-full p-1 flex items-center shadow-elevation-1">
        <button class="px-4 py-2 rounded-full text-label-medium font-medium transition-all duration-200 ease-expressive min-w-24" :class="currentView === 'collections' ? 'bg-primary text-on-primary shadow-elevation-2' : 'text-on-surface-variant hover:bg-on-surface/8'" @click="selectView('collections')">
          {{ $strings.ButtonCollections }}
        </button>
        <button class="px-4 py-2 rounded-full text-label-medium font-medium transition-all duration-200 ease-expressive min-w-24" :class="currentView === 'playlists' ? 'bg-primary text-on-primary shadow-elevation-2' : 'text-on-surface-variant hover:bg-on-surface/8'" @click="selectView('playlists')">
          {{ $strings.ButtonPlaylists }}
        </button>
      </div>
    </div>

    <!-- Content area -->
    <div class="flex-grow collections-content-stage" :style="contentPaddingStyle">
      <transition :name="collectionsSwitchTransitionName" mode="out-in">
        <keep-alive>
          <bookshelf-lazy-bookshelf :key="currentView" :page="currentView" />
        </keep-alive>
      </transition>
    </div>
  </div>
</template>

<script>
export default {
  name: 'BookshelfCollectionsPlaylistsPage',
  data() {
    return {
      currentView: 'collections',
      collectionsLoaded: false,
      hasCollections: false,
      listenersInitialized: false
    }
  },
  computed: {
    userHasPlaylists() {
      return this.$store.state.libraries.numUserPlaylists
    },
    collectionsSwitchTransitionName() {
      if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return 'm3-reduced'
      }
      return 'm3-top-level'
    },
    contentPaddingStyle() {
      return this.$store.getters['getIsPlayerOpen'] ? { paddingBottom: '120px' } : {}
    }
  },
  mounted() {
    this.initListeners()

    // Check if we should default to playlists view based on route query or user preference
    if (this.$route.query.view === 'playlists' && this.userHasPlaylists) {
      this.currentView = 'playlists'
    } else if (!this.userHasPlaylists) {
      // If user has no playlists, stay on collections
      this.currentView = 'collections'
    }
    // Otherwise default to collections
  },
  activated() {
    this.initListeners()
  },
  deactivated() {
    this.removeListeners()
  },
  beforeDestroy() {
    this.removeListeners()
  },
  methods: {
    initListeners() {
      if (this.listenersInitialized) return
      this.$eventBus.$on('bookshelf-total-entities', this.onEntityCountUpdated)
      this.listenersInitialized = true
    },
    removeListeners() {
      if (!this.listenersInitialized) return
      this.$eventBus.$off('bookshelf-total-entities', this.onEntityCountUpdated)
      this.listenersInitialized = false
    },
    selectView(view) {
      this.currentView = view
    },
    onEntityCountUpdated(totalEntities) {
      // Only run the auto-switch logic once on initial collections load.
      if (this.currentView !== 'collections') return

      const isInitialCollectionsLoad = !this.collectionsLoaded
      this.collectionsLoaded = true
      this.hasCollections = totalEntities > 0

      if (isInitialCollectionsLoad && !this.hasCollections && this.userHasPlaylists) {
        this.currentView = 'playlists'
      }
    }
  },
  watch: {
    // Update URL query when view changes
    currentView(newView) {
      if (this.$route.query.view !== newView) {
        this.$router.replace({
          path: this.$route.path,
          query: { ...this.$route.query, view: newView }
        })
      }
    }
  }
}
</script>

<style scoped>
.collections-content-stage {
  position: relative;
  min-height: 100%;
}
</style>
