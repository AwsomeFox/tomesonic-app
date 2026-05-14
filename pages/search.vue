<template>
  <div class="w-full h-full" :style="contentPaddingStyle">
    <div class="px-4 py-6">
      <!-- Material 3 Search Field -->
      <div class="relative w-full">
        <div class="relative w-full h-14 bg-transparent rounded-full flex items-center px-4 border-2 shadow-elevation-1" :class="searchBorderClass">
          <!-- Search Icon -->
          <button @click="setFocus" class="material-symbols text-on-surface-variant mr-3 cursor-pointer state-layer" style="font-size: 1.25rem; background: none; border: none; padding: 0">search</button>

          <!-- Search Input -->
          <input ref="input" v-model="search" @input="updateSearch($event.target.value)" @focus="onFocus" @blur="onBlur" type="text" :placeholder="$strings.ButtonSearch" class="flex-1 bg-transparent outline-none text-on-surface text-body-large placeholder:text-on-surface-variant" autocomplete="off" autocorrect="off" autocapitalize="none" />

          <!-- Clear Button -->
          <button v-if="search" @click="clearSearch" class="ml-2 w-6 h-6 rounded-full flex items-center justify-center state-layer hover:bg-on-surface hover:bg-opacity-8 focus:bg-on-surface focus:bg-opacity-12 transition-all duration-200 ease-standard">
            <span class="material-symbols text-on-surface-variant" style="font-size: 1.125rem">close</span>
          </button>
        </div>
      </div>
    </div>
    <div class="w-full overflow-x-hidden overflow-y-auto search-content px-4" @click.stop>
      <div v-show="isFetching" class="w-full py-8 flex justify-center">
        <p class="text-lg text-fg-muted">{{ $strings.MessageFetching }}</p>
      </div>
      <div v-if="!isFetching && lastSearch && !totalResults" class="w-full py-8 flex justify-center">
        <p class="text-lg text-fg-muted">{{ $strings.MessageNoItemsFound }}</p>
      </div>
      <p v-if="bookResults.length" class="font-semibold text-sm mb-1">{{ $strings.LabelBooks }}</p>
      <template v-for="item in bookResults">
        <div :key="item.libraryItem.id" class="w-full h-16 py-1">
          <nuxt-link :to="`/item/${item.libraryItem.id}`">
            <cards-item-search-card :library-item="item.libraryItem" :match-key="item.matchKey" :match-text="item.matchText" :search="lastSearch" />
          </nuxt-link>
        </div>
      </template>

      <p v-if="podcastResults.length" class="uppercase text-xs text-fg-muted my-1 px-1 font-semibold">{{ $strings.LabelPodcasts }}</p>
      <template v-for="item in podcastResults">
        <div :key="item.libraryItem.id" class="text-on-surface select-none relative py-1">
          <nuxt-link :to="`/item/${item.libraryItem.id}`">
            <cards-item-search-card :library-item="item.libraryItem" :match-key="item.matchKey" :match-text="item.matchText" :search="lastSearch" />
          </nuxt-link>
        </div>
      </template>

      <p v-if="seriesResults.length" class="font-semibold text-sm mb-1 mt-2">{{ $strings.LabelSeries }}</p>
      <template v-for="seriesResult in seriesResults">
        <div :key="seriesResult.series.id" class="w-full h-16 py-1">
          <nuxt-link :to="`/bookshelf/series/${encodeURIComponent(String(seriesResult.series.id))}`">
            <cards-series-search-card :series="seriesResult.series" :book-items="seriesResult.books" />
          </nuxt-link>
        </div>
      </template>

      <p v-if="authorResults.length" class="font-semibold text-sm mb-1 mt-2">{{ $strings.LabelAuthors }}</p>
      <template v-for="authorResult in authorResults">
        <div :key="authorResult.id" class="w-full h-14 py-1">
          <nuxt-link :to="`/bookshelf/library?filter=authors.${$encode(authorResult.id)}`">
            <cards-author-search-card :author="authorResult" />
          </nuxt-link>
        </div>
      </template>

      <p v-if="narratorResults.length" class="font-semibold text-sm mb-1 mt-2">{{ $strings.LabelNarrators }}</p>
      <template v-for="narrator in narratorResults">
        <div :key="narrator.name" class="w-full h-14 py-1">
          <nuxt-link :to="`/bookshelf/library?filter=narrators.${$encode(narrator.name)}`">
            <cards-narrator-search-card :narrator="narrator.name" />
          </nuxt-link>
        </div>
      </template>

      <p v-if="tagResults.length" class="font-semibold text-sm mb-1 mt-2">{{ $strings.LabelTags }}</p>
      <template v-for="tag in tagResults">
        <div :key="tag.name" class="w-full h-14 py-1">
          <nuxt-link :to="`/bookshelf/library?filter=tags.${$encode(tag.name)}`">
            <cards-tag-search-card :tag="tag.name" />
          </nuxt-link>
        </div>
      </template>
    </div>
  </div>
