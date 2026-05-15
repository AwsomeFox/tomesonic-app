<template>
  <div class="w-full px-1.5 pb-1.5">
    <div class="w-full h-full p-2 rounded-lg relative bg-bg overflow-hidden">
      <nuxt-link v-if="libraryItem" :to="itemUrl" class="flex items-center w-full">
        <div class="h-full relative" :style="{ width: '50px' }">
          <covers-book-cover :library-item="libraryItem" :width="50" :book-cover-aspect-ratio="bookCoverAspectRatio" />
        </div>
        <div class="item-table-content h-full px-2 flex items-center">
          <div class="max-w-full">
            <p class="truncate block text-sm">{{ itemTitle }} <span v-if="localLibraryItem" class="material-symbols text-success text-base align-text-bottom">download_done</span></p>
            <p v-if="authorName" class="truncate block text-fg-muted text-xs">{{ authorName }}</p>
            <p class="text-xxs text-fg-muted">{{ itemDuration }}</p>
            <!-- M3 expressive progress chip - matches list & home shelf cards -->
            <div v-if="showProgressChip" class="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full bg-tertiary-container text-on-tertiary-container" style="font-size: 0.65rem">
              <span class="material-symbols" style="font-size: 0.85rem">{{ userIsFinished ? 'check_circle' : 'schedule' }}</span>
              <span class="font-semibold leading-none">{{ progressChipLabel }}</span>
            </div>
          </div>
        </div>
        <div class="w-10 min-w-10 flex justify-center">
          <button v-if="showPlayBtn" type="button" class="material-3-play-button w-10 h-10 rounded-full flex items-center justify-center shadow-elevation-2 transition-all duration-200 ease-expressive" :class="playerIsStartingForThisMedia ? 'bg-surface-variant' : 'bg-primary'" @click.stop.prevent="playClick">
            <span v-if="!playerIsStartingForThisMedia" class="material-symbols text-2xl fill text-on-primary">{{ streamIsPlaying ? 'pause' : 'play_arrow' }}</span>
            <svg v-else class="animate-spin text-on-surface-variant" style="width: 18px; height: 18px" viewBox="0 0 24 24">
              <path fill="currentColor" d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" />
            </svg>
          </button>
        </div>
        <div class="w-8 min-w-8 flex justify-center">
          <button class="w-8 h-8 rounded-full flex items-center justify-center" @click.stop.prevent="showMore">
            <span class="material-symbols text-2xl text-on-surface">more_vert</span>
          </button>
        </div>
      </nuxt-link>
      <!-- Bottom progress bar uses M3 primary/tertiary tokens to match LazyListBookCard -->
      <div v-if="progressPercent > 0" class="absolute bottom-0 left-0 h-1 z-10 transition-all duration-300 ease-expressive" :class="userIsFinished ? 'bg-tertiary' : 'bg-primary'" :style="{ width: progressPercent * 100 + '%' }"></div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    playlistId: String,
    item: {
      type: Object,
      default: () => {}
    }
  },
  data() {
    return {}
  },
  computed: {
    itemUrl() {
      if (this.episodeId) return `/item/${this.libraryItem.id}/${this.episodeId}`
      return `/item/${this.libraryItem.id}`
    },
    libraryItem() {
      return this.item.libraryItem || {}
    },
    localLibraryItem() {
      return this.item.localLibraryItem
    },
    episode() {
      return this.item.episode
    },
    episodeId() {
      return this.episode?.id || null
    },
    localEpisode() {
      return this.item.localEpisode
    },
    media() {
      return this.libraryItem.media || {}
    },
    mediaMetadata() {
      return this.media.metadata || {}
    },
    mediaType() {
      return this.libraryItem.mediaType
    },
    isPodcast() {
      return this.mediaType === 'podcast'
    },
    tracks() {
      if (this.episode) return []
      return this.media.tracks || []
    },
    itemTitle() {
      if (this.episode) return this.episode.title
      return this.mediaMetadata.title || ''
    },
    bookAuthors() {
      if (this.episode) return []
      return this.mediaMetadata.authors || []
    },
    bookAuthorName() {
      return this.bookAuthors.map((au) => au.name).join(', ')
    },
    authorName() {
      if (this.episode) return this.mediaMetadata.author
      return this.bookAuthorName
    },
    itemDuration() {
      if (this.episode) return this.$elapsedPretty(this.episode.duration)
      return this.$elapsedPretty(this.media.duration)
    },
    isMissing() {
      return this.libraryItem.isMissing
    },
    isInvalid() {
      return this.libraryItem.isInvalid
    },
    bookCoverAspectRatio() {
      return this.$store.getters['libraries/getBookCoverAspectRatio']
    },
    coverWidth() {
      return 50
    },
    showPlayBtn() {
      return !this.isMissing && !this.isInvalid && (this.tracks.length || this.episode)
    },
    isOpenInPlayer() {
      if (this.localLibraryItem && this.localEpisode && this.$store.getters['getIsMediaStreaming'](this.localLibraryItem.id, this.localEpisode.id)) return true
      return this.$store.getters['getIsMediaStreaming'](this.libraryItem.id, this.episodeId)
    },
    streamIsPlaying() {
      return this.$store.state.playerIsPlaying && this.isOpenInPlayer
    },
    playerIsStartingPlayback() {
      // Play has been pressed and waiting for native play response
      return this.$store.state.playerIsStartingPlayback
    },
    playerIsStartingForThisMedia() {
      const mediaId = this.$store.state.playerStartingPlaybackMediaId
      if (!mediaId) return false

      let thisMediaId = this.episodeId || this.libraryItem.id
      return mediaId === thisMediaId
    },
    userItemProgress() {
      return this.$store.getters['user/getUserMediaProgress'](this.libraryItem.id, this.episodeId)
    },
    userIsFinished() {
      return !!this.userItemProgress?.isFinished
    },
    progressPercent() {
      return Math.max(Math.min(1, this.userItemProgress?.progress || 0), 0)
    },
    userTimeRemaining() {
      const duration = this.episode ? this.episode.duration : this.media.duration
      if (!duration) return 0
      const remaining = duration * (1 - this.progressPercent)
      return remaining > 0 ? remaining : 0
    },
    showProgressChip() {
      if (this.userIsFinished) return true
      return this.progressPercent > 0
    },
    progressChipLabel() {
      if (this.userIsFinished) return this.$strings?.LabelFinished || 'Finished'
      const remaining = this.userTimeRemaining
      if (!remaining) return ''
      const pretty = this.$elapsedPretty ? this.$elapsedPretty(remaining) : ''
      if (this.$getString && this.$strings?.LabelTimeRemaining) return this.$getString('LabelTimeRemaining', [pretty])
      return pretty
    }
  },
  methods: {
    showMore() {
      const playlistItem = {
        libraryItem: this.libraryItem,
        episode: this.episode
      }
      if (this.localLibraryItem) {
        playlistItem.libraryItem.localLibraryItem = this.localLibraryItem
      }
      if (this.localEpisode && playlistItem.episode) {
        playlistItem.episode.localEpisode = this.localEpisode
      }
      this.$emit('showMore', playlistItem)
    },
    async playClick() {
      if (this.playerIsStartingPlayback) return

      await this.$hapticsImpact()
      let mediaId = this.episodeId || this.libraryItem.id
      if (this.streamIsPlaying) {
        this.$eventBus.$emit('pause-item')
      } else if (this.localLibraryItem) {
        this.$store.commit('setPlayerIsStartingPlayback', mediaId)
        this.$eventBus.$emit('play-item', {
          libraryItemId: this.localLibraryItem.id,
          episodeId: this.localEpisode?.id,
          serverLibraryItemId: this.libraryItem.id,
          serverEpisodeId: this.episodeId
        })
      } else {
        this.$store.commit('setPlayerIsStartingPlayback', mediaId)
        this.$eventBus.$emit('play-item', {
          libraryItemId: this.libraryItem.id,
          episodeId: this.episodeId
        })
      }
    }
  },
  mounted() {}
}
</script>

<style>
.item-table-content {
  width: calc(100% - 114px);
  max-width: calc(100% - 114px);
}
</style>
