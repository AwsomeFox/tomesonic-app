<template>
  <div class="w-full h-full overflow-y-auto">
    <div id="bookshelf" class="w-full p-4 library-scroll-container" :style="contentPaddingStyle">
      <div class="flex flex-wrap justify-center">
        <template v-for="author in authors">
          <cards-author-card :key="author.id" :author="author" :width="cardWidth" :height="cardHeight" class="p-2" />
        </template>
      </div>
    </div>
  </div>
</template>

<script>
import { getAudioPeopleStatsForLibrary } from '@/plugins/audioFiltering'

export default {
  name: 'BookshelfAuthorsPage',
  data() {
    return {
      loading: true,
      authors: [],
      loadedLibraryId: null,
      cardWidth: 200,
      listenersInitialized: false
    }
  },
  watch: {
    hideNonAudiobooks() {
      this.init()
    }
  },
  computed: {
    currentLibraryId() {
      return this.$store.state.libraries.currentLibraryId
    },
    hideNonAudiobooks() {
      return this.$store.getters['getHideNonAudiobooksGlobal']
    },
    cardHeight() {
      return this.cardWidth * 1.25
    },
    contentPaddingStyle() {
      return this.$store.getters['getIsPlayerOpen'] ? { paddingBottom: '120px' } : {}
    }
  },
  methods: {
    getAuthorAudioCount(authorEntity, peopleStats) {
      const authorId = authorEntity?.id
      if (authorId && Object.prototype.hasOwnProperty.call(peopleStats.authorAudioCountsById || {}, authorId)) {
        return Number(peopleStats.authorAudioCountsById[authorId] || 0)
      }

      const normalizedName = `${authorEntity?.name || ''}`.trim().toLowerCase().replace(/\s+/g, ' ')
      if (normalizedName && Object.prototype.hasOwnProperty.call(peopleStats.authorAudioCountsByName || {}, normalizedName)) {
        return Number(peopleStats.authorAudioCountsByName[normalizedName] || 0)
      }

      return 0
    },
    async init() {
      this.cardWidth = (window.innerWidth - 64) / 2
      if (!this.currentLibraryId) {
        return
      }
      this.loadedLibraryId = this.currentLibraryId
      let authors = await this.$nativeHttp
        .get(`/api/libraries/${this.currentLibraryId}/authors`)
        .then((response) => response.authors)
        .catch((error) => {
          console.error('Failed to load authors', error)
          return []
        })

      if (this.hideNonAudiobooks) {
        const peopleStats = await getAudioPeopleStatsForLibrary({
          libraryId: this.currentLibraryId,
          nativeHttp: this.$nativeHttp,
          encode: this.$encode,
          includeEbookOnly: true
        })

        authors = (Array.isArray(authors) ? authors : [])
          .map((authorEntity) => {
            const numBooks = this.getAuthorAudioCount(authorEntity, peopleStats)
            return {
              ...authorEntity,
              numBooks
            }
          })
          .filter((authorEntity) => Number(authorEntity?.numBooks || 0) > 0)
      }

      this.authors = Array.isArray(authors) ? authors : []
      console.log('Loaded authors', this.authors)
      this.$eventBus.$emit('bookshelf-total-entities', this.authors.length)
      this.loading = false
    },
    authorAdded(author) {
      if (this.hideNonAudiobooks) {
        this.init()
        return
      }

      if (!this.authors.some((au) => au.id === author.id)) {
        this.authors.push(author)
        this.$eventBus.$emit('bookshelf-total-entities', this.authors.length)
      }
    },
    authorUpdated(author) {
      if (this.hideNonAudiobooks) {
        this.init()
        return
      }

      this.authors = this.authors.map((au) => {
        if (au.id === author.id) {
          return author
        }
        return au
      })
    },
    authorRemoved(author) {
      this.authors = this.authors.filter((au) => au.id !== author.id)
      this.$eventBus.$emit('bookshelf-total-entities', this.authors.length)
    },
    libraryChanged(libraryId) {
      if (libraryId !== this.loadedLibraryId) {
        if (this.$store.getters['libraries/getCurrentLibraryMediaType'] === 'book') {
          this.init()
        } else {
          this.$router.replace('/bookshelf')
        }
      }
    },
    initListeners() {
      if (this.listenersInitialized) return
      this.$socket.$on('author_added', this.authorAdded)
      this.$socket.$on('author_updated', this.authorUpdated)
      this.$socket.$on('author_removed', this.authorRemoved)
      this.$eventBus.$on('library-changed', this.libraryChanged)
      this.listenersInitialized = true
    },
    removeListeners() {
      if (!this.listenersInitialized) return
      this.$socket.$off('author_added', this.authorAdded)
      this.$socket.$off('author_updated', this.authorUpdated)
      this.$socket.$off('author_removed', this.authorRemoved)
      this.$eventBus.$off('library-changed', this.libraryChanged)
      this.listenersInitialized = false
    }
  },
  mounted() {
    this.init()
    this.initListeners()
  },
  activated() {
    this.initListeners()
  },
  deactivated() {
    this.removeListeners()
  },
  beforeDestroy() {
    this.removeListeners()
  }
}
</script>

<style scoped>
/* Material 3 Expressive Vertical Scroll Container */
.library-scroll-container {
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}
</style>