</template>

<script>
import { getAudioPeopleStatsForLibrary, isBookEntityAudioCapable } from '@/plugins/audioFiltering'

export default {
  data() {
    return {
      search: null,
      searchTimeout: null,
      lastSearch: null,
      isFetching: false,
      focused: false,
      bookResults: [],
      podcastResults: [],
      seriesResults: [],
      authorResults: [],
      narratorResults: [],
      tagResults: []
    }
  },
  computed: {
    currentLibraryId() {
      return this.$store.state.libraries.currentLibraryId
    },
    hideNonAudiobooks() {
      return this.$store.getters['getHideNonAudiobooksGlobal']
    },
    bookCoverAspectRatio() {
      return this.$store.getters['libraries/getBookCoverAspectRatio']
    },
    totalResults() {
      return this.bookResults.length + this.seriesResults.length + this.authorResults.length + this.podcastResults.length + this.narratorResults.length + this.tagResults.length
    },
    searchBorderClass() {
      if (this.focused) {
        return 'border-primary'
      } else {
        return 'border-outline'
      }
    },
    contentPaddingStyle() {
      return this.$store.getters['getIsPlayerOpen'] ? { paddingBottom: '120px' } : {}
    }
  },
  watch: {
    hideNonAudiobooks() {
      if (this.lastSearch) {
        this.runSearch(this.lastSearch)
      }
    }
  },
  methods: {
    normalizePersonName(name) {
      if (!name || typeof name !== 'string') return ''
      return name.trim().toLowerCase().replace(/\s+/g, ' ')
    },
    getAuthorAudioCountFromStats(authorEntity, peopleStats) {
      const authorId = authorEntity?.id
      if (authorId && Object.prototype.hasOwnProperty.call(peopleStats.authorAudioCountsById || {}, authorId)) {
        return Number(peopleStats.authorAudioCountsById[authorId] || 0)
      }

      const normalizedName = this.normalizePersonName(authorEntity?.name)
      if (normalizedName && Object.prototype.hasOwnProperty.call(peopleStats.authorAudioCountsByName || {}, normalizedName)) {
        return Number(peopleStats.authorAudioCountsByName[normalizedName] || 0)
      }

      return 0
    },
    getNarratorAudioCountFromStats(narratorEntity, peopleStats) {
      const normalizedName = this.normalizePersonName(narratorEntity?.name)
      if (!normalizedName) return 0
      if (!Object.prototype.hasOwnProperty.call(peopleStats.narratorAudioCountsByName || {}, normalizedName)) return 0
      return Number(peopleStats.narratorAudioCountsByName[normalizedName] || 0)
    },
    async runSearch(value) {
      if (this.isFetching && this.lastSearch === value) return

      this.lastSearch = value
      this.$store.commit('globals/setLastSearch', value)

      if (!this.lastSearch) {
        this.bookResults = []
        this.podcastResults = []
        this.seriesResults = []
        this.authorResults = []
        this.narratorResults = []
        this.tagResults = []
        return
      }
      this.isFetching = true
      const results = await this.$nativeHttp.get(`/api/libraries/${this.currentLibraryId}/search?q=${value}&limit=5`).catch((error) => {
        console.error('Search error', error)
        return null
      })
      if (value !== this.lastSearch) {
        console.log(`runSearch: New search was made for ${this.lastSearch} - results are from ${value}`)
        this.isFetching = false
        return
      }
      console.log('RESULTS', results)

      let nextBookResults = results?.book || []
      const nextPodcastResults = results?.podcast || []
      let nextSeriesResults = results?.series || []
      let nextAuthorResults = results?.authors || []
      let nextNarratorResults = results?.narrators || []
      const nextTagResults = results?.tags || []

      if (this.hideNonAudiobooks) {
        const peopleStats = await getAudioPeopleStatsForLibrary({
          libraryId: this.currentLibraryId,
          nativeHttp: this.$nativeHttp,
          encode: this.$encode,
          includeEbookOnly: true
        })

        if (value !== this.lastSearch) {
          console.log(`runSearch: New search was made for ${this.lastSearch} while filtering results for ${value}`)
          this.isFetching = false
          return
        }

        nextBookResults = nextBookResults.filter((bookResult) => isBookEntityAudioCapable(bookResult?.libraryItem || bookResult))
        nextSeriesResults = nextSeriesResults
          .map((seriesResult) => {
            const filteredBooks = Array.isArray(seriesResult?.books) ? seriesResult.books.filter((book) => isBookEntityAudioCapable(book)) : []
            return {
              ...seriesResult,
              books: filteredBooks
            }
          })
          .filter((seriesResult) => Array.isArray(seriesResult.books) && seriesResult.books.length > 0)

        nextAuthorResults = nextAuthorResults
          .map((authorEntity) => {
            const numBooks = this.getAuthorAudioCountFromStats(authorEntity, peopleStats)
            return {
              ...authorEntity,
              numBooks
            }
          })
          .filter((authorEntity) => Number(authorEntity?.numBooks || 0) > 0)

        nextNarratorResults = nextNarratorResults
          .map((narratorEntity) => {
            const numBooks = this.getNarratorAudioCountFromStats(narratorEntity, peopleStats)
            return {
              ...narratorEntity,
              numBooks
            }
          })
          .filter((narratorEntity) => Number(narratorEntity?.numBooks || 0) > 0)
      }

      this.isFetching = false

      this.bookResults = nextBookResults
      this.podcastResults = nextPodcastResults
      this.seriesResults = nextSeriesResults
      this.authorResults = nextAuthorResults
      this.narratorResults = nextNarratorResults
      this.tagResults = nextTagResults
    },
    updateSearch(val) {
      clearTimeout(this.searchTimeout)
      this.searchTimeout = setTimeout(() => {
        this.runSearch(val)
      }, 500)
    },
    clearSearch() {
      this.search = ''
      this.updateSearch('')
    },
    setFocus() {
      setTimeout(() => {
        if (this.$refs.input) {
          this.$refs.input.focus()
        }
      }, 100)
    },
    onFocus() {
      this.focused = true
    },
    onBlur() {
      this.focused = false
    },
    setFocus() {
      this.$nextTick(() => {
        if (this.$refs.input) {
          this.$refs.input.focus()
          this.$refs.input.click() // Additional click to ensure keyboard opens on mobile
        }
      })
    }
  },
  mounted() {
    if (this.$store.state.globals.lastSearch) {
      this.search = this.$store.state.globals.lastSearch
      this.runSearch(this.search)
    } else {
      this.$nextTick(() => this.setFocus())
    }
  }
}
</script>

<style>
.search-content {
  height: calc(100% - 108px);
  max-height: calc(100% - 108px);
}
</style>
