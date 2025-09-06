<template>
  <modals-modal v-model="show" :width="300" height="100%">
    <template #outer>
      <div class="absolute top-10 left-4 z-40" style="max-width: 80%">
        <p class="text-on-surface text-lg truncate">{{ $strings.HeaderSelectDownloadLocation }}</p>
      </div>
    </template>

    <div class="w-full h-full overflow-hidden absolute top-0 left-0 flex items-center justify-center" @click="show = false">
      <div ref="container" class="w-full overflow-x-hidden overflow-y-auto bg-surface rounded-lg border border-outline-variant shadow-elevation-4 backdrop-blur-md" style="max-height: 75%" @click.stop>
        <ul class="h-full w-full" role="listbox" aria-labelledby="listbox-label">
          <template v-for="folder in localFolders">
            <li :key="folder.id" :id="`folder-${folder.id}`" class="text-on-surface hover:bg-surface-container transition-colors duration-200 select-none relative py-5 cursor-pointer" role="option" @click="clickedOption(folder)">
              <div class="relative flex items-center pl-3" style="padding-right: 4.5rem">
                <span class="material-symbols text-xl mr-2 text-on-surface-variant">folder</span>
                <p class="font-normal block truncate text-sm">{{ folder.name }}</p>
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
