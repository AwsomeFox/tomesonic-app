<template>
  <div class="author-card-root">
    <div class="author-card state-layer" :style="{ width: width + 'px', height: width + 'px' }" @click="clickCard">
      <div class="author-image-container" :class="{ 'image-only': nameBelow }">
        <div v-show="author && !imageReady && !hasCoverCollage" class="author-placeholder">
          <span class="material-symbols text-on-surface-variant" :style="{ fontSize: sizeMultiplier * 2.25 + 'rem' }">person</span>
        </div>

        <div v-if="hasCoverCollage" class="author-collage" :class="`count-${Math.min(coverBookItems.length, 4)}`">
          <img v-for="(book, idx) in coverBookItems.slice(0, 4)" :key="book.id || idx" :src="coverSrcFor(book)" class="author-collage-item" />
        </div>

        <covers-author-image v-if="author && showImage && authorId && !hasCoverCollage" :author="author" rounded="none" class="w-full h-full transition-opacity duration-200" :style="{ opacity: imageReady ? 1 : 0 }" @imageLoaded="imageLoaded" />
      </div>

      <div v-if="!searching && !nameBelow" class="author-meta">
        <p class="author-name" :style="{ fontSize: sizeMultiplier * 0.8 + 'rem' }">
          <span class="author-name-text">{{ name }}</span>
        </p>
        <p class="author-books" :style="{ fontSize: sizeMultiplier * 0.7 + 'rem' }">
          <span class="material-symbols text-label-small mr-1">menu_book</span>
          <span class="author-books-text">{{ numBooks }} {{ $strings.LabelBooks }}</span>
        </p>
      </div>

      <div v-show="searching" class="author-loading-overlay">
        <widgets-loading-spinner size="" />
      </div>
    </div>

    <div v-show="nameBelow" class="w-full py-2 px-2">
      <p class="text-center font-semibold truncate text-on-surface" :style="{ fontSize: sizeMultiplier * 0.75 + 'rem' }">{{ name }}</p>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    author: {
      type: Object,
      default: () => {}
    },
    width: Number,
    height: Number,
    sizeMultiplier: {
      type: Number,
      default: 1
    },
    nameBelow: Boolean,
    navigationMode: {
      type: String,
      default: 'library-filter-author'
    },
    showImage: {
      type: Boolean,
      default: true
    }
  },
  data() {
    return {
      searching: false,
      imageReady: false
    }
  },
  computed: {
    _author() {
      return this.author || {}
    },
    authorId() {
      return this._author.id
    },
    name() {
      return this._author.name || ''
    },
    coverBookItems() {
      if (Array.isArray(this._author.coverBooks) && this._author.coverBooks.length) {
        return this._author.coverBooks.slice(0, 4)
      }
      if (Array.isArray(this._author.books) && this._author.books.length) {
        return this._author.books.slice(0, 4)
      }
      return []
    },
    hasCoverCollage() {
      return this.coverBookItems.length > 0
    },
    numBooks() {
      const parsed = Number(this._author.numBooks)
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed
      }
      return this.coverBookItems.length || 0
    }
  },
  methods: {
    imageLoaded() {
      this.imageReady = true
    },
    coverSrcFor(book) {
      return this.$store.getters['globals/getLibraryItemCoverSrc'](book, '')
    },
    clickCard() {
      if (!this.author) return

      if (this.navigationMode === 'author-detail') {
        if (!this.authorId) return
        const encodedAuthorId = encodeURIComponent(String(this.authorId))
        this.$router.push({
          path: `/bookshelf/author/${encodedAuthorId}`,
          query: this.name ? { name: this.name } : {}
        })
        return
      }

      if (this.navigationMode === 'narrator-detail') {
        if (!this.name) return
        const encodedNarratorName = encodeURIComponent(this.$encode(this.name))
        this.$router.push({
          path: `/bookshelf/narrator/${encodedNarratorName}`,
          query: { name: this.name }
        })
        return
      }

      if (!this.authorId) return
      this.$router.push(`/bookshelf/library?filter=authors.${this.$encode(this.authorId)}`)
    }
  },
  watch: {
    authorId() {
      this.imageReady = this.hasCoverCollage
    },
    hasCoverCollage: {
      immediate: true,
      handler(newVal) {
        if (newVal) {
          this.imageReady = true
        } else {
          this.imageReady = false
        }
      }
    }
  },
  mounted() {}
}
</script>

<style scoped>
.author-card-root {
  width: fit-content;
}

.author-card {
  position: relative;
  display: block;
  border-radius: 16px;
  overflow: hidden;
  cursor: pointer;
  background-color: rgb(var(--md-sys-color-surface-container));
  border: 1px solid rgba(var(--md-sys-color-outline-variant), 0.35);
  box-shadow: var(--md-sys-elevation-level1);
  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1), box-shadow 180ms cubic-bezier(0.2, 0, 0, 1);
}

.author-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--md-sys-elevation-level2);
}

.author-card:active {
  transform: translateY(0);
}

.author-image-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: rgb(var(--md-sys-color-surface-container));
}

.author-image-container.image-only {
  border-radius: 16px;
}

.author-placeholder {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(var(--md-sys-color-surface-container));
}

.author-collage {
  position: absolute;
  inset: 0;
  display: grid;
}

.author-collage.count-1 {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
}

.author-collage.count-2 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr;
}

.author-collage.count-3,
.author-collage.count-4 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}

.author-collage.count-3 .author-collage-item:nth-child(3) {
  grid-column: 1 / span 2;
}

.author-collage-item {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
}

.author-meta {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px 12px;
  background: transparent;
  isolation: isolate;
}

.author-meta::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  background: linear-gradient(180deg, rgba(var(--md-sys-color-surface-container), 0) 2%, rgba(var(--md-sys-color-surface-container), 0.9) 50%, rgba(var(--md-sys-color-surface-container-high), 0.99) 100%);
  backdrop-filter: blur(10px) brightness(0.62) saturate(0.82);
  -webkit-backdrop-filter: blur(10px) brightness(0.62) saturate(0.82);
}

.author-meta > * {
  position: relative;
  z-index: 1;
}

.author-name {
  font-weight: 600;
  color: rgb(var(--md-sys-color-on-media));
  line-height: 1.2;
  margin: 0;
  padding-left: 3px;
  padding-right: 3px;
}

.author-name-text {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 16px;
  padding-right: 16px;
  margin-left: -13px;
  margin-right: -13px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.9));
}

.author-books {
  display: flex;
  align-items: center;
  color: rgb(var(--md-sys-color-on-media-variant));
  font-weight: 500;
  line-height: 1.2;
  margin: 0;
  min-width: 0;
  padding-left: 3px;
  padding-right: 3px;
}

.author-books .material-symbols {
  flex: 0 0 auto;
  color: inherit;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.85));
}

.author-books-text {
  display: block;
  max-width: 100%;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 16px;
  padding-right: 16px;
  margin-left: -13px;
  margin-right: -13px;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.85));
}

.author-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--md-sys-color-surface-container), 0.7);
  backdrop-filter: blur(2px);
}
</style>
