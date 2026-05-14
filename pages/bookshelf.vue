<template>
  <div class="w-full h-full bg-surface-dynamic">
    <home-bookshelf-toolbar v-show="!hideToolbar" />
    <div id="bookshelf-wrapper" class="main-content overflow-y-auto overflow-x-hidden relative bg-surface-dynamic library-scroll-container" :class="hideToolbar ? 'no-toolbar' : ''">
      <div class="bookshelf-child-stage" :class="tabStageClass">
        <keep-alive :max="32">
          <nuxt-child :key="bookshelfChildViewKey" :nuxt-child-key="getBookshelfChildKey" />
        </keep-alive>
      </div>
    </div>
  </div>
</template>

<script>
const STABLE_TAB_ROUTES = new Set(['bookshelf', 'bookshelf-library', 'bookshelf-series', 'bookshelf-collections-playlists', 'bookshelf-authors', 'bookshelf-latest'])

// Detail routes inside the bookshelf shell that should animate hierarchically
// (slide+scale forward going in, reverse going back) instead of as a flat fade.
const BOOKSHELF_DETAIL_ROUTES = new Set(['bookshelf-series-id', 'bookshelf-author-id', 'bookshelf-narrator-id', 'bookshelf-add-podcast'])

export default {
  beforeRouteUpdate(to, from, next) {
    const fromIsTab = STABLE_TAB_ROUTES.has(from.name)
    const toIsTab = STABLE_TAB_ROUTES.has(to.name)
    const fromIsDetail = BOOKSHELF_DETAIL_ROUTES.has(from.name)
    const toIsDetail = BOOKSHELF_DETAIL_ROUTES.has(to.name)

    let kind = null
    if (fromIsTab && toIsTab) {
      kind = 'fade' // top-level destination switch
    } else if ((fromIsTab && toIsDetail) || (fromIsDetail && toIsDetail && from.name !== to.name)) {
      kind = 'forward' // drilling into / sideways between details
    } else if (fromIsDetail && toIsTab) {
      kind = 'back' // returning from detail to a tab
    } else if (fromIsDetail && toIsDetail && from.name === to.name) {
      kind = 'forward' // navigating between two detail items of the same type
    }

    if (!kind) {
      next()
      return
    }

    // Cancel any in-flight animation and flush pending navigation
    this._cancelTabTimers()
    if (this._pendingTabNext) {
      this._pendingTabNext()
      this._pendingTabNext = null
    }

    this._pendingTabNext = next

    const exitClass = kind === 'fade' ? 'tab-leaving' : kind === 'forward' ? 'tab-leaving-forward' : 'tab-leaving-back'
    const enterClass = kind === 'fade' ? 'tab-entering' : kind === 'forward' ? 'tab-entering-forward' : 'tab-entering-back'
    const exitMs = kind === 'fade' ? 120 : 200
    const enterMs = kind === 'fade' ? 260 : 320
    const settleMs = kind === 'fade' ? 60 : 30

    // Phase 1: exit
    this.tabStageClass = exitClass

    this._tabExitTimer = setTimeout(() => {
      // Hold stage hidden during swap so the new content never flashes opaque
      this.tabStageClass = 'tab-hidden'
      if (this._pendingTabNext) {
        this._pendingTabNext()
        this._pendingTabNext = null
      }

      // Two RAFs + short settle so cached images decode before the enter animation
      this._tabRaf1 = requestAnimationFrame(() => {
        this._tabRaf2 = requestAnimationFrame(() => {
          this._tabSettleTimer = setTimeout(() => {
            this.tabStageClass = enterClass
            this._tabEnterTimer = setTimeout(() => {
              this.tabStageClass = ''
            }, enterMs)
          }, settleMs)
        })
      })
    }, exitMs)
  },

  beforeDestroy() {
    this._cancelTabTimers()
    if (this._pendingTabNext) {
      this._pendingTabNext()
      this._pendingTabNext = null
    }
  },

  data() {
    return {
      tabStageClass: ''
    }
  },

  computed: {
    bookshelfChildViewKey() {
      return this.getBookshelfChildKey(this.$route)
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
    _cancelTabTimers() {
      clearTimeout(this._tabExitTimer)
      clearTimeout(this._tabEnterTimer)
      clearTimeout(this._tabSettleTimer)
      if (this._tabRaf1) cancelAnimationFrame(this._tabRaf1)
      if (this._tabRaf2) cancelAnimationFrame(this._tabRaf2)
      this._tabExitTimer = null
      this._tabEnterTimer = null
      this._tabSettleTimer = null
      this._tabRaf1 = null
      this._tabRaf2 = null
    },
    isStableTabRoute(routeName) {
      return STABLE_TAB_ROUTES.has(routeName)
    },
    getBookshelfChildKey(route) {
      const resolvedRoute = route || this.$route || {}
      const routeName = resolvedRoute.name || ''

      if (this.isStableTabRoute(routeName)) {
        return routeName
      }

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

/* Tab switch: fade-through with a held "hidden" state during keep-alive swap
   so cached images can decode before fading in (prevents pop-in jank). */
.tab-leaving {
  animation: tabFadeOut 120ms cubic-bezier(0.4, 0, 1, 1) both;
  pointer-events: none;
}
.tab-hidden {
  opacity: 0;
  pointer-events: none;
}
.tab-entering {
  animation: tabFadeIn 260ms cubic-bezier(0.2, 0, 0, 1) both;
}
@keyframes tabFadeOut {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@keyframes tabFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* Hierarchical (tab <-> detail) — matches the m3-forward / m3-back motion
   used by the root book-details transition. */
.tab-leaving-forward {
  animation: tabForwardOut 200ms cubic-bezier(0.4, 0, 1, 1) both;
  pointer-events: none;
}
.tab-entering-forward {
  animation: tabForwardIn 320ms cubic-bezier(0.2, 0, 0, 1) both;
}
.tab-leaving-back {
  animation: tabBackOut 200ms cubic-bezier(0.4, 0, 1, 1) both;
  pointer-events: none;
}
.tab-entering-back {
  animation: tabBackIn 320ms cubic-bezier(0.2, 0, 0, 1) both;
}

@keyframes tabForwardOut {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(-6px) scale(0.995);
  }
}
@keyframes tabForwardIn {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@keyframes tabBackOut {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(14px) scale(0.985);
  }
}
@keyframes tabBackIn {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.995);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.tab-leaving-forward,
.tab-entering-forward,
.tab-leaving-back,
.tab-entering-back {
  will-change: transform, opacity;
}

@media (prefers-reduced-motion: reduce) {
  .tab-leaving-forward,
  .tab-leaving-back {
    animation: tabFadeOut 120ms linear both;
  }
  .tab-entering-forward,
  .tab-entering-back {
    animation: tabFadeIn 120ms linear both;
  }
}
</style>
