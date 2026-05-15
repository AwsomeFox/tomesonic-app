<template>
  <div class="w-full h-full py-4 px-4 overflow-y-auto downloads-scroll-container">
    <p class="px-2 mb-2 text-title-medium text-on-surface-variant">{{ $strings.HeaderDownloads }} ({{ localLibraryItems.length }})</p>

    <div v-if="localLibraryItems.length" class="downloads-card">
      <template v-for="(mediaItem, num) in localLibraryItems">
        <nuxt-link :key="mediaItem.id" :to="`/localMedia/item/${mediaItem.id}`" class="downloads-row state-layer">
          <div class="downloads-cover flex-none relative">
            <img v-if="mediaItem.coverPathSrc" :src="mediaItem.coverPathSrc" class="w-full h-full object-cover" />
            <div v-else class="w-full h-full flex items-center justify-center bg-primary">
              <span class="material-symbols text-on-primary">book</span>
            </div>
          </div>
          <div class="flex-grow min-w-0 pl-3 pr-2">
            <p class="truncate text-on-surface text-body-medium font-medium">{{ mediaItem.media.metadata.title }}</p>
            <p v-if="mediaItem.mediaType == 'book'" class="truncate text-on-surface-variant text-body-small">
              {{ mediaItem.media.tracks.length }} {{ $strings.LabelTracks }}<span v-if="mediaItem.size"> · {{ $bytesPretty(mediaItem.size) }}</span>
            </p>
            <p v-else-if="mediaItem.mediaType == 'podcast'" class="truncate text-on-surface-variant text-body-small">
              {{ mediaItem.media.episodes.length }} {{ $strings.HeaderEpisodes }}<span v-if="mediaItem.size"> · {{ $bytesPretty(mediaItem.size) }}</span>
            </p>
            <p v-else-if="mediaItem.size" class="truncate text-on-surface-variant text-body-small">{{ $bytesPretty(mediaItem.size) }}</p>
          </div>
          <div class="w-8 h-8 flex items-center justify-center flex-none">
            <span class="material-symbols text-on-surface-variant">chevron_right</span>
          </div>
        </nuxt-link>
      </template>
    </div>
    <div v-if="localLibraryItems.length" class="mt-3 px-2 text-body-small text-on-surface-variant">{{ $strings.LabelTotalSize }}: {{ $bytesPretty(localLibraryItems.reduce((acc, item) => acc + item.size, 0)) }}</div>
  </div>
</template>

<script>
import { Capacitor } from '@capacitor/core'

export default {
  data() {
    return {
      localLibraryItems: []
    }
  },
  methods: {
    getSize(item) {
      if (!item || !item.localFiles) return 0
      let size = 0
      for (let i = 0; i < item.localFiles.length; i++) {
        size += item.localFiles[i].size
      }
      return size
    },
    newLocalLibraryItem(item) {
      if (!item) return
      const itemIndex = this.localLibraryItems.findIndex((li) => li.id === item.id)
      const newItemObj = {
        ...item,
        size: this.getSize(item),
        coverPathSrc: item.coverContentUrl ? Capacitor.convertFileSrc(item.coverContentUrl) : null
      }
      if (itemIndex >= 0) {
        this.localLibraryItems.splice(itemIndex, 1, newItemObj)
      } else {
        this.localLibraryItems.push(newItemObj)
      }
    },
    async init() {
      var items = (await this.$db.getLocalLibraryItems()) || []
      this.localLibraryItems = items.map((lmi) => {
        return {
          ...lmi,
          size: this.getSize(lmi),
          coverPathSrc: lmi.coverContentUrl ? Capacitor.convertFileSrc(lmi.coverContentUrl) : null
        }
      })
    }
  },
  mounted() {
    this.$eventBus.$on('new-local-library-item', this.newLocalLibraryItem)
    this.init()
  },
  beforeDestroy() {
    this.$eventBus.$off('new-local-library-item', this.newLocalLibraryItem)
  }
}
</script>

<style scoped>
.downloads-scroll-container {
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}
.downloads-card {
  background-color: rgb(var(--md-sys-color-surface-container));
  border-radius: 24px;
  overflow: hidden;
}
.downloads-row {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  min-height: 72px;
  text-decoration: none;
}
.downloads-row + .downloads-row {
  border-top: 1px solid rgb(var(--md-sys-color-outline-variant) / 0.5);
}
.downloads-cover {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  overflow: hidden;
  background-color: rgb(var(--md-sys-color-surface-variant));
}
</style>

