import Vue from 'vue'
import LazyListBookCard from '@/components/cards/LazyListBookCard'
import LazySeriesCard from '@/components/cards/LazySeriesCard'

export default {
  data() {
    return {
      cardsHelpers: {
        mountEntityCard: this.mountEntityCard
      }
    }
  },
  methods: {
    getComponentClass() {
      if (this.entityName === 'series' && !this.showBookshelfListView) {
        return Vue.extend(LazySeriesCard)
      }
      return Vue.extend(LazyListBookCard)
    },
    async mountEntityCard(index, retries = 0) {
      var shelf = Math.floor(index / this.entitiesPerShelf)
      var shelfEl = document.getElementById(`shelf-${shelf}`)
      if (!shelfEl) {
        if (retries < 15) {
          setTimeout(() => this.mountEntityCard(index, retries + 1), 16)
          return
        }
        console.error('mount entity card invalid shelf', shelf, 'book index', index)
        return
      }
      this.entityIndexesMounted.push(index)
      if (this.entityComponentRefs[index]) {
        var bookComponent = this.entityComponentRefs[index]
        shelfEl.appendChild(bookComponent.$el)
        if (bookComponent.setSelectionMode) bookComponent.setSelectionMode(false)
        bookComponent.isHovering = false
        return
      }
      var shelfOffsetX = 0
      var shelfOffsetY = 0

      if (this.showBookshelfListView) {
        // Center wide list rows within the shelf container.
        var availableWidth = this.bookshelfWidth - 16 // Container has px-2 padding (16px total)
        var overflow = Math.max(0, this.entityWidth - availableWidth)
        shelfOffsetX = -overflow / 2
        shelfOffsetY = 4
      } else {
        const indexInShelf = index % this.entitiesPerShelf
        shelfOffsetX = indexInShelf * this.totalEntityCardWidth
      }

      var ComponentClass = this.getComponentClass()
      var props = {
        index,
        width: this.entityWidth,
        height: this.entityHeight,
        bookCoverAspectRatio: this.bookCoverAspectRatio,
        isAltViewEnabled: this.altViewEnabled
      }
      if (this.entityName === 'series' && !this.showBookshelfListView) {
        props.seriesMount = this.entities[index] || null
      }
      if (this.entityName === 'series-books') props.showSequence = true
      if (this.entityName === 'books') {
        props.filterBy = this.filterBy
        props.orderBy = this.orderBy
        props.sortingIgnorePrefix = !!this.sortingIgnorePrefix
      }

      // var _this = this
      var instance = new ComponentClass({
        propsData: props,
        created() {
          // this.$on('edit', (entity) => {
          //   if (_this.editEntity) _this.editEntity(entity)
          // })
          // this.$on('select', (entity) => {
          //   if (_this.selectEntity) _this.selectEntity(entity)
          // })
        }
      })
      this.entityComponentRefs[index] = instance
      instance.$mount()

      // Since everything uses list view now, always use absolute positioning
      instance.$el.style.transform = `translate3d(${shelfOffsetX}px, ${shelfOffsetY}px, 0px)`
      instance.$el.classList.add('absolute', 'top-0', 'left-0')

      shelfEl.appendChild(instance.$el)

      if (this.entities[index]) {
        var entity = this.entities[index]
        if (instance.setEntity) instance.setEntity(entity)

        if (this.isBookEntity && !entity.isLocal) {
          var localLibraryItem = this.localLibraryItems.find((lli) => lli.libraryItemId == entity.id)
          if (localLibraryItem) {
            if (instance.setLocalLibraryItem) instance.setLocalLibraryItem(localLibraryItem)
          }
        }
      }
    }
  }
}
