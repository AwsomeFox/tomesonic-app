<template>
  <div class="search-card-shell">
    <div class="search-card-thumb">
      <covers-book-cover :library-item="libraryItem" :width="coverWidth" :book-cover-aspect-ratio="bookCoverAspectRatio" />
    </div>
    <div class="search-card-content audiobookSearchCardContent">
      <p v-if="matchKey !== 'title'" class="truncate text-base text-on-surface font-medium search-primary">{{ title }}</p>
      <p v-else class="truncate text-base text-on-surface font-medium search-primary" v-html="matchHtml" />

      <p v-if="matchKey === 'subtitle'" class="truncate text-sm text-on-surface-variant search-secondary">{{ matchHtml }}</p>

      <p v-if="matchKey !== 'authors'" class="text-sm text-on-surface-variant truncate search-secondary">by {{ authorName }}</p>
      <p v-else class="truncate text-sm text-on-surface-variant search-secondary" v-html="matchHtml" />

      <div v-if="matchKey === 'series' || matchKey === 'tags' || matchKey === 'isbn' || matchKey === 'asin' || matchKey === 'episode' || matchKey === 'narrators'" class="m-0 p-0 truncate text-sm text-on-surface-variant search-secondary" v-html="matchHtml" />
    </div>
  </div>
</template>

<script>
export default {
  props: {
    libraryItem: {
      type: Object,
      default: () => {}
    },
    search: String,
    matchKey: String,
    matchText: String
  },
  data() {
    return {}
  },
  computed: {
    bookCoverAspectRatio() {
      return this.$store.getters['libraries/getBookCoverAspectRatio']
    },
    coverWidth() {
      if (this.bookCoverAspectRatio === 1) return 50 * 1.2
      return 50
    },
    media() {
      return this.libraryItem ? this.libraryItem.media || {} : {}
    },
    mediaMetadata() {
      return this.media.metadata || {}
    },
    mediaType() {
      return this.libraryItem ? this.libraryItem.mediaType : null
    },
    isPodcast() {
      return this.mediaType === 'podcast'
    },
    title() {
      return this.mediaMetadata.title || 'No Title'
    },
    subtitle() {
      return this.mediaMetadata.subtitle
    },
    authorName() {
      if (this.isPodcast) return this.mediaMetadata.author
      return this.mediaMetadata.authorName
    },
    matchHtml() {
      if (!this.matchText || !this.search) return ''
      if (this.matchKey === 'subtitle') return ''
      var matchSplit = this.matchText.toLowerCase().split(this.search.toLowerCase().trim())
      if (matchSplit.length < 2) return ''

      var html = ''
      var totalLenSoFar = 0
      for (let i = 0; i < matchSplit.length - 1; i++) {
        var indexOf = matchSplit[i].length
        var firstPart = this.matchText.substr(totalLenSoFar, indexOf)
        var actualWasThere = this.matchText.substr(totalLenSoFar + indexOf, this.search.length)
        totalLenSoFar += indexOf + this.search.length

        html += `${firstPart}<strong class="text-warning">${actualWasThere}</strong>`
      }
      var lastPart = this.matchText.substr(totalLenSoFar)
      html += lastPart

      if (this.matchKey === 'episode') return `<p class="truncate">Episode: ${html}</p>`
      if (this.matchKey === 'tags') return `<p class="truncate">Tags: ${html}</p>`
      if (this.matchKey === 'subtitle') return `<p class="truncate">${html}</p>`
      if (this.matchKey === 'authors') return `by ${html}`
      if (this.matchKey === 'isbn') return `<p class="truncate">ISBN: ${html}</p>`
      if (this.matchKey === 'asin') return `<p class="truncate">ASIN: ${html}</p>`
      if (this.matchKey === 'series') return `<p class="truncate">Series: ${html}</p>`
      if (this.matchKey === 'narrators') return `<p class="truncate">Narrator: ${html}</p>`
      return `${html}`
    }
  },
  methods: {},
  mounted() {}
}
</script>

<style scoped>
.search-card-shell {
  position: relative;
  isolation: isolate;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  overflow: hidden;
  border-radius: 16px;
  background: rgb(var(--md-sys-color-surface-container));
  border: 1px solid rgba(var(--md-sys-color-outline-variant), 0.35);
  box-shadow: var(--md-sys-elevation-level1);
}

.search-card-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: inherit;
  background: linear-gradient(120deg, rgba(var(--md-sys-color-surface-container), 0.72), rgba(var(--md-sys-color-surface-container-high), 0.64));
  backdrop-filter: blur(8px) brightness(0.98) saturate(0.92);
  -webkit-backdrop-filter: blur(8px) brightness(0.98) saturate(0.92);
}

.search-card-shell > * {
  position: relative;
  z-index: 1;
}

.search-card-thumb {
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 10px;
}

.search-card-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.audiobookSearchCardContent {
  min-width: 0;
}

.search-primary {
  color: rgb(var(--md-sys-color-on-media)) !important;
  display: block;
  max-width: 100%;
  padding-left: 14px;
  padding-right: 14px;
  margin-left: -11px;
  margin-right: -11px;
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.96)) drop-shadow(0 0 5px rgba(0, 0, 0, 0.84)) drop-shadow(0 0 9px rgba(0, 0, 0, 0.72));
}

.search-secondary {
  color: rgb(var(--md-sys-color-on-media-variant)) !important;
  display: block;
  max-width: 100%;
  padding-left: 14px;
  padding-right: 14px;
  margin-left: -11px;
  margin-right: -11px;
  font-weight: 500;
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.92)) drop-shadow(0 0 4px rgba(0, 0, 0, 0.8)) drop-shadow(0 0 7px rgba(0, 0, 0, 0.68));
}
</style>
