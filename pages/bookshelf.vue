<template>
  <div class="w-full h-full bg-surface-dynamic">
    <home-bookshelf-toolbar v-show="!hideToolbar" />
    <div id="bookshelf-wrapper" class="main-content overflow-y-auto overflow-x-hidden relative bg-surface-dynamic library-scroll-container" :class="hideToolbar ? 'no-toolbar' : ''">
      <div class="bookshelf-child-stage" :class="{ 'is-tab-switch-fading': isTabSwitchFading }">
        <nuxt-child keep-alive :keep-alive-props="bookshelfKeepAliveProps" :nuxt-child-key="getBookshelfChildKey" />
      </div>
    </div>
  </div>
</template>

<script>
const STABLE_TAB_ROUTES = new Set(['bookshelf', 'bookshelf-library', 'bookshelf-series', 'bookshelf-collections-playlists', 'bookshelf-authors', 'bookshelf-latest'])

export default {
  data() {
    return {
      isTabSwitchFading: false,
      tabFadeLeaveTimer: null,
      tabFadeEnterTimer: null
    }
  },
  beforeRouteUpdate(to, from, next) {
    const fromName = from?.name || ''
    const toName = to?.name || ''

    // Only apply fade-through timing for core bookshelf tab-to-tab navigation.
    if (!this.isStableTabRoute(fromName) || !this.isStableTabRoute(toName) || this.prefersReducedMotion()) {
      next()
      return
    }

    if (this.tabFadeLeaveTimer) clearTimeout(this.tabFadeLeaveTimer)
    if (this.tabFadeEnterTimer) clearTimeout(this.tabFadeEnterTimer)

    this.isTabSwitchFading = true
    this.tabFadeLeaveTimer = window.setTimeout(() => {
      next()
      this.tabFadeEnterTimer = window.setTimeout(() => {
        this.isTabSwitchFading = false
      }, 170)
    }, 90)
  },
  beforeDestroy() {
    if (this.tabFadeLeaveTimer) clearTimeout(this.tabFadeLeaveTimer)
    if (this.tabFadeEnterTimer) clearTimeout(this.tabFadeEnterTimer)
  },
  computed: {
    bookshelfKeepAliveProps() {
      return {
        max: 8
      }
    },
    hideToolbar() {
      return this.isHome || this.isLatest || this.isPodcastSearch
    },
    isHome() {
      return this.$route.name === 'bookshelf'
    },
    isLatest() {
      return this.$route.name === 'bookshelf-latest'
    },
    isPodcastSearch() {
      return this.$route.name === 'bookshelf-add-podcast'
    }
  },
  methods: {
    prefersReducedMotion() {
      return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    },
    isStableTabRoute(routeName) {
      return STABLE_TAB_ROUTES.has(routeName)
    },
    getBookshelfChildKey(route) {
      const resolvedRoute = route || this.$route || {}
      const routeName = resolvedRoute.name || ''

      // Keep core bookshelf tabs stable across in-app navigation (including query changes)
      // so switching tabs feels instant and does not replay lazy entrance effects.
      if (this.isStableTabRoute(routeName)) {
        return routeName
      }

      // Dynamic/detail routes (e.g. /bookshelf/series/:id) must be keyed by path,
      // otherwise returning and selecting another entity can reuse stale cached state.
      return resolvedRoute.path || resolvedRoute.fullPath || routeName
    }
  }
}
</script>

<style>
/* Material 3 Expressive Scroll Behavior */
.library-scroll-container {
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}

.main-content {
  height: calc(100% - 48px); /* Subtract toolbar height (48px) - navigation already accounted for in layout */
  max-height: calc(100% - 48px);
  min-height: calc(100% - 48px);
  max-width: 100vw;
  overscroll-behavior-x: none;
  background-color: rgb(var(--md-sys-color-surface));
}
.main-content.no-toolbar {
  height: 100%; /* No additional subtraction when no toolbar - navigation already accounted for in layout */
  max-height: 100%;
  min-height: 100%;
}

.bookshelf-child-stage {
  position: relative;
  width: 100%;
  min-height: 100%;
}

.bookshelf-child-stage::after {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  background-color: rgb(var(--md-sys-color-surface));
}

.bookshelf-child-stage.is-tab-switch-fading::after {
  animation: bookshelf-tab-fade-through-overlay 260ms cubic-bezier(0.2, 0, 0, 1);
}

@keyframes bookshelf-tab-fade-through-overlay {
  0% {
    opacity: 0;
  }
  42% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
</style>
