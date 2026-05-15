<template>
  <div ref="card" :id="`book-card-${index}`" :style="{ minWidth: width + 'px', maxWidth: width + 'px', height: height + 'px' }" class="material-3-card book-card-shell expressive-card p-0 rounded-3xl z-10 bg-surface-container cursor-pointer shadow-elevation-1 hover:shadow-elevation-3 transition-all duration-300 ease-expressive state-layer relative" @click="clickCard">
    <!-- Cover image container - fills entire card (first in DOM, lowest z-index) -->
    <div class="cover-container absolute inset-0 z-0">
      <!-- Blurred background for aspect ratio mismatch -->
      <div v-show="showCoverBg" class="absolute inset-0 z-0">
        <div class="absolute cover-bg inset-0" ref="coverBg" />
      </div>

      <!-- Loading placeholder -->
      <div v-show="libraryItem && !imageReady" class="absolute inset-0 flex items-center justify-center bg-surface-container z-10">
        <p :style="{ fontSize: sizeMultiplier * 0.8 + 'rem' }" class="text-on-surface-variant text-center">{{ title }}</p>
      </div>

      <!-- Book cover image - fills entire card -->
      <img
        v-show="libraryItem && !isMaterialSymbolPlaceholder"
        ref="cover"
        :src="bookCoverSrc"
        loading="lazy"
        decoding="async"
        class="w-full h-full transition-opacity duration-300 object-cover z-5"
        @load="imageLoaded"
        :style="{
          opacity: imageReady ? 1 : 0,
          objectPosition: 'center center'
        }"
      />

      <!-- Material Symbol placeholder -->
      <div v-if="isMaterialSymbolPlaceholder" class="w-full h-full absolute inset-0 flex items-center justify-center bg-surface-container z-5">
        <span class="material-symbols text-6xl text-on-surface-variant">book</span>
      </div>

      <!-- Placeholder Cover Title & Author -->
      <div v-if="!hasCover" class="absolute inset-0 flex flex-col items-center justify-center bg-primary p-4 z-10">
        <div class="text-center">
          <p class="text-on-primary font-medium mb-2" :style="{ fontSize: titleFontSize + 'rem' }">{{ titleCleaned }}</p>
          <p class="text-on-primary opacity-75" :style="{ fontSize: authorFontSize + 'rem' }">{{ authorCleaned }}</p>
        </div>
      </div>
    </div>

    <!-- Alt-view metadata panel to match Author/Series Material 3 pattern -->
    <div v-if="isAltViewEnabled" class="book-meta-panel absolute left-0 right-0 bottom-0 z-50">
      <div class="book-meta-content" :style="showPlayButton ? { paddingLeft: 3.6 * sizeMultiplier + 'rem' } : null">
        <div :style="{ fontSize: 0.76 * sizeMultiplier + 'rem' }" class="book-meta-title-row">
          <p class="book-meta-title" :style="{ fontSize: 0.78 * sizeMultiplier + 'rem' }">
            <span class="book-meta-title-text">{{ displayTitle }}</span>
          </p>
          <widgets-explicit-indicator v-if="isExplicit" class="ml-1" />
        </div>
        <p class="book-meta-line" :style="{ fontSize: 0.68 * sizeMultiplier + 'rem' }">
          <span class="book-meta-line-text">{{ displayLineTwo || '&nbsp;' }}</span>
        </p>
        <p v-if="displaySortLine" class="book-meta-line" :style="{ fontSize: 0.68 * sizeMultiplier + 'rem' }">
          <span class="book-meta-line-text">{{ displaySortLine }}</span>
        </p>
      </div>
    </div>

    <!-- Series sequence badge with enhanced visibility -->
    <div v-if="seriesSequenceList" class="absolute rounded-lg bg-tertiary-container shadow-elevation-3 z-30 text-right border border-outline-variant border-opacity-30" :style="{ top: (showHasLocalDownload ? 48 : 8) + (rssFeed ? 32 : 0) + 'px', right: '8px', padding: `${0.15 * sizeMultiplier}rem ${0.3 * sizeMultiplier}rem` }">
      <p class="text-on-tertiary-container font-bold" :style="{ fontSize: sizeMultiplier * 0.7 + 'rem' }">#{{ seriesSequenceList }}</p>
    </div>
    <div v-else-if="booksInSeries" class="absolute rounded-lg bg-secondary-container shadow-elevation-3 z-30 border border-outline-variant border-opacity-30" :style="{ top: (showHasLocalDownload ? 48 : 8) + (rssFeed ? 32 : 0) + 'px', right: '8px', padding: `${0.15 * sizeMultiplier}rem ${0.3 * sizeMultiplier}rem` }">
      <p class="text-on-secondary-container font-bold" :style="{ fontSize: sizeMultiplier * 0.7 + 'rem' }">{{ booksInSeries }}</p>
    </div>

    <!-- Material 3 Play button with enhanced visibility -->
    <div v-if="showPlayButton" class="absolute bottom-2 left-2 z-30">
      <button type="button" class="material-3-play-button rounded-full transition-all duration-200 ease-expressive shadow-elevation-2 hover:shadow-elevation-4 w-12 h-12 bg-primary" @click.stop.prevent="play">
        <span class="material-symbols text-2xl text-on-primary">{{ streamIsPlaying ? 'pause' : 'play_arrow' }}</span>
      </button>
    </div>

    <!-- Play/pause button for podcast episode with enhanced visibility -->
    <div v-if="recentEpisode" class="absolute z-30 top-0 left-0 bottom-0 right-0 m-auto flex items-center justify-center" @click.stop="playEpisode">
      <button v-if="!playerIsStartingForThisMedia" type="button" class="material-3-play-button rounded-full transition-all duration-200 ease-expressive shadow-elevation-2 hover:shadow-elevation-4 w-12 h-12 bg-primary" @click.stop.prevent="playEpisode">
        <span class="material-symbols text-2xl text-on-primary">{{ streamIsPlaying ? 'pause' : 'play_arrow' }}</span>
      </button>
      <div v-else class="w-12 h-12 bg-surface-container rounded-full flex items-center justify-center shadow-elevation-3 ring-2 ring-surface ring-opacity-20">
        <svg class="animate-spin text-primary" style="width: 24px; height: 24px" viewBox="0 0 24 24">
          <path fill="currentColor" d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" />
        </svg>
      </div>
    </div>

    <!-- M3 Expressive Progress chip in top-left (matches library list row pill) -->
    <div v-if="!collapsedSeries && (!isPodcast || recentEpisode) && userProgressPercent > 0" class="absolute top-2 left-2 z-40">
      <div class="expressive-progress-chip inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-tertiary-container text-on-tertiary-container" :style="{ fontSize: 0.62 * sizeMultiplier + 'rem' }">
        <span class="material-symbols" :style="{ fontSize: 0.85 * sizeMultiplier + 'rem' }">{{ itemIsFinished ? 'check_circle' : 'schedule' }}</span>
        <span class="font-semibold leading-none">{{ progressChipLabel }}</span>
      </div>
    </div>

    <!-- Downloaded indicator (expressive) -->
    <div v-if="showHasLocalDownload" class="absolute right-2 top-2 z-30">
      <div class="expressive-download-badge flex items-center justify-center" :style="{ width: 1.75 * sizeMultiplier + 'rem', height: 1.75 * sizeMultiplier + 'rem' }">
        <span class="material-symbols text-on-secondary" :style="{ fontSize: sizeMultiplier * 0.9 + 'rem' }">cloud_done</span>
      </div>
    </div>

    <!-- Error indicator with enhanced visibility -->
    <div v-if="showError" :style="{ height: 1.5 * sizeMultiplier + 'rem', width: 2.5 * sizeMultiplier + 'rem' }" class="bg-error-container rounded-r-full shadow-elevation-3 flex items-center justify-end absolute bottom-4 left-0 z-30 border border-outline-variant border-opacity-30">
      <span class="material-symbols text-on-error-container pr-1 drop-shadow-sm" :style="{ fontSize: 0.875 * sizeMultiplier + 'rem' }">priority_high</span>
    </div>

    <!-- RSS feed indicator with enhanced visibility -->
    <div v-if="rssFeed" class="absolute right-2 z-30" :style="{ top: (showHasLocalDownload ? 4 : 2) + 'px' }">
      <div class="bg-tertiary-container shadow-elevation-3 rounded-full border border-outline-variant border-opacity-30 flex items-center justify-center" :style="{ width: 1.5 * sizeMultiplier + 'rem', height: 1.5 * sizeMultiplier + 'rem' }">
        <span class="material-symbols text-on-tertiary-container drop-shadow-sm" :style="{ fontSize: sizeMultiplier * 0.8 + 'rem' }">rss_feed</span>
      </div>
    </div>

    <!-- Series sequence number with enhanced visibility -->
    <div v-if="seriesSequence && showSequence && !isSelectionMode" class="absolute rounded-lg bg-primary-container shadow-elevation-3 z-30 border border-outline-variant border-opacity-30" :style="{ top: (showHasLocalDownload ? 48 : 8) + (rssFeed ? 32 : 0) + 'px', right: '8px', padding: `${0.15 * sizeMultiplier}rem ${0.3 * sizeMultiplier}rem` }">
      <p class="text-on-primary-container font-bold drop-shadow-sm" :style="{ fontSize: sizeMultiplier * 0.7 + 'rem' }">#{{ seriesSequence }}</p>
    </div>

    <!-- Podcast Episode indicator with enhanced visibility -->
    <div v-if="recentEpisodeNumber !== null && !isSelectionMode" class="absolute rounded-lg bg-secondary-container shadow-elevation-3 z-30 border border-outline-variant border-opacity-30" :style="{ top: (showHasLocalDownload ? 48 : 8) + (rssFeed ? 32 : 0) + 'px', right: '8px', padding: `${0.15 * sizeMultiplier}rem ${0.3 * sizeMultiplier}rem` }">
      <p class="text-on-secondary-container font-bold drop-shadow-sm" :style="{ fontSize: sizeMultiplier * 0.6 + 'rem' }">
        Episode<span v-if="recentEpisodeNumber"> #{{ recentEpisodeNumber }}</span>
      </p>
    </div>

    <!-- Episode count badges with enhanced visibility -->
    <div
      v-else-if="numEpisodes && !numEpisodesIncomplete && !isSelectionMode"
      class="absolute rounded-full bg-surface-container-high shadow-elevation-3 z-30 flex items-center justify-center border border-outline-variant border-opacity-30"
      :style="{ top: (showHasLocalDownload ? 48 : 8) + (rssFeed ? 32 : 0) + 'px', right: '8px', width: 1.2 * sizeMultiplier + 'rem', height: 1.2 * sizeMultiplier + 'rem' }"
    >
      <p class="text-on-surface font-bold drop-shadow-sm" :style="{ fontSize: sizeMultiplier * 0.6 + 'rem' }">{{ numEpisodes }}</p>
    </div>

    <div v-else-if="numEpisodesIncomplete && !isSelectionMode" class="absolute rounded-full bg-tertiary-container shadow-elevation-3 z-30 flex items-center justify-center border border-outline-variant border-opacity-30" :style="{ top: (showHasLocalDownload ? 48 : 8) + (rssFeed ? 32 : 0) + 'px', right: '8px', width: 1.2 * sizeMultiplier + 'rem', height: 1.2 * sizeMultiplier + 'rem' }">
      <p class="text-on-tertiary-container font-bold drop-shadow-sm" :style="{ fontSize: sizeMultiplier * 0.6 + 'rem' }">{{ numEpisodesIncomplete }}</p>
    </div>
  </div>
