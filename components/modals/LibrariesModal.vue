<template>
  <modals-modal v-model="show" :width="300" :processing="processing" height="100%">
    <div class="w-full h-full overflow-hidden absolute top-0 left-0 flex items-center justify-center" data-modal-backdrop>
      <div class="w-full overflow-x-hidden overflow-y-auto bg-surface-container-high rounded-3xl border border-outline-variant border-opacity-40 shadow-elevation-4" style="max-height: 75%">
        <!-- Material 3 Modal Header -->
        <div class="px-6 pt-5 pb-3">
          <div class="w-full flex items-center">
            <span class="material-symbols text-on-surface mr-3" style="font-size: 24px">library_books</span>
            <h2 class="text-headline-small text-on-surface font-medium flex-grow">{{ $strings.HeaderLibraries }}</h2>
          </div>
        </div>

        <ul class="h-full w-full px-2 pb-3 flex flex-col gap-1" role="listbox" aria-labelledby="listbox-label">
          <template v-for="library in libraries">
            <li :key="library.id" class="text-on-surface select-none relative py-3 px-3 rounded-2xl cursor-pointer state-layer" :class="currentLibraryId === library.id ? 'bg-primary-container text-on-primary-container' : ''" role="option" @click="clickedOption(library)">
              <div class="flex items-center">
                <ui-library-icon :icon="library.icon" />
                <span class="font-normal block truncate text-lg ml-4">{{ library.name }}</span>
                <span v-if="currentLibraryId === library.id" class="material-symbols ml-auto text-on-primary-container" style="font-size: 22px">check</span>
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
      processing: false
    }
  },
  computed: {
    show: {
      get() {
        return this.$store.state.libraries.showModal
      },
      set(val) {
        this.$store.commit('libraries/setShowModal', val)
      }
    },
    currentLibraryId() {
      return this.$store.state.libraries.currentLibraryId
    },
    libraries() {
      return this.$store.state.libraries.libraries
    }
  },
  methods: {
    async clickedOption(lib) {
      await this.$hapticsImpact()
      this.show = false
      if (lib.id === this.currentLibraryId) return
      await this.$store.dispatch('libraries/fetch', lib.id)
      this.$eventBus.$emit('library-changed', lib.id)
      this.$localStore.setLastLibraryId(lib.id)
    }
  },
  mounted() {}
}
</script>
