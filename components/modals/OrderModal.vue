<template>
  <modals-modal v-model="show" width="90%">
    <div class="w-full h-full bg-surface-container-high rounded-3xl border border-outline-variant border-opacity-40 shadow-elevation-4 overflow-hidden">
      <div class="px-6 pt-5 pb-3 flex items-center">
        <span class="material-symbols text-on-surface mr-3" style="font-size: 24px">swap_vert</span>
        <h2 class="text-headline-small text-on-surface font-medium flex-grow">{{ $strings.LabelSortBy || 'Sort by' }}</h2>
      </div>
      <ul class="w-full px-2 pb-3 flex flex-col gap-1 text-base" role="listbox" aria-labelledby="listbox-label">
        <template v-for="item in items">
          <li :key="item.value" class="text-on-surface select-none relative py-3 px-3 pr-12 rounded-2xl cursor-pointer state-layer" :class="item.value === selected ? 'bg-primary-container text-on-primary-container' : ''" role="option" @click="clickedOption(item.value)">
            <div class="flex items-center">
              <span class="font-normal block truncate text-base">{{ item.text }}</span>
            </div>
            <span v-if="item.value === selected" class="absolute inset-y-0 right-0 flex items-center pr-4 text-on-primary-container">
              <span class="material-symbols" style="font-size: 22px">{{ descending ? 'south' : 'north' }}</span>
            </span>
          </li>
        </template>
      </ul>
    </div>
  </modals-modal>
</template>

<script>
export default {
  props: {
    value: Boolean,
    orderBy: String,
    descending: Boolean,
    episodes: Boolean,
    customItems: {
      type: Array,
      default: null
    }
  },
  data() {
    return {
      bookItems: [
        {
          text: this.$strings.LabelTitle,
          value: 'media.metadata.title'
        },
        {
          text: this.$strings.LabelAuthorFirstLast,
          value: 'media.metadata.authorName'
        },
        {
          text: this.$strings.LabelAuthorLastFirst,
          value: 'media.metadata.authorNameLF'
        },
        {
          text: this.$strings.LabelPublishYear,
          value: 'media.metadata.publishedYear'
        },
        {
          text: this.$strings.LabelAddedAt,
          value: 'addedAt'
        },
        {
          text: this.$strings.LabelSize,
          value: 'size'
        },
        {
          text: this.$strings.LabelDuration,
          value: 'media.duration'
        },
        {
          text: this.$strings.LabelFileBirthtime,
          value: 'birthtimeMs'
        },
        {
          text: this.$strings.LabelFileModified,
          value: 'mtimeMs'
        },
        {
          text: this.$strings.LabelRandomly,
          value: 'random'
        }
      ],
      podcastItems: [
        {
          text: this.$strings.LabelTitle,
          value: 'media.metadata.title'
        },
        {
          text: this.$strings.LabelAuthor,
          value: 'media.metadata.author'
        },
        {
          text: this.$strings.LabelAddedAt,
          value: 'addedAt'
        },
        {
          text: this.$strings.LabelSize,
          value: 'size'
        },
        {
          text: this.$strings.LabelNumberOfEpisodes,
          value: 'media.numTracks'
        },
        {
          text: this.$strings.LabelFileBirthtime,
          value: 'birthtimeMs'
        },
        {
          text: this.$strings.LabelFileModified,
          value: 'mtimeMs'
        },
        {
          text: this.$strings.LabelRandomly,
          value: 'random'
        }
      ],
      episodeItems: [
        {
          text: this.$strings.LabelPubDate,
          value: 'publishedAt'
        },
        {
          text: this.$strings.LabelTitle,
          value: 'title'
        },
        {
          text: this.$strings.LabelSeason,
          value: 'season'
        },
        {
          text: this.$strings.LabelEpisode,
          value: 'episode'
        },
        {
          text: this.$strings.LabelFilename,
          value: 'audioFile.metadata.filename'
        }
      ]
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
    selected: {
      get() {
        return this.orderBy
      },
      set(val) {
        this.$emit('update:orderBy', val)
      }
    },
    selectedDesc: {
      get() {
        return this.descending
      },
      set(val) {
        this.$emit('update:descending', val)
      }
    },
    isPodcast() {
      return this.$store.getters['libraries/getCurrentLibraryMediaType'] === 'podcast'
    },
    items() {
      if (this.customItems && this.customItems.length) return this.customItems
      if (this.episodes) return this.episodeItems
      if (this.isPodcast) return this.podcastItems
      return this.bookItems
    }
  },
  methods: {
    async clickedOption(val) {
      await this.$hapticsImpact()
      if (this.selected === val) {
        this.selectedDesc = !this.selectedDesc
      } else {
        if (val === 'recent' || val === 'addedAt') this.selectedDesc = true // Progress defaults to descending
        this.selected = val
      }
      this.$nextTick(() => this.$emit('change', val))
    }
  },
  mounted() {}
}
</script>
