<template>
  <div class="w-full bg-surface-container shadow-elevation-2 relative z-20" :style="{ paddingTop: topPadding, boxSizing: 'border-box' }">
    <div id="appbar" class="w-full flex items-center px-4" style="min-height: 3.5rem">
      <!-- keep ~h-14 / 56px height via min-height -->
      <!-- ─── Search mode ─── -->
      <template v-if="searchActive">
        <ui-icon-btn icon="arrow_back" variant="standard" color="on-surface-variant" size="medium" class="mr-2" @click="closeSearch" />
        <div class="flex-1 flex items-center h-11 px-4 rounded-full bg-surface-container-high border border-outline-variant transition-all duration-200 ease-standard">
          <span class="material-symbols text-on-surface-variant mr-3" style="font-size: 1.25rem">search</span>
          <input ref="searchInput" v-model="searchQuery" type="text" :placeholder="$strings.ButtonSearch" class="flex-1 bg-transparent outline-none text-on-surface text-body-large placeholder:text-on-surface-variant min-w-0" autocomplete="off" autocorrect="off" autocapitalize="none" @input="onSearchInput" @keydown.enter="$refs.searchInput && $refs.searchInput.blur()" />
          <button v-if="searchQuery" class="ml-2 w-8 h-8 rounded-full flex items-center justify-center state-layer" @click="clearSearch">
            <span class="material-symbols text-on-surface-variant" style="font-size: 1.125rem">close</span>
          </button>
        </div>
      </template>

      <!-- ─── Default mode ─── -->
      <template v-else>
        <!-- Menu Button - hidden when back button is shown -->
        <ui-icon-btn v-if="!showBack" icon="menu" variant="standard" color="on-surface-variant" size="medium" class="mr-2" @click="clickShowSideDrawer" />

        <!-- Back Navigation -->
        <ui-icon-btn v-if="showBack" icon="arrow_back" variant="standard" color="on-surface-variant" size="medium" class="mr-2" @click="back" />

        <!-- Library Selector -->
        <div v-if="user && currentLibrary">
          <div class="px-3 py-2 bg-primary-container rounded-full flex items-center cursor-pointer state-layer transition-all duration-200 ease-standard hover:shadow-elevation-1" @click="clickShowLibraryModal">
            <ui-library-icon :icon="currentLibraryIcon" :size="4" font-size="base" color="on-primary-container" />
            <p class="text-body-medium text-on-primary-container ml-2 max-w-24 truncate">{{ currentLibraryName }}</p>
          </div>
        </div>

        <widgets-connection-indicator />

        <div class="flex-grow" />

        <widgets-download-progress-indicator />

        <!-- Inline bookshelf actions (filter / sort / more / download-series) -->
        <home-bookshelf-toolbar v-if="user && isBookshelfRoute" inline class="mr-1" />

        <!-- Search Button (always last / farthest right) -->
        <ui-icon-btn v-if="user" icon="search" variant="standard" color="on-surface-variant" size="medium" class="ml-1" @click="openSearch" />
      </template>
    </div>

    <modals-cast-device-selection-modal ref="castDeviceModal" />
  </div>
</template>

<script>
import { AbsAudioPlayer } from '@/plugins/capacitor'

