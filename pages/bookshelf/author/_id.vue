<template>
  <div :style="contentPaddingStyle">
    <bookshelf-lazy-bookshelf :key="authorBooksKey" page="author-books" :author-id="authorId" />
  </div>
</template>

<script>
export default {
  name: 'BookshelfAuthorDetailPage',
  data() {
    return {
      authorId: ''
    }
  },
  watch: {
    '$route.params.id': {
      handler() {
        this.syncAuthorFromRoute()
      }
    }
  },
  computed: {
    authorBooksKey() {
      return this.authorId || this.$route?.params?.id || 'author-books'
    },
    contentPaddingStyle() {
      return this.$store.getters['getIsPlayerOpen'] ? { paddingBottom: '120px' } : {}
    }
  },
  methods: {
    syncAuthorFromRoute() {
      const encodedRouteAuthorId = this.$route?.params?.id
      if (!encodedRouteAuthorId) return

      let routeAuthorId = encodedRouteAuthorId
      try {
        routeAuthorId = decodeURIComponent(encodedRouteAuthorId)
      } catch (error) {
        routeAuthorId = encodedRouteAuthorId
      }

      this.authorId = routeAuthorId
    }
  },
  mounted() {
    this.syncAuthorFromRoute()
  },
  activated() {
    this.syncAuthorFromRoute()
  }
}
</script>
