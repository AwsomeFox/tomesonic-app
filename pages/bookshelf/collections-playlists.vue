<template>
  <div class="w-full h-full flex flex-col">
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
      collectionsLoaded: false,
      hasCollections: false,
      listenersInitialized: false
    }
  },
  computed: {
    currentView: {
      get() {
        return this.$store.state.globals.collectionsPlaylistsView || 'collections'
      },
      set(val) {
        this.$store.commit('globals/setCollectionsPlaylistsView', val)
      }
    },
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

    if (this.$route.query.view === 'playlists' && this.userHasPlaylists) {
      this.currentView = 'playlists'
    } else if (!this.userHasPlaylists) {
      this.currentView = 'collections'
    }
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
    onEntityCountUpdated(totalEntities) {
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
