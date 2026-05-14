<template>
  <div :style="contentPaddingStyle">
    <bookshelf-lazy-bookshelf :key="narratorBooksKey" page="narrator-books" :narrator-name="narratorName" />
  </div>
</template>

<script>
export default {
  name: 'BookshelfNarratorDetailPage',
  data() {
    return {
      narratorName: '',
      narratorRouteKey: ''
    }
  },
  watch: {
    '$route.params.id': {
      handler() {
        this.syncNarratorFromRoute()
      }
    },
    '$route.query.name': {
      handler() {
        this.syncNarratorFromRoute()
      }
    }
  },
  computed: {
    narratorBooksKey() {
      return this.narratorRouteKey || this.narratorName || 'narrator-books'
    },
    contentPaddingStyle() {
      return this.$store.getters['getIsPlayerOpen'] ? { paddingBottom: '120px' } : {}
    }
  },
  methods: {
    syncNarratorFromRoute() {
      const encodedRouteKey = this.$route?.params?.id || ''
      let routeKey = encodedRouteKey
      if (encodedRouteKey) {
        try {
          routeKey = decodeURIComponent(encodedRouteKey)
        } catch (error) {
          routeKey = encodedRouteKey
        }
      }

      let resolvedName = typeof this.$route?.query?.name === 'string' ? this.$route.query.name : ''

      if (!resolvedName && routeKey) {
        try {
          resolvedName = this.$decode(routeKey)
        } catch (error) {
          resolvedName = ''
        }
      }

      this.narratorRouteKey = routeKey
      this.narratorName = resolvedName || ''
    }
  },
  mounted() {
    this.syncNarratorFromRoute()
  },
  activated() {
    this.syncNarratorFromRoute()
  }
}
</script>
