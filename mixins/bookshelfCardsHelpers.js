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
      var row = index % this.entitiesPerShelf

      // For grid view (CSS Grid), we don't need manual positioning
      var usesCssGrid = !this.showBookshelfListView && !this.altViewEnabled &&
                       (this.entityName === 'series' || this.entityName === 'collections')

      var shelfOffsetX = 0
      var shelfOffsetY = 4

      if (this.showBookshelfListView || this.entityName === 'books' || this.entityName === 'series-books') {
        // For list view and books, center the wider items within the shelf container
        var availableWidth = this.bookshelfWidth - 32 // Container has px-4 padding (32px total)
        var overflow = Math.max(0, this.entityWidth - availableWidth)
        shelfOffsetX = -overflow / 2 // Center by offsetting half the overflow to the left
        shelfOffsetY = this.showBookshelfListView ? 4 : 16
      } else if (!usesCssGrid) {
        // Legacy absolute positioning for playlists
        var availableWidth = this.bookshelfWidth - 32 // Account for px-4 padding
        var totalColumnsWidth = this.entitiesPerShelf * this.totalEntityCardWidth
        var leftMargin = Math.max(0, (availableWidth - totalColumnsWidth) / 2)
        shelfOffsetX = leftMargin + row * this.totalEntityCardWidth
        shelfOffsetY = 16
      }
      // For CSS Grid (series, collections), positioning is handled by the grid layout

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

      if (usesCssGrid) {
        // For CSS Grid, just append without positioning - grid handles layout
        instance.$el.classList.add('grid-card')
      } else {
        // Use absolute positioning for non-grid layouts
        instance.$el.style.transform = `translate3d(${shelfOffsetX}px, ${shelfOffsetY}px, 0px)`
        instance.$el.classList.add('absolute', 'top-0', 'left-0')
      }

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