</template>

<script>
import { Capacitor } from '@capacitor/core'

export default {
  props: {
    index: Number,
    width: {
      type: Number,
      default: 120
    },
    height: {
      type: Number,
      default: 192
    },
    bookCoverAspectRatio: Number,
    showSequence: Boolean,
    isAltViewEnabled: Boolean,
    bookMount: {
      // Book can be passed as prop or set with setEntity()
      type: Object,
      default: () => null
    },
    orderBy: String,
    filterBy: String,
    sortingIgnorePrefix: Boolean
  },
  data() {
    return {
      isProcessingReadUpdate: false,
      libraryItem: null,
      imageReady: false,
      selected: false,
      isSelectionMode: false,
      showCoverBg: false,
      localLibraryItem: null
    }
  },
  watch: {
    bookMount: {
      handler(newVal) {
        if (newVal) {
          this.libraryItem = newVal
        }
      }
    }
  },
  computed: {
    _libraryItem() {
      return this.libraryItem || {}
    },
    isLocal() {
      return !!this._libraryItem.isLocal
    },
    media() {
      return this._libraryItem.media || {}
    },
    mediaMetadata() {
      return this.media.metadata || {}
    },
    mediaType() {
      return this._libraryItem.mediaType
    },
    isPodcast() {
      return this.mediaType === 'podcast'
    },
    placeholderUrl() {
      // Material 3 book icon as SVG data URL
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>`
      return `data:image/svg+xml;base64,${btoa(svg)}`
    },
    bookCoverSrc() {
      if (this.isLocal) {
        if (this.libraryItem.coverContentUrl) return Capacitor.convertFileSrc(this.libraryItem.coverContentUrl)
        return this.placeholderUrl
      }
      return this.store.getters['globals/getLibraryItemCoverSrc'](this._libraryItem, this.placeholderUrl)
    },
    libraryItemId() {
      return this._libraryItem.id
    },
    libraryId() {
      return this._libraryItem.libraryId
    },
    hasEbook() {
      return this.media.ebookFile
    },
    numTracks() {
      return this.media.numTracks
    },
    numEpisodes() {
      if (this.isLocal && this.isPodcast && this.media.episodes) return this.media.episodes.length
      return this.media.numEpisodes
    },
    numEpisodesIncomplete() {
      if (this.isLocal) return 0
      return this._libraryItem.numEpisodesIncomplete || 0
    },
    processingBatch() {
      return this.store.state.processingBatch
    },
    booksInSeries() {
      // Only added to audiobook object when collapseSeries is enabled
      return this._libraryItem.booksInSeries
    },
    hasCover() {
      return !!this.media.coverPath
    },
    squareAspectRatio() {
      return this.bookCoverAspectRatio === 1
    },
    sizeMultiplier() {
      var baseSize = this.squareAspectRatio ? 192 : 120
      return this.width / baseSize
    },
    title() {
      return this.mediaMetadata.title || ''
    },
    playIconFontSize() {
      return Math.max(2, 3 * this.sizeMultiplier)
    },
    authors() {
      return this.mediaMetadata.authors || []
    },
    author() {
      if (this.isPodcast) return this.mediaMetadata.author
      return this.mediaMetadata.authorName
    },
    authorLF() {
      return this.mediaMetadata.authorNameLF
    },
    series() {
      // Only included when filtering by series or collapse series
      return this.mediaMetadata.series
    },
    seriesSequence() {
      return this.series?.sequence || null
    },
    recentEpisode() {
      // Only added to item when getting currently listening podcasts
      return this._libraryItem.recentEpisode
    },
    recentEpisodeNumber() {
      if (!this.recentEpisode) return null
      if (this.recentEpisode.episode) {
        return this.recentEpisode.episode.replace(/^#/, '')
      }
      return ''
    },
    collapsedSeries() {
      // Only added to item object when collapseSeries is enabled
      return this._libraryItem.collapsedSeries
    },
    booksInSeries() {
      // Only added to item object when collapseSeries is enabled
      return this.collapsedSeries?.numBooks || 0
    },
    seriesSequenceList() {
      return this.collapsedSeries?.seriesSequenceList || null
    },
    libraryItemIdsInSeries() {
      // Only added to item object when collapseSeries is enabled
      return this.collapsedSeries?.libraryItemIds || []
    },
    displayTitle() {
      if (this.recentEpisode) return this.recentEpisode.title

      const ignorePrefix = this.orderBy === 'media.metadata.title' && this.sortingIgnorePrefix
      if (this.collapsedSeries) return ignorePrefix ? this.collapsedSeries.nameIgnorePrefix : this.collapsedSeries.name
      return ignorePrefix ? this.mediaMetadata.titleIgnorePrefix : this.title
    },
    displayLineTwo() {
      if (this.recentEpisode) return this.title
      if (this.collapsedSeries) return ''
      if (this.isPodcast) return this.author

      if (this.orderBy === 'media.metadata.authorNameLF') return this.authorLF
      return this.author
    },
    displaySortLine() {
      if (this.collapsedSeries) return null
      if (this.orderBy === 'mtimeMs') return 'Modified ' + this.$formatDate(this._libraryItem.mtimeMs)
      if (this.orderBy === 'birthtimeMs') return 'Born ' + this.$formatDate(this._libraryItem.birthtimeMs)
      if (this.orderBy === 'addedAt') return this.$getString('LabelAddedDate', [this.$formatDate(this._libraryItem.addedAt)])
      if (this.orderBy === 'media.duration') return 'Duration: ' + this.$elapsedPrettyExtended(this.media.duration, false)
      if (this.orderBy === 'size') return 'Size: ' + this.$bytesPretty(this._libraryItem.size)
      if (this.orderBy === 'media.numTracks') return `${this.numEpisodes} Episodes`
      return null
    },
    episodeProgress() {
      // Only used on home page currently listening podcast shelf
      if (!this.recentEpisode) return null
      if (this.isLocal) return this.store.getters['globals/getLocalMediaProgressById'](this.libraryItemId, this.recentEpisode.id)
      return this.store.getters['user/getUserMediaProgress'](this.libraryItemId, this.recentEpisode.id)
    },
    userProgress() {
      if (this.recentEpisode) return this.episodeProgress || null
      if (this.isLocal) return this.store.getters['globals/getLocalMediaProgressById'](this.libraryItemId)
      return this.store.getters['user/getUserMediaProgress'](this.libraryItemId)
    },
    useEBookProgress() {
      if (!this.userProgress || this.userProgress.progress) return false
      return this.userProgress.ebookProgress > 0
    },
    userProgressPercent() {
      if (this.useEBookProgress) return Math.max(Math.min(1, this.userProgress.ebookProgress), 0)
      return Math.max(Math.min(1, this.userProgress?.progress || 0), 0) || 0
    },
    itemIsFinished() {
      return !!this.userProgress?.isFinished
    },
    userTimeRemaining() {
      const duration = Number(this.media?.duration || 0)
      if (!duration) return 0
      const progress = Number(this.userProgress?.progress || 0)
      const remaining = duration * (1 - progress)
      return remaining > 0 ? remaining : 0
    },
    progressChipLabel() {
      if (this.itemIsFinished) return this.$strings?.LabelFinished || 'Finished'
      const remaining = this.userTimeRemaining
      if (!remaining) return ''
      const pretty = this.$elapsedPretty ? this.$elapsedPretty(remaining) : ''
      if (this.$getString && this.$strings?.LabelTimeRemaining) return this.$getString('LabelTimeRemaining', [pretty])
      return pretty
    },
    showError() {
      return this.isMissing || this.isInvalid
    },
    localLibraryItemId() {
      if (this.isLocal) return this.libraryItemId
      return this.localLibraryItem?.id || null
    },
    localEpisode() {
      if (!this.recentEpisode || !this.localLibraryItem) return null
      // Current recentEpisode is only implemented server side so this will always be the serverEpisodeId
      return this.localLibraryItem.media.episodes.find((ep) => ep.serverEpisodeId === this.recentEpisode.id)
    },
    isStreaming() {
      return this.store.getters['getIsMediaStreaming'](this.libraryItemId, this.recentEpisode?.id)
    },
    streamIsPlaying() {
      return this.store.state.playerIsPlaying && this.isStreaming
    },
    playerIsStartingPlayback() {
      // Play has been pressed and waiting for native play response
      return this.store.state.playerIsStartingPlayback
    },
    playerIsStartingForThisMedia() {
      const mediaId = this.store.state.playerStartingPlaybackMediaId
      return mediaId === this.recentEpisode?.id
    },
    isMissing() {
      return this._libraryItem.isMissing
    },
    isInvalid() {
      return this._libraryItem.isInvalid
    },
    isExplicit() {
      return !!this.mediaMetadata.explicit
    },
    overlayWrapperClasslist() {
      var classes = []
      if (this.isSelectionMode) classes.push('bg-opacity-60')
      else classes.push('bg-opacity-40')
      if (this.selected) {
        classes.push('border-2 border-yellow-400')
      }
      return classes
    },
    store() {
      return this.$store || this.$nuxt.$store
    },
    userCanUpdate() {
      return this.store.getters['user/getUserCanUpdate']
    },
    userCanDelete() {
      return this.store.getters['user/getUserCanDelete']
    },
    userCanDownload() {
      return this.store.getters['user/getUserCanDownload']
    },
    titleFontSize() {
      return 0.75 * this.sizeMultiplier
    },
    authorFontSize() {
      return 0.6 * this.sizeMultiplier
    },
    placeholderCoverPadding() {
      return 0.8 * this.sizeMultiplier
    },
    authorBottom() {
      return 0.75 * this.sizeMultiplier
    },
    titleCleaned() {
      if (!this.title) return ''
      if (this.title.length > 60) {
        return this.title.slice(0, 57) + '...'
      }
      return this.title
    },
    authorCleaned() {
      if (!this.author) return ''
      if (this.author.length > 30) {
        return this.author.slice(0, 27) + '...'
      }
      return this.author
    },
    titleDisplayBottomOffset() {
      if (!this.isAltViewEnabled) return 0
      else if (!this.displaySortLine) return 3 * this.sizeMultiplier
      return 4.25 * this.sizeMultiplier
    },
    showHasLocalDownload() {
      if (this.localLibraryItem || this.isLocal) {
        if (this.recentEpisode && !this.isLocal) {
          return !!this.localEpisode
        } else {
          return true
        }
      }
      return false
    },
    rssFeed() {
      if (this.booksInSeries) return null
      return this._libraryItem.rssFeed || null
    },
    showPlayButton() {
      return false
      // return !this.isMissing && !this.isInvalid && !this.isStreaming && (this.numTracks || this.recentEpisode)
    },
    isMaterialSymbolPlaceholder() {
      return this.bookCoverSrc === 'material-symbol:book'
    }
  },
  methods: {
    setSelectionMode(val) {
      this.isSelectionMode = val
      if (!val) this.selected = false
    },
    setEntity(_libraryItem) {
      var libraryItem = _libraryItem

      // this code block is only necessary when showing a selected series with sequence #
      //   it will update the selected series so we get realtime updates for series sequence changes
      if (this.series) {
        // i know.. but the libraryItem passed to this func cannot be modified so we need to create a copy
        libraryItem = {
          ..._libraryItem,
          media: {
            ..._libraryItem.media,
            metadata: {
              ..._libraryItem.media.metadata
            }
          }
        }
        var mediaMetadata = libraryItem.media.metadata
        if (mediaMetadata.series) {
          var newSeries = mediaMetadata.series.find((se) => se.id === this.series.id)
          if (newSeries) {
            // update selected series
            libraryItem.media.metadata.series = newSeries
            this.libraryItem = libraryItem
            return
          }
        }
      }

      this.libraryItem = libraryItem
    },
    setLocalLibraryItem(localLibraryItem) {
      // Server books may have a local library item
      this.localLibraryItem = localLibraryItem
    },
    async play() {},
    async playEpisode() {
      if (this.playerIsStartingPlayback) return

      await this.$hapticsImpact()
      const eventBus = this.$eventBus || this.$nuxt.$eventBus
      if (this.streamIsPlaying) {
        eventBus.$emit('pause-item')
        return
      }

      this.store.commit('setPlayerIsStartingPlayback', this.recentEpisode.id)
      if (this.localEpisode) {
        // Play episode locally
        eventBus.$emit('play-item', {
          libraryItemId: this.localLibraryItemId,
          episodeId: this.localEpisode.id,
          serverLibraryItemId: this.libraryItemId,
          serverEpisodeId: this.recentEpisode.id
        })
        return
      }

      eventBus.$emit('play-item', { libraryItemId: this.libraryItemId, episodeId: this.recentEpisode.id })
    },
    async clickCard(e) {
      if (this.isSelectionMode) {
        e.stopPropagation()
        e.preventDefault()
        this.selectBtnClick()
      } else {
        const router = this.$router || this.$nuxt.$router
        if (router) {
          if (this.recentEpisode) router.push(`/item/${this.libraryItemId}/${this.recentEpisode.id}`)
          else if (this.collapsedSeries) router.push(`/bookshelf/series/${encodeURIComponent(String(this.collapsedSeries.id))}`)
          else if (this.localLibraryItem) {
            // Pass local library item id to server page to allow falling back to offline page
            router.push(`/item/${this.libraryItemId}?localLibraryItemId=${this.localLibraryItemId}`)
          } else {
            router.push(`/item/${this.libraryItemId}`)
          }
        }
      }
    },
    editClick() {
      this.$emit('edit', this.libraryItem)
    },
    showEditModalTracks() {
      // More menu func
      this.store.commit('showEditModalOnTab', { libraryItem: this.libraryItem, tab: 'tracks' })
    },
    showEditModalMatch() {
      // More menu func
      this.store.commit('showEditModalOnTab', { libraryItem: this.libraryItem, tab: 'match' })
    },
    showEditModalDownload() {
      // More menu func
      this.store.commit('showEditModalOnTab', { libraryItem: this.libraryItem, tab: 'download' })
    },
    openCollections() {
      this.store.commit('setSelectedLibraryItem', this.libraryItem)
      this.store.commit('globals/setShowUserCollectionsModal', true)
    },
    clickReadEBook() {
      this.store.commit('showEReader', this.libraryItem)
    },
    selectBtnClick() {
      if (this.processingBatch) return
      this.selected = !this.selected
      this.$emit('select', this.libraryItem)
    },
    destroy() {
      // destroy the vue listeners, etc
      this.$destroy()

      // remove the element from the DOM
      if (this.$el && this.$el.parentNode) {
        this.$el.parentNode.removeChild(this.$el)
      } else if (this.$el && this.$el.remove) {
        this.$el.remove()
      }
    },
    setCoverBg() {
      if (this.$refs.coverBg) {
        this.$refs.coverBg.style.backgroundImage = `url("${this.bookCoverSrc}")`
      }
    },
    imageLoaded() {
      this.imageReady = true

      // Since we're forcing all images to square aspect ratio,
      // we can be more selective about when to show background blur
      if (this.$refs.cover && this.bookCoverSrc !== this.placeholderUrl) {
        const { naturalWidth, naturalHeight } = this.$refs.cover
        const aspectRatio = naturalHeight / naturalWidth

        // Only show background blur for extremely non-square images for aesthetic effect
        // Most images will now appear square due to CSS aspect-ratio and object-cover
        if (aspectRatio < 0.5 || aspectRatio > 2.0) {
          this.showCoverBg = true
          this.$nextTick(this.setCoverBg)
        } else {
          this.showCoverBg = false
        }
      }
    }
  },
  mounted() {
    if (this.bookMount) {
      this.setEntity(this.bookMount)

      if (this.bookMount.localLibraryItem) {
        this.setLocalLibraryItem(this.bookMount.localLibraryItem)
      }
    }
  }
}
</script>

<style scoped>
/* Material 3 Expressive Book Card Styles */
.material-3-card {
  /* Smooth transitions for Material 3 expressive design */
  transition: box-shadow 300ms cubic-bezier(0.2, 0, 0, 1), transform 300ms cubic-bezier(0.2, 0, 0, 1);
}

.book-card-shell {
  padding: 0 !important;
}

.material-3-card::before {
  content: '';
  position: absolute;
  border-radius: inherit;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: transparent;
  transition: background-color 200ms cubic-bezier(0.2, 0, 0, 1);
  pointer-events: none;
  z-index: 1;
}

.material-3-card:hover {
  transform: translateY(-2px);
}

.material-3-card:hover::before {
  background-color: rgba(var(--md-sys-color-on-surface), var(--md-sys-state-hover-opacity, 0.08));
}

.material-3-card:active {
  transform: translateY(0px);
}

.material-3-card:active::before {
  background-color: rgba(var(--md-sys-color-on-surface), var(--md-sys-state-pressed-opacity, 0.12));
}

/* Material 3 Expressive press response */
.expressive-card {
  transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 220ms cubic-bezier(0.2, 0, 0, 1);
}
.expressive-card:active {
  transform: scale(0.97);
}

/* M3 Expressive badges & progress ring on book cards */
@keyframes expressivePopIn {
  0% {
    transform: scale(0.4);
    opacity: 0;
  }
  60% {
    transform: scale(1.12);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
.expressive-badge {
  animation: expressivePopIn 320ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  border: 2px solid rgba(var(--md-sys-color-surface), 0.65);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18), 0 0 0 2px rgba(var(--md-sys-color-primary), 0.18);
}
.expressive-badge--download {
  background: linear-gradient(135deg, rgb(var(--md-sys-color-primary)) 0%, rgb(var(--md-sys-color-tertiary)) 100%);
}
.expressive-badge--finished {
  background: linear-gradient(135deg, rgb(var(--md-sys-color-tertiary-container)) 0%, rgb(var(--md-sys-color-primary-container)) 100%);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18), 0 0 0 2px rgba(var(--md-sys-color-tertiary), 0.25);
}
/* Downloaded indicator — squircle shape + secondary tint to distinguish from
   the circular finished checkmark. */
.expressive-download-badge {
  background: linear-gradient(135deg, rgb(var(--md-sys-color-secondary)) 0%, rgb(var(--md-sys-color-primary)) 100%);
  border-radius: 10px;
  border: 2px solid rgba(var(--md-sys-color-surface), 0.65);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.22), 0 0 0 2px rgba(var(--md-sys-color-secondary), 0.22);
  animation: expressivePopIn 320ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.expressive-progress-ring {
  background: rgba(var(--md-sys-color-surface-container), 0.82);
  border: 2px solid rgba(var(--md-sys-color-surface), 0.6);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.22);
}
.expressive-progress-ring__fill {
  filter: drop-shadow(0 0 3px rgba(var(--md-sys-color-primary), 0.7));
  transition: stroke-dasharray 480ms cubic-bezier(0.2, 0, 0, 1);
}

/* Ensure content stays above state layer, but exclude cover container and absolutely positioned elements */
.material-3-card > *:not(.cover-container):not(.absolute) {
  position: relative;
  z-index: 2;
}

/* Add expressive motion to indicators */
.material-3-card [class*='shadow-elevation-'] {
  transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
}

.material-3-card:hover [class*='shadow-elevation-'] {
  transform: scale(1.05);
}

/* Cover background for aspect ratio mismatch */
.cover-bg {
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  filter: blur(8px);
  transform: scale(1.1);
  top: -10%;
  left: -10%;
  width: 120%;
  height: 120%;
  opacity: 0.3;
}

/* Force square aspect ratio for all book covers */
.material-3-card img {
  aspect-ratio: 1 / 1;
  object-fit: cover;
  object-position: center center;
}

/* Fallback for older browsers that don't support aspect-ratio */
@supports not (aspect-ratio: 1 / 1) {
  .material-3-card img {
    width: 100% !important;
    height: 100% !important;
  }
}

/* Enhanced text visibility — text-shadow is far cheaper than filter:drop-shadow
   during shelf scroll (no extra paint layer per card). */
.drop-shadow-sm {
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
}

/* Ensure overlays are always visible — solid translucent surface, no blur */
.material-3-card .bg-opacity-95 {
  background-color: rgba(var(--md-sys-color-surface-container-high), 0.95);
}

/* Icon rings for better visibility */
.ring-2 {
  box-shadow: 0 0 0 2px currentColor;
}

.ring-4 {
  box-shadow: 0 0 0 4px currentColor;
}

.ring-surface {
  --tw-ring-color: rgb(var(--md-sys-color-surface));
}

.ring-opacity-20 {
  --tw-ring-opacity: 0.2;
}

.ring-opacity-30 {
  --tw-ring-opacity: 0.3;
}

/* Expressive easing definition */
.ease-expressive {
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}

.book-meta-panel {
  background: transparent;
  isolation: isolate;
}

.book-meta-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  background: linear-gradient(180deg, rgba(var(--md-sys-color-surface-container), 0) 2%, rgba(var(--md-sys-color-surface-container), 0.78) 55%, rgba(var(--md-sys-color-surface-container-high), 0.9) 100%);
  backdrop-filter: blur(10px) saturate(1.05);
  -webkit-backdrop-filter: blur(10px) saturate(1.05);
}

.book-meta-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px 12px;
  position: relative;
  z-index: 1;
}

.book-meta-title-row {
  display: flex;
  align-items: center;
  min-width: 0;
}

.book-meta-title {
  color: rgb(var(--md-sys-color-on-media));
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
  padding-left: 3px;
  padding-right: 3px;
  margin: 0;
  flex: 1 1 auto;
  min-width: 0;
}

.book-meta-title-text {
  display: block;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 16px;
  padding-right: 16px;
  margin-left: -13px;
  margin-right: -13px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}

.book-meta-line {
  color: rgb(var(--md-sys-color-on-media-variant));
  font-weight: 500;
  line-height: 1.2;
  padding-left: 3px;
  padding-right: 3px;
  margin: 0;
}

.book-meta-line-text {
  display: block;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 16px;
  padding-right: 16px;
  margin-left: -13px;
  margin-right: -13px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.82);
}
</style>