export default {
  data() {
    return {
      onCastAvailableUpdateListener: null,
      topPadding: '0px',
      _safeAreaObserver: null,
      searchActive: false,
      searchQuery: '',
      _searchDebounce: null
    }
  },
  computed: {
    isCastAvailable: {
      get() {
        return this.$store.state.isCastAvailable
      },
      set(val) {
        this.$store.commit('setCastAvailable', val)
      }
    },
    currentLibrary() {
      return this.$store.getters['libraries/getCurrentLibrary']
    },
    currentLibraryName() {
      return this.currentLibrary?.name || ''
    },
    currentLibraryIcon() {
      return this.currentLibrary?.icon || 'database'
    },
    showBack() {
      if (!this.$route.name) return true

      // Main navigation pages that should show menu button, not back button
      const mainNavRoutes = ['index', 'account', 'stats', 'settings', 'logs', 'connect', 'downloads', 'downloading']

      // Check if current route starts with bookshelf (covers bookshelf and bookshelf-id)
      if (this.$route.name.startsWith('bookshelf')) return false

      // Check if current route starts with localMedia (covers localMedia-folders, etc)
      if (this.$route.name.startsWith('localMedia')) return false

      // Check if it's one of the main nav routes
      if (mainNavRoutes.includes(this.$route.name)) return false

      // All other routes should show back button
      return true
    },
    user() {
      return this.$store.state.user.user
    },
    username() {
      return this.user?.username || 'err'
    },
    isCasting() {
      return this.$store.state.isCasting
    },
    isBookshelfRoute() {
      const name = this.$route.name || ''
      // Show inline bookshelf actions only on routes where the standalone toolbar
      // used to render (everything under /bookshelf except home, latest, podcast-add).
      if (!name.startsWith('bookshelf')) return false
      if (name === 'bookshelf') return false
      if (name === 'bookshelf-latest') return false
      if (name === 'bookshelf-add-podcast') return false
      return true
    }
  },
  methods: {
    castClick() {
      if (this.$store.getters['getIsCurrentSessionLocal']) {
        this.$eventBus.$emit('cast-local-item')
        return
      }
      this.$refs.castDeviceModal.init()
    },
    clickShowSideDrawer() {
      this.$store.commit('setShowSideDrawer', true)
    },
    clickShowLibraryModal() {
      this.$store.commit('libraries/setShowModal', true)
    },
    back() {
      window.history.back()
    },
    onCastAvailableUpdate(data) {
      this.isCastAvailable = data && data.value
    },
    openSearch() {
      this.searchActive = true
      this.searchQuery = this.$store.state.globals.lastSearch || ''
      if (this.$route.name !== 'search') {
        this.$router.push('/search').catch(() => {})
      }
      this.$nextTick(() => {
        if (this.$refs.searchInput) {
          this.$refs.searchInput.focus()
        }
      })
    },
    closeSearch() {
      this.searchActive = false
      if (this.$route.name === 'search') {
        // Prefer history back so we restore prior tab; fall back to bookshelf root.
        if (window.history.length > 1) {
          window.history.back()
        } else {
          this.$router.push('/bookshelf').catch(() => {})
        }
      }
    },
    clearSearch() {
      this.searchQuery = ''
      this.onSearchInput()
      this.$nextTick(() => {
        if (this.$refs.searchInput) this.$refs.searchInput.focus()
      })
    },
    onSearchInput() {
      clearTimeout(this._searchDebounce)
      const value = this.searchQuery
      this._searchDebounce = setTimeout(() => {
        this.$eventBus.$emit('appbar-search', value)
      }, 300)
    }
  },
  watch: {
    '$route.name'(newName) {
      // Auto-open inline search when route becomes /search (e.g. via deep link / drawer).
      if (newName === 'search' && !this.searchActive) {
        this.searchActive = true
        this.searchQuery = this.$store.state.globals.lastSearch || ''
        this.$nextTick(() => {
          if (this.$refs.searchInput) this.$refs.searchInput.focus()
        })
      }
      // Auto-close inline search when navigating away from the search page.
      if (this.searchActive && newName !== 'search') {
        this.searchActive = false
      }
    }
  },
  async mounted() {
    AbsAudioPlayer.getIsCastAvailable().then((data) => {
      this.isCastAvailable = data && data.value
    })
    this.onCastAvailableUpdateListener = await AbsAudioPlayer.addListener('onCastAvailableUpdate', this.onCastAvailableUpdate)
    // If the app boots directly into /search, auto-enter search mode.
    if (this.$route.name === 'search') {
      this.searchActive = true
      this.searchQuery = this.$store.state.globals.lastSearch || ''
      this.$nextTick(() => {
        if (this.$refs.searchInput) this.$refs.searchInput.focus()
      })
    }
    // Compute top padding from CSS variable (injected by Android MainActivity) and cap it.
    const updateTopPadding = () => {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top') || ''
        const px = parseFloat(raw.replace('px', '')) || 0
        const cap = Math.min(Math.max(px, 0), 64) // cap at 64px to avoid excessive spacing

        // Only update if we got a meaningful value or if we don't have any value yet
        if (cap > 0 || !this.topPadding || this.topPadding === '0px') {
          this.topPadding = `${cap}px`
        }
      } catch (e) {
        // Set a reasonable fallback for Android devices if no value is available
        if (!this.topPadding || this.topPadding === '0px') {
          // Use device pixel ratio to estimate status bar height
          const fallback = window.devicePixelRatio > 1 ? 28 : 24
          this.topPadding = `${fallback}px`
        }
      }
    }

    // Run immediately and when the safe-area-ready attribute toggles
    updateTopPadding()

    // Observe attribute set by plugin to know when CSS vars are injected
    this._safeAreaObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'data-safe-area-ready') {
          updateTopPadding()
        }
      }
    })
    this._safeAreaObserver.observe(document.documentElement, { attributes: true })

    // Also periodically check for changes in the first few seconds after mount
    // This helps catch cases where the native code sets variables after component mount
    let checkCount = 0
    const periodicCheck = () => {
      if (checkCount < 60) {
        // Extended check for 6 seconds (60 * 100ms) to account for slower WebView init
        updateTopPadding()
        checkCount++
        setTimeout(periodicCheck, 100)
      }
    }
    periodicCheck()

    window.addEventListener('resize', updateTopPadding)
  },
  beforeDestroy() {
    this.onCastAvailableUpdateListener?.remove()
    if (this._safeAreaObserver) this._safeAreaObserver.disconnect()
    window.removeEventListener('resize', () => {})
  }
}
</script>

