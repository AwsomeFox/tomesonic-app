import Vue from 'vue'
import LazyBookCard from '@/components/cards/LazyBookCard'
import LazyListBookCard from '@/components/cards/LazyListBookCard'
import LazySeriesCard from '@/components/cards/LazySeriesCard'
import LazyCollectionCard from '@/components/cards/LazyCollectionCard'
import LazyPlaylistCard from '@/components/cards/LazyPlaylistCard'

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
      if (this.entityName === 'series') return Vue.extend(LazySeriesCard)
      if (this.entityName === 'collections') return Vue.extend(LazyCollectionCard)
      if (this.entityName === 'playlists') return Vue.extend(LazyPlaylistCard)
      // Always use list view for books - removed card view option
      return Vue.extend(LazyListBookCard)
    },
    async mountEntityCard(index) {
      var shelf = Math.floor(index / this.entitiesPerShelf)
      var shelfEl = document.getElementById(`shelf-${shelf}`)
      if (!shelfEl) {
        console.error('mount entity card invalid shelf', shelf, 'book index', index)
        return
      }
      this.entityIndexesMounted.push(index)
      if (this.entityComponentRefs[index]) {
        var bookComponent = this.entityComponentRefs[index]
        shelfEl.appendChild(bookComponent.$el)
        bookComponent.setSelectionMode(false)
        bookComponent.isHovering = false
        return
      }
      var shelfOffsetY = this.showBookshelfListView ? 4 : 16
      var row = index % this.entitiesPerShelf

      var shelfOffsetX

      if (this.showBookshelfListView || this.entityName === 'books' || this.entityName === 'series-books') {
        // For list view and books, center the wider items within the shelf container
        // Account for the fact that cards are now wider than the container minus padding
        var availableWidth = this.bookshelfWidth - 32 // Container has px-4 padding (32px total)
        var overflow = Math.max(0, this.entityWidth - availableWidth)
        shelfOffsetX = -overflow / 2 // Center by offsetting half the overflow to the left
      } else {
        // For grid view (series, collections, playlists), center the cards within the available space
        var availableWidth = this.bookshelfWidth - 32 // Account for px-4 padding

        if (this.entityName === 'playlists') {
          // For playlists, center the grid as a whole (typically 2 columns)
          // Calculate total width needed for all columns
          var totalColumnsWidth = this.entitiesPerShelf * this.totalEntityCardWidth
          var leftMargin = Math.max(0, (availableWidth - totalColumnsWidth) / 2)
          shelfOffsetX = leftMargin + row * this.totalEntityCardWidth
        } else {
          // For series and collections, center each row based on cards in that row
          var cardsInThisShelf = Math.min(this.entitiesPerShelf, this.entities.length - shelf * this.entitiesPerShelf)
          var totalWidthUsed = cardsInThisShelf * this.totalEntityCardWidth
          var leftMargin = Math.max(0, (availableWidth - totalWidthUsed) / 2)
          shelfOffsetX = leftMargin + row * this.totalEntityCardWidth
        }
      }

      var ComponentClass = this.getComponentClass()
      var props = {
        index,
        width: this.entityWidth,
        height: this.entityHeight,
        bookCoverAspectRatio: this.bookCoverAspectRatio,
        isAltViewEnabled: this.altViewEnabled
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
      instance.$el.style.transform = `translate3d(${shelfOffsetX}px, ${shelfOffsetY}px, 0px)`

      instance.$el.classList.add('absolute', 'top-0', 'left-0')
      shelfEl.appendChild(instance.$el)

      if (this.entities[index]) {
        var entity = this.entities[index]
        instance.setEntity(entity)

        if (this.isBookEntity && !entity.isLocal) {
          var localLibraryItem = this.localLibraryItems.find((lli) => lli.libraryItemId == entity.id)
          if (localLibraryItem) {
            instance.setLocalLibraryItem(localLibraryItem)
          }
        }
      }
    }
  }
}
