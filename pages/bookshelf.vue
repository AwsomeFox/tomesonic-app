<template>
  <div class="w-full h-full bg-surface-dynamic">
    <home-bookshelf-nav-bar />
    <home-bookshelf-toolbar v-show="!hideToolbar" />
    <div id="bookshelf-wrapper" class="main-content overflow-y-auto overflow-x-hidden relative bg-surface-dynamic" :class="hideToolbar ? 'no-toolbar' : ''">
      <nuxt-child />
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {}
  },
  computed: {
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
  }
}
</script>

<style>
.main-content {
  height: calc(100% - 48px); /* Subtract toolbar height (48px) - navigation already accounted for in layout */
  max-height: calc(100% - 48px);
  min-height: calc(100% - 48px);
  max-width: 100vw;
  background-color: rgb(var(--md-sys-color-surface));
}
.main-content.no-toolbar {
  height: 100%; /* No additional subtraction when no toolbar - navigation already accounted for in layout */
  max-height: 100%;
  min-height: 100%;
}
</style>
