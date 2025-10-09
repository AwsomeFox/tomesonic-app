<template>
  <div class="w-full h-full py-6 px-4 overflow-y-auto" :style="contentPaddingStyle">
    <div class="flex items-center justify-between mb-4">
      <p class="text-base text-fg">{{ $strings.HeaderDownloads }} ({{ downloadItems.length }})</p>
      <button v-if="downloadItems.length" @click="cancelAllDownloads" class="px-3 py-1.5 bg-error text-on-error rounded-md text-sm font-medium hover:bg-error/90 transition-colors">Cancel All</button>
    </div>

    <div v-if="!downloadItems.length" class="py-6 text-center text-lg text-fg-muted">No active downloads</div>

    <template v-for="(downloadItem, itemIndex) in downloadItems">
      <div :key="downloadItem.id" class="w-full mb-4">
        <div class="flex items-center justify-between mb-2">
          <div class="flex-grow min-w-0 mr-3">
            <p class="text-sm font-medium text-fg truncate">{{ downloadItem.itemTitle }}</p>
            <p class="text-xs text-fg-muted">{{ downloadItem.downloadItemParts.length }} {{ downloadItem.downloadItemParts.length === 1 ? 'file' : 'files' }}</p>
          </div>
          <button @click="cancelDownload(downloadItem)" class="px-3 py-1.5 bg-error/10 text-error rounded-md text-sm font-medium hover:bg-error/20 transition-colors flex-shrink-0">Cancel</button>
        </div>

        <div class="space-y-2">
          <template v-for="itemPart in downloadItem.downloadItemParts">
            <div :key="itemPart.id" class="flex items-center">
              <div class="w-12 flex-shrink-0">
                <span v-if="itemPart.completed" class="material-symbols text-success text-xl">check_circle</span>
                <span v-else-if="itemPart.failed" class="material-symbols text-error text-xl">error</span>
                <span v-else class="text-xs font-semibold text-fg">{{ Math.round(itemPart.progress) }}%</span>
              </div>
              <div class="flex-grow px-2 min-w-0">
                <p class="text-xs truncate text-fg-muted">{{ itemPart.filename }}</p>
              </div>
            </div>
          </template>
        </div>

        <div v-if="itemIndex + 1 < downloadItems.length" class="border-t border-border mt-4" />
      </div>
    </template>
  </div>
</template>

<script>
export default {
  data() {
    return {
      cancelling: false
    }
  },
  computed: {
    downloadItems() {
      return this.$store.state.globals.itemDownloads
    },
    downloadItemParts() {
      let parts = []
      this.downloadItems.forEach((di) => parts.push(...di.downloadItemParts))
      return parts
    },
    contentPaddingStyle() {
      return this.$store.getters['getIsPlayerOpen'] ? { paddingBottom: '120px' } : {}
    }
  },
  methods: {
    async cancelDownload(downloadItem) {
      if (this.cancelling) return

      const confirmed = await this.$confirmDialog({
        title: 'Cancel Download',
        message: `Are you sure you want to cancel downloading "${downloadItem.itemTitle}"?`,
        okText: 'Cancel Download',
        cancelText: 'Keep Downloading'
      })

      if (!confirmed) return

      this.cancelling = true
      try {
        const libraryItemId = downloadItem.libraryItemId
        const episodeId = downloadItem.episodeId || null

        console.log('Cancelling download:', libraryItemId, episodeId)
        await this.$nativePlugin.cancelDownload({
          libraryItemId,
          episodeId
        })
        this.$toast.success('Download cancelled')
      } catch (error) {
        console.error('Failed to cancel download:', error)
        this.$toast.error('Failed to cancel download')
      }
      this.cancelling = false
    },
    async cancelAllDownloads() {
      if (this.cancelling) return

      const confirmed = await this.$confirmDialog({
        title: 'Cancel All Downloads',
        message: `Are you sure you want to cancel all ${this.downloadItems.length} active downloads?`,
        okText: 'Cancel All',
        cancelText: 'Keep Downloading'
      })

      if (!confirmed) return

      this.cancelling = true
      try {
        console.log('Cancelling all downloads')
        await this.$nativePlugin.cancelAllDownloads()
        this.$toast.success('All downloads cancelled')
      } catch (error) {
        console.error('Failed to cancel downloads:', error)
        this.$toast.error('Failed to cancel downloads')
      }
      this.cancelling = false
    }
  },
  mounted() {},
  beforeDestroy() {}
}
</script>

