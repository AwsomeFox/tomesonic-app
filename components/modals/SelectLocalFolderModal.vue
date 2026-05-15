<template>
  <modals-modal v-model="show" :width="300" height="100%">
    <div class="w-full h-full overflow-hidden absolute top-0 left-0 flex items-center justify-center" data-modal-backdrop>
      <div ref="container" class="w-full overflow-x-hidden overflow-y-auto bg-surface-container-high rounded-3xl border border-outline-variant border-opacity-40 shadow-elevation-4" style="max-height: 75%">
        <!-- Material 3 Modal Header -->
        <div class="px-6 pt-5 pb-3">
          <div class="w-full flex items-center">
            <span class="material-symbols text-on-surface mr-3" style="font-size: 24px">folder_open</span>
            <h2 class="text-headline-small text-on-surface font-medium flex-grow">{{ $strings.HeaderSelectDownloadLocation }}</h2>
          </div>
        </div>

        <ul class="h-full w-full px-2 pb-3 flex flex-col gap-1" role="listbox" aria-labelledby="listbox-label">
          <template v-for="folder in localFolders">
            <li :key="folder.id" :id="`folder-${folder.id}`" class="text-on-surface select-none relative py-4 px-3 rounded-2xl cursor-pointer state-layer" role="option" @click="clickedOption(folder)">
              <div class="flex items-center">
                <span class="material-symbols mr-3 text-on-surface-variant" style="font-size: 22px">folder</span>
                <p class="font-normal block truncate text-base">{{ folder.name }}</p>
              </div>
            </li>
          </template>
        </ul>
      </div>
    </div>
  </modals-modal>
</template>

<script>
export default {
  data() {
    return {
      localFolders: []
    }
  },
  watch: {
    show(newVal) {
      if (newVal) {
        this.$nextTick(this.init)
      }
    }
  },
  computed: {
    show: {
      get() {
        return this.$store.state.globals.showSelectLocalFolderModal
      },
      set(val) {
        this.$store.commit('globals/setShowSelectLocalFolderModal', val)
      }
    },
    modalData() {
      return this.$store.state.globals.localFolderSelectData || {}
    },
    callback() {
      return this.modalData.callback
    },
    mediaType() {
      return this.modalData.mediaType
    }
  },
  methods: {
    clickedOption(folder) {
      this.show = false
      if (!this.callback) {
        console.error('Callback not set')
        return
      }
      this.callback(folder)
    },
    async init() {
      const localFolders = (await this.$db.getLocalFolders()) || []

      if (!localFolders.some((lf) => lf.id === `internal-${this.mediaType}`)) {
        localFolders.push({
          id: `internal-${this.mediaType}`,
          name: this.$strings.LabelInternalAppStorage,
          mediaType: this.mediaType
        })
      }
      this.localFolders = localFolders.filter((lf) => lf.mediaType == this.mediaType)
    }
  },
  mounted() {}
}
</script>
