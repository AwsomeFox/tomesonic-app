<template>
  <modals-modal v-model="show" :width="400" height="100%">
    <div class="w-full h-full overflow-hidden absolute top-0 left-0 flex items-center justify-center" data-modal-backdrop>
      <div class="w-full overflow-x-hidden overflow-y-auto bg-surface-container-high rounded-3xl border border-outline-variant border-opacity-40 shadow-elevation-4" style="max-height: 75%">
        <!-- Material 3 Modal Header -->
        <div class="px-6 pt-5 pb-3">
          <div class="w-full flex items-center">
            <span class="material-symbols text-on-surface mr-3" style="font-size: 24px">info</span>
            <h2 class="text-headline-small text-on-surface font-medium flex-grow">{{ $strings.HeaderDetails }}</h2>
          </div>
        </div>

        <div class="px-6 pb-5">
          <p class="mb-2 text-body-large text-on-surface">{{ mediaMetadata.title }}</p>

          <div v-if="size" class="text-body-medium mb-2 text-on-surface-variant">{{ $strings.LabelSize }}: {{ $bytesPretty(size) }}</div>

          <p class="mb-1 text-body-small text-on-surface-variant">ID: {{ _libraryItem.id }}</p>
        </div>
      </div>
    </div>
  </modals-modal>
</template>

<script>
export default {
  props: {
    value: Boolean,
    libraryItem: {
      type: Object,
      default: () => {}
    }
  },
  data() {
    return {}
  },
  computed: {
    show: {
      get() {
        return this.value
      },
      set(val) {
        this.$emit('input', val)
      }
    },
    _libraryItem() {
      return this.libraryItem || {}
    },
    media() {
      return this._libraryItem.media || {}
    },
    mediaMetadata() {
      return this.media.metadata || {}
    },
    size() {
      return this.media.size
    }
  },
  methods: {},
  mounted() {}
}
</script>
