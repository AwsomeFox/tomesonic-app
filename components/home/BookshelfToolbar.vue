<template>
  <component :is="inline ? 'div' : 'div'" :class="inline ? 'inline-flex items-center' : 'w-full h-12 bg-surface-container relative z-20 shadow-elevation-1'">
    <div :id="inline ? null : 'bookshelf-toolbar'" :class="inline ? 'flex items-center' : 'absolute top-0 left-0 w-full h-full z-20 flex items-center px-4'">
      <div class="flex items-center" :class="inline ? '' : 'w-full'">
        <template v-if="!inline">
          <p v-show="!selectedSeriesName" class="text-body-medium text-on-surface">{{ $formatNumber(totalEntities) }} {{ entityTitle }}</p>
          <p v-show="selectedSeriesName" class="text-body-medium text-on-surface">{{ selectedSeriesName }} ({{ $formatNumber(totalEntities) }})</p>
          <div class="flex-grow" />
        </template>

        <!-- Collections / Playlists segmented control -->
        <div v-if="page === 'collections-playlists'" class="m3-segmented" :class="inline ? 'mx-1' : 'mx-2'">
          <button class="m3-segmented-btn" :class="{ 'is-active': collectionsPlaylistsView === 'collections' }" @click="setCollectionsPlaylistsView('collections')">
            <span class="material-symbols m3-segmented-icon">{{ collectionsPlaylistsView === 'collections' ? 'check' : 'collections_bookmark' }}</span>
            <span>{{ $strings.ButtonCollections }}</span>
          </button>
          <button class="m3-segmented-btn" :class="{ 'is-active': collectionsPlaylistsView === 'playlists' }" @click="setCollectionsPlaylistsView('playlists')">
            <span class="material-symbols m3-segmented-icon">{{ collectionsPlaylistsView === 'playlists' ? 'check' : 'queue_music' }}</span>
            <span>{{ $strings.ButtonPlaylists }}</span>
          </button>
        </div>

        <!-- Filter Button -->
        <div v-if="page === 'library'" class="relative" :class="inline ? 'mx-0.5' : 'mx-1'">
          <ui-icon-btn icon="tune" variant="standard" size="medium" @click="showFilterModal = true" />
          <div v-show="hasFilters" class="absolute top-0 -right-1 w-3 h-3 rounded-full bg-tertiary shadow-elevation-1 z-10 pointer-events-none" />
        </div>

        <!-- Sort Button -->
        <ui-icon-btn v-if="page === 'library'" icon="swap_vert" variant="standard" size="medium" :class="inline ? 'mx-0.5' : 'mx-1'" @click="showSortModal = true" />
        <ui-icon-btn v-else-if="page === 'series' && !seriesBookPage" icon="swap_vert" variant="standard" size="medium" :class="inline ? 'mx-0.5' : 'mx-1'" @click="showSeriesSortModal = true" />
        <ui-icon-btn v-else-if="page === 'authors'" icon="swap_vert" variant="standard" size="medium" :class="inline ? 'mx-0.5' : 'mx-1'" @click="showAuthorsSortModal = true" />

        <!-- Download Series Button -->
        <ui-icon-btn v-if="seriesBookPage" icon="download" variant="standard" size="medium" :class="inline ? 'mx-0.5' : 'mx-1'" @click="downloadSeries" />
      </div>
    </div>

    <modals-order-modal v-model="showSortModal" :order-by.sync="settings.mobileOrderBy" :descending.sync="settings.mobileOrderDesc" @change="updateOrder" />
    <modals-order-modal v-model="showSeriesSortModal" :order-by="seriesOrderBy" :descending="seriesOrderDesc" :custom-items="seriesSortItems" @update:orderBy="updateSeriesOrderBy" @update:descending="updateSeriesOrderDesc" @change="emitSeriesOrderChange" />
    <modals-order-modal v-model="showAuthorsSortModal" :order-by="authorsOrderBy" :descending="authorsOrderDesc" :custom-items="authorsSortItems" @update:orderBy="updateAuthorsOrderBy" @update:descending="updateAuthorsOrderDesc" @change="emitAuthorsOrderChange" />
    <modals-filter-modal v-model="showFilterModal" :filter-by.sync="settings.mobileFilterBy" @change="updateFilter" />
  </component>