<style scoped>
/* Material 3 Appbar Styles */
#appbar {
  /* Use a downward-only shadow to separate the appbar from content below.
     This avoids a visible shadow between the system status bar and the appbar
     while keeping a Material-like elevation to the content. */
  box-shadow: 0 6px 14px rgba(var(--md-sys-color-on-surface), 0.08);
}

/* Library selector hover effect */
.library-selector:hover {
  background-color: rgba(var(--md-sys-color-on-surface), var(--md-sys-state-hover-opacity));
}

/* Search button hover effect */
.state-layer {
  position: relative;
}

.state-layer::before {
  content: '';
  position: absolute;
  border-radius: inherit;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: transparent;
  transition: background-color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
  pointer-events: none;
}

.state-layer:hover::before {
  background-color: rgba(var(--md-sys-color-on-surface-variant), var(--md-sys-state-hover-opacity));
}

.state-layer:focus::before {
  background-color: rgba(var(--md-sys-color-on-surface-variant), var(--md-sys-state-focus-opacity));
}

.state-layer:active::before {
  background-color: rgba(var(--md-sys-color-on-surface-variant), var(--md-sys-state-pressed-opacity));
}

/* Custom animation keyframes remain the same */
.loader-dots div {
  animation-timing-function: cubic-bezier(0, 1, 1, 0);
}
.loader-dots div:nth-child(1) {
  left: 0px;
  animation: loader-dots1 0.6s infinite;
}
.loader-dots div:nth-child(2) {
  left: 0px;
  animation: loader-dots2 0.6s infinite;
}
.loader-dots div:nth-child(3) {
  left: 10px;
  animation: loader-dots2 0.6s infinite;
}
.loader-dots div:nth-child(4) {
  left: 20px;
  animation: loader-dots3 0.6s infinite;
}
@keyframes loader-dots1 {
  0% {
    transform: scale(0);
  }
  100% {
    transform: scale(1);
  }
}
@keyframes loader-dots3 {
  0% {
    transform: scale(1);
  }
  100% {
    transform: scale(0);
  }
}
@keyframes loader-dots2 {
  0% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(10px);
  }
}
</style>
