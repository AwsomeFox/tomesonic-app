<template>
  <modals-modal v-model="show" :width="400" height="100%">
    <div class="w-full h-full overflow-hidden absolute top-0 left-0 flex items-center justify-center" data-modal-backdrop>
      <div ref="container" class="w-full overflow-x-hidden overflow-y-auto bg-surface-container-high rounded-3xl border border-outline-variant border-opacity-40 shadow-elevation-4" style="max-height: 75%">
        <!-- Material 3 Modal Header -->
        <div v-if="currentChapter" class="px-6 pt-5 pb-3">
          <div class="w-full flex items-center">
            <span class="material-symbols text-on-surface mr-3" style="font-size: 24px">format_list_numbered</span>
            <h2 class="text-headline-small text-on-surface font-medium flex-grow">{{ chapters.length }} {{ $strings.LabelChapters }}</h2>
          </div>
        </div>

        <ul class="h-full w-full px-2 pb-3 flex flex-col gap-1" role="listbox" aria-labelledby="listbox-label">
          <template v-for="chapter in chapters">
            <li :key="chapter.id" :id="`chapter-row-${chapter.id}`" class="text-on-surface select-none relative py-3 px-3 rounded-2xl cursor-pointer state-layer" :class="currentChapterId === chapter.id ? 'bg-primary-container text-on-primary-container' : ''" role="option" @click="clickedOption(chapter)">
              <div class="relative flex items-center pr-16">
                <span v-if="currentChapterId === chapter.id" class="material-symbols mr-2 text-on-primary-container" style="font-size: 20px">play_arrow</span>
                <p class="font-normal block truncate text-sm">{{ chapter.title }}</p>
                <div class="absolute right-0 top-1/2 -translate-y-1/2">
                  <span class="font-mono leading-3 text-sm" :class="currentChapterId === chapter.id ? 'text-on-primary-container' : 'text-on-surface-variant'" style="letter-spacing: -0.5px">{{ $secondsToTimestamp(chapter.start / _playbackRate) }}</span>
                </div>
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
  props: {
    value: Boolean,
    chapters: {
      type: Array,
      default: () => []
    },
    currentChapter: {
      type: Object,
      default: () => null
    },
    playbackRate: Number
  },
  data() {
    return {}
  },
  watch: {
    value(newVal) {
      if (newVal) {
        this.$nextTick(this.scrollToChapter)
      }
    }
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
    _playbackRate() {
      if (!this.playbackRate || isNaN(this.playbackRate)) return 1
      return this.playbackRate
    },
    currentChapterId() {
      return this.currentChapter?.id
    },
    currentChapterTitle() {
      return this.currentChapter?.title || null
    }
  },
  methods: {
    clickedOption(chapter) {
      this.$emit('select', chapter)
    },
    scrollToChapter() {
      if (!this.currentChapterId) return

      const container = this.$refs.container
      if (container) {
        const currChapterEl = document.getElementById(`chapter-row-${this.currentChapterId}`)
        if (currChapterEl) {
          const offsetTop = currChapterEl.offsetTop
          const containerHeight = container.clientHeight
          container.scrollTo({ top: offsetTop - containerHeight / 2 })
        }
      }
    }
  },
  mounted() {}
}
</script>