</template>

<script>
export default {
  props: {
    inline: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      showSortModal: false,
      showSeriesSortModal: false,
      showAuthorsSortModal: false,
      showFilterModal: false,
      settings: {},
      totalEntities: 0,
      showMoreMenuDialog: false
    }
  },
  computed: {
    seriesOrderBy() {
      return this.$store.state.globals.seriesOrderBy || 'name'
    },
    seriesOrderDesc() {
      return !!this.$store.state.globals.seriesOrderDesc
    },
    authorsOrderBy() {
      return this.$store.state.globals.authorsOrderBy || 'name'
    },
    authorsOrderDesc() {
      return !!this.$store.state.globals.authorsOrderDesc
    },
    collectionsPlaylistsView() {
      return this.$store.state.globals.collectionsPlaylistsView || 'collections'
    },
    seriesSortItems() {
      return [
        { text: this.$strings.LabelName || 'Name', value: 'name' },
        { text: this.$strings.LabelAddedAt || 'Added', value: 'addedAt' },
        { text: this.$strings.LabelLastBookAdded || 'Last book added', value: 'lastBookAdded' },
        { text: this.$strings.LabelTotalDuration || 'Total duration', value: 'totalDuration' }
      ]
    },
    authorsSortItems() {
      return [
        { text: this.$strings.LabelName || 'Name', value: 'name' },
        { text: this.$strings.LabelLastFirst || 'Last, First', value: 'lastFirst' },
        { text: this.$strings.LabelNumberOfBooks || '# Books', value: 'numBooks' },
        { text: this.$strings.LabelAddedAt || 'Added', value: 'addedAt' }
      ]
    },
    bookshelfListView: {
      get() {
        return this.$store.state.globals.bookshelfListView
      },
      set(val) {
        this.$localStore.setBookshelfListView(val)
        this.$store.commit('globals/setBookshelfListView', val)
      }
    },
    currentLibraryMediaType() {
      return this.$store.getters['libraries/getCurrentLibraryMediaType']
    },
    isBookLibrary() {
      return this.currentLibraryMediaType === 'book'
    },
    hasFilters() {
      return this.$store.getters['user/getUserSetting']('mobileFilterBy') !== 'all'
    },
    page() {
      const routeName = this.$route.name || ''
      // Strip the leading 'bookshelf-' prefix to derive the page identifier.
      // Use split('-').slice(1).join('-') so multi-segment names like
      // 'bookshelf-collections-playlists' resolve to 'collections-playlists'.
      return routeName.split('-').slice(1).join('-')
    },
    seriesBookPage() {
      return this.$route.name == 'bookshelf-series-id'
    },
    routeQuery() {
      return this.$route.query || {}
    },
    entityTitle() {
      if (this.page === 'library') {
        return this.isPodcast ? this.$strings.LabelPodcasts : this.$strings.LabelBooks
      } else if (this.page === 'playlists') {
        return this.$strings.ButtonPlaylists
      } else if (this.page === 'series') {
        return this.$strings.LabelSeries
      } else if (this.page === 'author') {
        return this.$strings.LabelAuthors
      } else if (this.page === 'narrator') {
        return this.$strings.LabelNarrators
      } else if (this.page === 'collections') {
        return this.$strings.ButtonCollections
      } else if (this.page === 'collections-playlists') {
        return this.$strings.ButtonCollections + ' & ' + this.$strings.ButtonPlaylists
      } else if (this.page === 'authors') {
        return this.$strings.LabelAuthors
      }
      return ''
    },
    selectedSeriesName() {
      if (this.page === 'series' && this.$route.params.id && this.$store.state.globals.series) {
        return this.$store.state.globals.series.name
      }
      if (this.page === 'author' && this.$route.params.id && this.$route.query?.name) {
        return this.$route.query.name
      }
      if (this.page === 'narrator' && this.$route.params.id) {
        if (this.$route.query?.name) return this.$route.query.name
        try {
          return this.$decode(this.$route.params.id)
        } catch (error) {
          return null
        }
      }
      return null
    },
    isPodcast() {
      return this.$store.getters['libraries/getCurrentLibraryMediaType'] === 'podcast'
    }
  },
  methods: {
    setCollectionsPlaylistsView(view) {
      this.$store.commit('globals/setCollectionsPlaylistsView', view)
      this.$eventBus.$emit('collections-playlists-view-change', view)
    },
    updateSeriesOrderBy(val) {
      this.$store.commit('globals/setSeriesOrderBy', val)
    },
    updateSeriesOrderDesc(val) {
      this.$store.commit('globals/setSeriesOrderDesc', val)
    },
    emitSeriesOrderChange() {
      this.$eventBus.$emit('series-order-change')
    },
    updateAuthorsOrderBy(val) {
      this.$store.commit('globals/setAuthorsOrderBy', val)
    },
    updateAuthorsOrderDesc(val) {
      this.$store.commit('globals/setAuthorsOrderDesc', val)
    },
    emitAuthorsOrderChange() {
      this.$eventBus.$emit('authors-order-change')
    },
    clickMenuAction(action) {
      this.showMoreMenuDialog = false
    },
    updateOrder() {
      this.saveSettings()
    },
    updateFilter() {
      this.saveSettings()
    },
    saveSettings() {
      this.$store.dispatch('user/updateUserSettings', this.settings)
    },
    async init() {
      this.bookshelfListView = await this.$localStore.getBookshelfListView()
      this.settings = { ...this.$store.state.user.settings }
      this.bookshelfReady = true
    },
    settingsUpdated(settings) {
      for (const key in settings) {
        this.settings[key] = settings[key]
      }
    },
    setTotalEntities(total) {
      this.totalEntities = total
    },
    async changeView() {
      this.bookshelfListView = !this.bookshelfListView
      await this.$hapticsImpact()
    },
    downloadSeries() {
      console.log('Download Series click')
      this.$eventBus.$emit('download-series-click')
    }
  },
  mounted() {
    this.init()
    this.$eventBus.$on('bookshelf-total-entities', this.setTotalEntities)
    this.$eventBus.$on('user-settings', this.settingsUpdated)
  },
  beforeDestroy() {
    this.$eventBus.$off('bookshelf-total-entities', this.setTotalEntities)
    this.$eventBus.$off('user-settings', this.settingsUpdated)
  }
}
</script>

<style scoped>
/* Material 3 Toolbar Styles */
#bookshelf-toolbar {
  box-shadow: var(--md-sys-elevation-level1);
}

/* M3 Expressive segmented control */
.m3-segmented {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid rgb(var(--md-sys-color-outline));
  border-radius: 9999px;
  overflow: hidden;
  background-color: transparent;
  height: 36px;
}

.m3-segmented-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 12px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: rgb(var(--md-sys-color-on-surface));
  background: transparent;
  transition: background-color 150ms ease, color 150ms ease;
  min-width: 84px;
}

.m3-segmented-btn + .m3-segmented-btn {
  border-left: 1px solid rgb(var(--md-sys-color-outline));
}

.m3-segmented-btn.is-active {
  background-color: rgb(var(--md-sys-color-secondary-container));
  color: rgb(var(--md-sys-color-on-secondary-container));
}

.m3-segmented-btn:active {
  background-color: rgb(var(--md-sys-color-on-surface) / 0.08);
}

.m3-segmented-icon {
  font-size: 18px;
  line-height: 1;
}
</style>
