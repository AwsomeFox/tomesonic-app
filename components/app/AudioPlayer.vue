<template>
  <div
    v-if="playbackSession"
    id="streamContainer"
    :class="{
      fullscreen: showFullscreen,
      'ios-player': $platform === 'ios',
      'web-player': $platform === 'web',
      'fixed pointer-events-none': true,
      'player-expanding': isExpanding,
      'player-collapsing': isCollapsing
    }"
    :style="{
      zIndex: showFullscreen ? 2147483647 : 70,
      top: showFullscreen ? '0' : 'auto',
      bottom: showFullscreen ? '0' : isInBookshelfContext ? '80px' : '0',
      left: '0',
      right: '0',
      height: showFullscreen ? '100vh' : 'auto',
      width: showFullscreen ? '100vw' : 'auto',
      visibility: 'visible',
      backgroundColor: 'transparent',
      position: 'fixed'
    }"
  >
    <!-- Full screen player -->
    <div
      class="w-screen h-screen fixed top-0 left-0 bg-surface-dynamic fullscreen-player"
      :class="{
        'fullscreen-entering': isExpanding,
        'fullscreen-exiting': isCollapsing,
        'no-transition': isSwipeActive
      }"
      :style="{
        opacity: swipeOpacity,
        transform: fullscreenTransform,
        zIndex: 2147483646,
        width: '100vw',
        height: '100vh',
        top: '0',
        left: '0',
        pointerEvents: isSwipeActive || showFullscreen ? 'auto' : 'none',
        willChange: isSwipeActive ? 'transform, opacity' : 'auto'
      }"
    >
      <!-- Additional background coverage to ensure nothing shows through -->
      <div class="w-screen h-screen absolute top-0 left-0 pointer-events-none bg-surface-dynamic" style="width: 100vw; height: 100vh; z-index: 0" />

      <div
        class="top-4 left-4 absolute"
        :class="{ 'no-transition': isSwipeActive }"
        :style="{
          opacity: showFullscreen ? 1 : 0,
          transform: showFullscreen ? 'translateY(0px)' : 'translateY(20px)'
        }"
      >
        <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-2 active:scale-95" @click="collapseFullscreen">
          <span class="material-symbols text-2xl text-on-surface">keyboard_arrow_down</span>
        </button>
      </div>
      <div
        v-show="showCastBtn"
        class="top-4 right-36 absolute"
        :class="{ 'no-transition': isSwipeActive }"
        :style="{
          opacity: showFullscreen ? 1 : 0,
          transform: showFullscreen ? 'translateY(0px)' : 'translateY(20px)'
        }"
      >
        <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-2 active:scale-95" @click="castClick">
          <span class="material-symbols text-xl text-on-surface">{{ isCasting ? 'cast_connected' : 'cast' }}</span>
        </button>
      </div>
      <div
        class="top-4 right-20 absolute"
        :class="{ 'no-transition': isSwipeActive }"
        :style="{
          opacity: showFullscreen ? 1 : 0,
          transform: showFullscreen ? 'translateY(0px)' : 'translateY(20px)'
        }"
      >
        <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-2 active:scale-95" :disabled="!chapters.length" @click="clickChaptersBtn">
          <span class="material-symbols text-xl text-on-surface" :class="chapters.length ? '' : 'opacity-30'">format_list_bulleted</span>
        </button>
      </div>
      <div
        class="top-4 right-4 absolute"
        :class="{ 'no-transition': isSwipeActive }"
        :style="{
          opacity: showFullscreen ? 1 : 0,
          transform: showFullscreen ? 'translateY(0px)' : 'translateY(20px)'
        }"
      >
        <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-2 active:scale-95" @click="showMoreMenuDialog = true">
          <span class="material-symbols text-xl text-on-surface">more_vert</span>
        </button>
      </div>
      <p
        class="top-16 absolute left-0 right-0 mx-auto text-center uppercase tracking-widest text-on-surface-variant opacity-75 text-xs"
        :class="{ 'no-transition': isSwipeActive }"
        :style="{
          opacity: fullscreenContentOpacity * 0.75,
          transform: fullscreenContentTransform
        }"
      >
        {{ isDirectPlayMethod ? $strings.LabelPlaybackDirect : isLocalPlayMethod ? $strings.LabelPlaybackLocal : $strings.LabelPlaybackTranscode }}
      </p>

      <!-- Fullscreen Cover Image -->
      <div
        class="cover-wrapper-fullscreen absolute z-30 pointer-events-auto flex justify-center items-center"
        :class="{ 'no-transition': isSwipeActive }"
        :style="{
          top: '0',
          left: '0',
          right: '0',
          bottom: '200px',
          opacity: fullscreenContentOpacity,
          transform: fullscreenContentTransform
        }"
        @click="collapseFullscreen"
      >
        <covers-book-cover v-if="libraryItem || localLibraryItemCoverSrc" ref="cover" :library-item="libraryItem" :download-cover="localLibraryItemCoverSrc" :width="bookCoverWidth" :book-cover-aspect-ratio="bookCoverAspectRatio" raw @imageLoaded="coverImageLoaded" />

        <div v-if="syncStatus === $constants.SyncStatus.FAILED" class="absolute top-0 left-0 w-full h-full flex items-center justify-center z-30" @click.stop="showSyncsFailedDialog">
          <span class="material-symbols text-error text-3xl">error</span>
        </div>
      </div>

      <!-- Fullscreen Controls -->
      <div
        id="playerControls"
        class="absolute left-6 right-6 bottom-6 mx-auto max-w-96"
        :class="{ 'no-transition': isSwipeActive }"
        :style="{
          opacity: fullscreenContentOpacity,
          transform: fullscreenContentTransform
        }"
      >
        <!-- Main playback controls row -->
        <div class="flex items-center max-w-full mb-4" :class="playerSettings.lockUi ? 'justify-center' : 'justify-between'">
          <button v-show="showFullscreen && !playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 active:scale-95" :disabled="isLoading" @click.stop="jumpChapterStart">
            <span class="material-symbols text-xl text-on-surface" :class="isLoading ? 'opacity-30' : ''">first_page</span>
          </button>
          <button v-show="!playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 active:scale-95" :disabled="isLoading" @click.stop="jumpBackwards">
            <span class="material-symbols text-xl text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpBackwardsIcon }}</span>
          </button>
          <button class="w-16 h-16 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-elevation-3 active:scale-95 mx-4 relative overflow-hidden" :class="{ 'animate-spin': seekLoading }" :disabled="isLoading" @mousedown.prevent @mouseup.prevent @click.stop="playPauseClick">
            <span v-if="!isLoading" class="material-symbols text-2xl text-on-surface">{{ seekLoading ? 'autorenew' : !isPlaying ? 'play_arrow' : 'pause' }}</span>
            <widgets-spinner-icon v-else class="h-6 w-6" />
          </button>
          <button v-show="!playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 active:scale-95" :disabled="isLoading" @click.stop="jumpForward">
            <span class="material-symbols text-xl text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpForwardIcon }}</span>
          </button>
          <button v-show="showFullscreen && !playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 active:scale-95" :disabled="!nextChapter || isLoading" @click.stop="jumpNextChapter">
            <span class="material-symbols text-xl text-on-surface" :class="nextChapter && !isLoading ? '' : 'opacity-30'">last_page</span>
          </button>
        </div>

        <!-- Secondary controls row - Sleep Timer, Speed, and Bookmarks -->
        <div v-show="showFullscreen && !playerSettings.lockUi" class="flex items-center justify-center space-x-8">
          <!-- Sleep Timer Button (under and between back and play buttons) -->
          <button v-if="!sleepTimerRunning" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 active:scale-95" @click.stop="$emit('showSleepTimer')">
            <span class="material-symbols text-xl text-on-surface">bedtime</span>
          </button>
          <button v-else class="px-3 py-2 rounded-full bg-tertiary-container text-on-tertiary-container flex items-center justify-center shadow-elevation-1 active:scale-95" @click.stop="$emit('showSleepTimer')">
            <span class="text-sm font-mono font-medium">{{ sleepTimeRemainingPretty }}</span>
          </button>

          <!-- Speed Button (under and between play and forward buttons) -->
          <button class="px-4 py-2 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center shadow-elevation-1 active:scale-95" @click="$emit('selectPlaybackSpeed')">
            <span class="font-mono text-sm font-medium">{{ currentPlaybackRate }}x</span>
          </button>

          <!-- Bookmarks Button -->
          <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 active:scale-95" @click="$emit('showBookmarks')">
            <span class="material-symbols text-xl text-on-surface" :class="{ fill: bookmarks.length }">bookmark</span>
          </button>
        </div>
      </div>

      <!-- Progress Bars Container - manages both tracks -->
      <div
        id="progressBarsContainer"
        class="absolute left-6 right-6 bottom-48"
        :class="{ 'no-transition': isSwipeActive }"
        :style="{
          opacity: fullscreenContentOpacity,
          transform: fullscreenContentTransform
        }"
      >
        <!-- Total Progress Track (shown when both tracks enabled) -->
        <div v-if="playerSettings.useChapterTrack && playerSettings.useTotalTrack" class="mb-6">
          <div class="flex mb-1">
            <p class="font-mono text-on-surface-variant text-xs">{{ currentTimePretty }}</p>
            <div class="flex-grow" />
            <p class="font-mono text-on-surface-variant text-xs">{{ totalTimeRemainingPretty }}</p>
          </div>
          <div class="w-full">
            <div class="h-1 w-full bg-surface-variant/50 relative rounded-full">
              <div ref="totalReadyTrack" class="h-full bg-outline/60 absolute top-0 left-0 pointer-events-none rounded-full" />
              <div ref="totalBufferedTrack" class="h-full bg-on-surface-variant/60 absolute top-0 left-0 pointer-events-none rounded-full" />
              <div ref="totalPlayedTrack" class="h-full bg-primary/80 absolute top-0 left-0 pointer-events-none rounded-full" />
            </div>
          </div>
        </div>

        <!-- Main Progress Track -->
        <div>
          <div class="flex pointer-events-none mb-2">
            <p class="font-mono text-on-surface text-sm" ref="currentTimestamp">0:00</p>
            <div class="flex-grow" />
            <p class="font-mono text-on-surface text-sm">{{ timeRemainingPretty }}</p>
          </div>
          <div ref="track" class="h-2 w-full relative rounded-full bg-surface-variant shadow-inner" :class="{ 'animate-pulse': isLoading }" @click.stop>
            <div ref="readyTrack" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-outline transition-all duration-300" />
            <div ref="bufferedTrack" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-on-surface-variant transition-all duration-300" />
            <div ref="playedTrack" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-primary transition-all duration-300" />
            <div ref="trackCursor" class="h-6 w-6 rounded-full absolute pointer-events-auto flex items-center justify-center shadow-elevation-2 bg-primary transition-all duration-200 hover:scale-110 active:scale-95" :style="{ top: '-8px' }" :class="{ 'opacity-0': playerSettings.lockUi || !showFullscreen }" @touchstart="touchstartCursor">
              <div class="rounded-full w-3 h-3 pointer-events-none bg-on-primary" />
            </div>
          </div>
        </div>
      </div>

      <!-- Fullscreen Title and Author - positioned below progress bars -->
      <div
        class="title-author-texts absolute z-30 left-6 right-6 bottom-72 text-center overflow-hidden"
        :class="{ 'no-transition': isSwipeActive }"
        :style="{
          opacity: fullscreenContentOpacity,
          transform: fullscreenContentTransform
        }"
        @click="collapseFullscreen"
      >
        <div ref="titlewrapper" class="overflow-hidden relative">
          <p class="title-text whitespace-nowrap text-on-surface text-lg font-medium">{{ title }}</p>
        </div>
        <p class="author-text text-on-surface-variant text-sm truncate">{{ authorName }}</p>
      </div>
    </div>

    <div
      v-show="!showFullscreen"
      id="playerContent"
      class="playerContainer w-full pointer-events-auto bg-player-overlay backdrop-blur-md shadow-elevation-3 border-t border-outline-variant border-opacity-20 mini-player"
      :class="{
        'transition-all duration-500 ease-expressive': !isSwipeActive,
        'mini-exiting': isExpanding,
        'mini-entering': isCollapsing
      }"
      :style="{
        transform: miniPlayerTransform,
        opacity: miniPlayerOpacity,
        zIndex: '2147483647'
      }"
      @touchstart="handleTouchStart"
      @touchmove="handleTouchMove"
      @touchend="handleTouchEnd"
    >
      <!-- Collapsed player layout: Cover → Text → Controls -->
      <div v-if="!showFullscreen" class="flex items-center h-full px-2">
        <!-- Cover Image -->
        <div class="cover-wrapper-mini flex-shrink-0 mr-2" @click="expandFullscreen">
          <covers-book-cover v-if="libraryItem || localLibraryItemCoverSrc" ref="cover" :library-item="libraryItem" :download-cover="localLibraryItemCoverSrc" :width="bookCoverWidth" :book-cover-aspect-ratio="bookCoverAspectRatio" raw @imageLoaded="coverImageLoaded" />
        </div>

        <!-- Text Content -->
        <div class="flex-1 min-w-0 mr-2" @click="expandFullscreen">
          <div ref="titlewrapper" class="overflow-hidden relative">
            <p class="title-text whitespace-nowrap truncate text-on-surface text-sm font-medium">{{ title }}</p>
          </div>
          <p class="author-text text-on-surface-variant text-xs truncate">{{ authorName }}</p>
        </div>

        <!-- Controls -->
        <div class="flex items-center flex-shrink-0">
          <button v-show="!playerSettings.lockUi" class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 active:scale-95 mr-1" :disabled="isLoading" @click.stop="jumpBackwards">
            <span class="material-symbols text-lg text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpBackwardsIcon }}</span>
          </button>
          <button class="w-12 h-12 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-elevation-2 active:scale-95 mx-2 relative overflow-hidden" :class="{ 'animate-spin': seekLoading }" :disabled="isLoading" @mousedown.prevent @mouseup.prevent @click.stop="playPauseClick">
            <span v-if="!isLoading" class="material-symbols text-xl text-on-surface">{{ seekLoading ? 'autorenew' : !isPlaying ? 'play_arrow' : 'pause' }}</span>
            <widgets-spinner-icon v-else class="h-5 w-5" />
          </button>
          <button v-show="!playerSettings.lockUi" class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 active:scale-95 ml-1" :disabled="isLoading" @click.stop="jumpForward">
            <span class="material-symbols text-lg text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpForwardIcon }}</span>
          </button>
        </div>
      </div>

      <!-- Progress Bar -->
      <div v-if="!showFullscreen" id="playerTrackMini" class="absolute bottom-2 left-0 w-full px-2">
        <div ref="track" class="h-1 w-full relative rounded-full bg-surface-variant shadow-inner" :class="{ 'animate-pulse': isLoading }" @click.stop>
          <div ref="readyTrack" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-outline transition-all duration-300" />
          <div ref="bufferedTrack" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-on-surface-variant transition-all duration-300" />
          <div ref="playedTrack" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-secondary transition-all duration-300" />
        </div>
      </div>
    </div>

    <modals-chapters-modal v-model="showChapterModal" :current-chapter="currentChapter" :chapters="chapters" :playback-rate="currentPlaybackRate" @select="selectChapter" />
    <modals-dialog v-model="showMoreMenuDialog" :items="menuItems" width="80vw" @action="clickMenuAction" />
  </div>
</template>

<script>
import { Capacitor } from '@capacitor/core'
import { AbsAudioPlayer } from '@/plugins/capacitor'
import { Dialog } from '@capacitor/dialog'
import WrappingMarquee from '@/assets/WrappingMarquee.js'

export default {
  props: {
    bookmarks: {
      type: Array,
      default: () => []
    },
    sleepTimerRunning: Boolean,
    sleepTimeRemaining: Number,
    serverLibraryItemId: String
  },
  data() {
    return {
      windowHeight: 0,
      windowWidth: 0,
      playbackSession: null,
      showChapterModal: false,
      showFullscreen: false,
      totalDuration: 0,
      currentPlaybackRate: 1,
      currentTime: 0,
      bufferedTime: 0,
      playInterval: null,
      trackWidth: 0,
      isPlaying: false,
      isEnded: false,
      volume: 0.5,
      readyTrackWidth: 0,
      seekedTime: 0,
      seekLoading: false,
      touchStartY: 0,
      touchStartTime: 0,
      swipeOffset: 0,
      isSwipeActive: false,
      swipeStartY: 0,
      swipeStartTime: 0,
      swipeThreshold: 30, // pixels to trigger fullscreen - reduced for better responsiveness
      playerSettings: {
        useChapterTrack: false,
        useTotalTrack: true,
        scaleElapsedTimeBySpeed: true,
        lockUi: false
      },
      isLoading: false,
      isDraggingCursor: false,
      draggingTouchStartX: 0,
      draggingTouchStartTime: 0,
      draggingCurrentTime: 0,
      syncStatus: 0,
      showMoreMenuDialog: false,
      titleMarquee: null,
      isRefreshingUI: false,
      isExpanding: false,
      isCollapsing: false
    }
  },
  watch: {
    showFullscreen(val) {
      this.updateScreenSize()
      this.$store.commit('setPlayerFullscreen', !!val)
    },
    bookCoverAspectRatio() {
      this.updateScreenSize()
    },
    title(val) {
      if (this.titleMarquee) this.titleMarquee.init(val)
    }
  },
  computed: {
    theme() {
      return document.documentElement.dataset.theme || 'dark'
    },
    swipeProgress() {
      if (!this.isSwipeActive || this.swipeOffset >= 0) return 0
      const screenHeight = window.innerHeight || 800
      const maxDistance = screenHeight * 0.25
      return Math.min(Math.abs(this.swipeOffset) / maxDistance, 1)
    },
    swipeOpacity() {
      // During a swipe, interpolate opacity from 0 to 1 as swipe offset increases
      if (this.isSwipeActive && this.swipeOffset < 0) {
        // Fullscreen should start appearing immediately and reach full opacity at about 25% of screen
        const screenHeight = window.innerHeight || 800
        const maxDistance = screenHeight * 0.25 // Reach full opacity at 25% of screen height
        const progress = Math.min(Math.abs(this.swipeOffset) / maxDistance, 1)
        // Use ease-out curve for immediate feedback that slows down
        const easedProgress = 1 - Math.pow(1 - progress, 3)
        return easedProgress
      }
      // When not swiping, show fullscreen state
      return this.showFullscreen ? 1 : 0
    },
    miniPlayerOpacity() {
      // During a swipe, interpolate opacity from 1 to 0 as swipe offset increases
      if (this.isSwipeActive && this.swipeOffset < 0) {
        // Mini player should only fully disappear when it reaches near the top of screen
        // Assuming mini player height is about 80px, start fading when it's 70% up the screen
        const screenHeight = window.innerHeight || 800
        const fadeDistance = screenHeight * 0.7 // Start strong fade at 70% of screen height
        const progress = Math.min(Math.abs(this.swipeOffset) / fadeDistance, 1)
        // Use a gentler curve for slower initial fade
        const easedProgress = Math.pow(progress, 0.8)
        return 1 - easedProgress
      }
      // When not swiping, show based on fullscreen state
      return this.showFullscreen ? 0 : 1
    },
    miniPlayerTranslateY() {
      // During swipe, apply transform based on offset
      return this.isSwipeActive ? this.swipeOffset : 0
    },
    miniPlayerTransform() {
      // During swipe, add subtle scale effect to mini player
      if (this.isSwipeActive && this.swipeOffset < 0) {
        const screenHeight = window.innerHeight || 800
        const progress = Math.min(Math.abs(this.swipeOffset) / (screenHeight * 0.3), 1)
        const scale = 1 - progress * 0.05 // Slight scale down as it moves up
        return `translateY(${this.swipeOffset}px) scale(${scale})`
      }
      return 'translateY(0) scale(1)'
    },
    fullscreenTransform() {
      // During a swipe, animate the fullscreen player with Material 3 motion
      if (this.isSwipeActive && this.swipeOffset < 0) {
        const progress = this.swipeProgress

        // More pronounced Material 3-style transform for better visual feedback
        const translateY = (1 - progress) * 20 // Start 20px down, move to 0 (more visible)
        const scale = 0.9 + progress * 0.1 // Start at 0.9, scale to 1.0 (even more pronounced)

        return `translateY(${translateY}px) scale(${scale})`
      }
      return 'translateY(0px) scale(1)'
    },
    fullscreenContentOpacity() {
      // Content elements should fade in during swipe
      if (this.isSwipeActive && this.swipeOffset < 0) {
        const progress = this.swipeProgress
        // Use a steeper curve for content fade-in - starts later but reaches full opacity quickly
        return Math.pow(progress, 0.6)
      }
      return this.showFullscreen ? 1 : 0
    },
    fullscreenContentTransform() {
      // Content elements should move smoothly during swipe
      if (this.isSwipeActive && this.swipeOffset < 0) {
        const progress = this.swipeProgress
        // Content moves up slightly as it fades in, using the same Material 3 curve
        const translateY = (1 - progress) * 8 // Start 8px down, move to 0
        return `translateY(${translateY}px)`
      }
      // When not swiping, position based on fullscreen state
      return this.showFullscreen ? 'translateY(0px)' : 'translateY(20px)'
    },
    menuItems() {
      const items = []
      // TODO: Implement on iOS
      if (this.$platform !== 'ios' && !this.isPodcast && this.mediaId) {
        items.push({
          text: this.$strings.ButtonHistory,
          value: 'history',
          icon: 'history'
        })
      }

      items.push(
        ...[
          {
            text: this.$strings.LabelTotalTrack,
            value: 'total_track',
            icon: this.playerSettings.useTotalTrack ? 'check_box' : 'check_box_outline_blank'
          },
          {
            text: this.$strings.LabelChapterTrack,
            value: 'chapter_track',
            icon: this.playerSettings.useChapterTrack ? 'check_box' : 'check_box_outline_blank'
          },
          {
            text: this.$strings.LabelScaleElapsedTimeBySpeed,
            value: 'scale_elapsed_time',
            icon: this.playerSettings.scaleElapsedTimeBySpeed ? 'check_box' : 'check_box_outline_blank'
          },
          {
            text: this.playerSettings.lockUi ? this.$strings.LabelUnlockPlayer : this.$strings.LabelLockPlayer,
            value: 'lock',
            icon: this.playerSettings.lockUi ? 'lock' : 'lock_open'
          },
          {
            text: this.$strings.LabelClosePlayer,
            value: 'close',
            icon: 'close'
          }
        ]
      )

      return items
    },
    jumpForwardIcon() {
      return this.$store.getters['globals/getJumpForwardIcon'](this.jumpForwardTime)
    },
    jumpBackwardsIcon() {
      return this.$store.getters['globals/getJumpBackwardsIcon'](this.jumpBackwardsTime)
    },
    jumpForwardTime() {
      return this.$store.getters['getJumpForwardTime']
    },
    jumpBackwardsTime() {
      return this.$store.getters['getJumpBackwardsTime']
    },
    bookCoverAspectRatio() {
      return this.$store.getters['libraries/getBookCoverAspectRatio']
    },
    bookCoverWidth() {
      if (this.showFullscreen) return this.fullscreenBookCoverWidth
      return 48 / this.bookCoverAspectRatio
    },
    fullscreenBookCoverWidth() {
      if (this.windowWidth < this.windowHeight) {
        // Portrait
        let sideSpace = 20
        if (this.bookCoverAspectRatio === 1.6) sideSpace += (this.windowWidth - sideSpace) * 0.375

        const availableHeight = this.windowHeight - 400
        let width = this.windowWidth - sideSpace
        const totalHeight = width * this.bookCoverAspectRatio
        if (totalHeight > availableHeight) {
          width = availableHeight / this.bookCoverAspectRatio
        }
        return width
      } else {
        // Landscape
        const heightScale = (this.windowHeight - 200) / 651
        if (this.bookCoverAspectRatio === 1) {
          return 260 * heightScale
        }
        return 190 * heightScale
      }
    },
    showCastBtn() {
      return this.$store.state.isCastAvailable
    },
    isCasting() {
      return this.mediaPlayer === 'cast-player'
    },
    mediaPlayer() {
      return this.playbackSession?.mediaPlayer || null
    },
    mediaType() {
      return this.playbackSession?.mediaType || null
    },
    isPodcast() {
      return this.mediaType === 'podcast'
    },
    mediaMetadata() {
      return this.playbackSession?.mediaMetadata || null
    },
    libraryItem() {
      return this.playbackSession?.libraryItem || null
    },
    localLibraryItem() {
      return this.playbackSession?.localLibraryItem || null
    },
    localLibraryItemCoverSrc() {
      var localItemCover = this.localLibraryItem?.coverContentUrl || null
      if (localItemCover) return Capacitor.convertFileSrc(localItemCover)
      return null
    },
    playMethod() {
      return this.playbackSession?.playMethod || 0
    },
    isLocalPlayMethod() {
      return this.playMethod == this.$constants.PlayMethod.LOCAL
    },
    isDirectPlayMethod() {
      return this.playMethod == this.$constants.PlayMethod.DIRECTPLAY
    },
    title() {
      const mediaItemTitle = this.playbackSession?.displayTitle || this.mediaMetadata?.title || 'Title'
      if (this.currentChapterTitle) {
        if (this.showFullscreen) return this.currentChapterTitle
        return `${mediaItemTitle} | ${this.currentChapterTitle}`
      }
      return mediaItemTitle
    },
    authorName() {
      if (this.playbackSession) return this.playbackSession.displayAuthor
      return this.mediaMetadata?.authorName || 'Author'
    },
    chapters() {
      return this.playbackSession?.chapters || []
    },
    currentChapter() {
      if (!this.chapters.length) return null
      return this.chapters.find((ch) => Number(Number(ch.start).toFixed(2)) <= this.currentTime && Number(Number(ch.end).toFixed(2)) > this.currentTime)
    },
    nextChapter() {
      if (!this.chapters.length) return
      return this.chapters.find((c) => Number(Number(c.start).toFixed(2)) > this.currentTime)
    },
    currentChapterTitle() {
      return this.currentChapter?.title || ''
    },
    currentChapterDuration() {
      return this.currentChapter ? this.currentChapter.end - this.currentChapter.start : this.totalDuration
    },
    totalDurationPretty() {
      return this.$secondsToTimestamp(this.totalDuration)
    },
    currentTimePretty() {
      let currentTimeToUse = this.isDraggingCursor ? this.draggingCurrentTime : this.currentTime
      if (this.playerSettings.scaleElapsedTimeBySpeed) {
        currentTimeToUse = currentTimeToUse / this.currentPlaybackRate
      }
      return this.$secondsToTimestamp(currentTimeToUse)
    },
    timeRemaining() {
      let currentTimeToUse = this.isDraggingCursor ? this.draggingCurrentTime : this.currentTime
      if (this.playerSettings.useChapterTrack && this.currentChapter) {
        var currChapTime = currentTimeToUse - this.currentChapter.start
        return (this.currentChapterDuration - currChapTime) / this.currentPlaybackRate
      }
      return this.totalTimeRemaining
    },
    totalTimeRemaining() {
      let currentTimeToUse = this.isDraggingCursor ? this.draggingCurrentTime : this.currentTime
      return (this.totalDuration - currentTimeToUse) / this.currentPlaybackRate
    },
    totalTimeRemainingPretty() {
      if (this.totalTimeRemaining < 0) {
        return this.$secondsToTimestamp(this.totalTimeRemaining * -1)
      }
      return '-' + this.$secondsToTimestamp(this.totalTimeRemaining)
    },
    timeRemainingPretty() {
      if (this.timeRemaining < 0) {
        return this.$secondsToTimestamp(this.timeRemaining * -1)
      }
      return '-' + this.$secondsToTimestamp(this.timeRemaining)
    },
    sleepTimeRemainingPretty() {
      if (!this.sleepTimeRemaining) return '0s'
      var secondsRemaining = Math.round(this.sleepTimeRemaining)
      if (secondsRemaining > 91) {
        return Math.ceil(secondsRemaining / 60) + 'm'
      } else {
        return secondsRemaining + 's'
      }
    },
    socketConnected() {
      return this.$store.state.socketConnected
    },
    mediaId() {
      if (this.isPodcast || !this.playbackSession) return null
      if (this.playbackSession.libraryItemId) {
        return this.playbackSession.episodeId ? `${this.playbackSession.libraryItemId}-${this.playbackSession.episodeId}` : this.playbackSession.libraryItemId
      }
      const localLibraryItem = this.playbackSession.localLibraryItem
      if (!localLibraryItem) return null

      return this.playbackSession.localEpisodeId ? `${localLibraryItem.id}-${this.playbackSession.localEpisodeId}` : localLibraryItem.id
    },
    isInBookshelfContext() {
      // Check if current route is bookshelf-related which has bottom navigation
      return this.$route && this.$route.name && this.$route.name.startsWith('bookshelf')
    },
    playerBottomOffset() {
      // Add bottom padding when in bookshelf context to account for bottom navigation
      return this.isInBookshelfContext && !this.showFullscreen ? '80px' : '0px'
    }
  },
  methods: {
    handleTouchStart(event) {
      if (this.showFullscreen) return

      this.isSwipeActive = true
      this.swipeStartY = event.touches[0].clientY
      this.swipeStartTime = Date.now()
      this.swipeOffset = 0
    },
    handleTouchMove(event) {
      if (!this.isSwipeActive || this.showFullscreen) return

      event.preventDefault()
      const currentY = event.touches[0].clientY
      const deltaY = this.swipeStartY - currentY // Negative for upward swipe

      if (deltaY > 0) {
        // Only allow upward swipes
        this.swipeOffset = -Math.min(deltaY, window.innerHeight)
      }
    },
    handleTouchEnd(event) {
      if (!this.isSwipeActive) return

      this.isSwipeActive = false
      const deltaY = this.swipeOffset
      const velocity = (Math.abs(deltaY) / (Date.now() - this.swipeStartTime)) * 1000 // pixels per second

      // Determine if we should expand or snap back
      const shouldExpand = Math.abs(deltaY) > this.swipeThreshold || velocity > 500

      if (shouldExpand && deltaY < 0) {
        // Expand to fullscreen
        this.expandFullscreen()
      } else {
        // Snap back to mini player
        this.swipeOffset = 0
      }
    },
    showSyncsFailedDialog() {
      Dialog.alert({
        title: this.$strings.HeaderProgressSyncFailed,
        message: this.$strings.MessageProgressSyncFailed,
        cancelText: this.$strings.ButtonOk
      })
    },
    clickChaptersBtn() {
      if (!this.chapters.length) return
      this.showChapterModal = true
    },
    async coverImageLoaded(fullCoverUrl) {
      // Image loaded, no color extraction needed for solid background
    },
    clickTitleAndAuthor() {
      if (!this.showFullscreen) return
      const llid = this.serverLibraryItemId || this.libraryItem?.id || this.localLibraryItem?.id
      if (llid) {
        this.$router.push(`/item/${llid}`)
        this.showFullscreen = false
      }
    },
    async selectChapter(chapter) {
      await this.$hapticsImpact()
      this.seek(chapter.start)
      this.showChapterModal = false
    },
    async castClick() {
      await this.$hapticsImpact()
      if (this.isLocalPlayMethod) {
        this.$eventBus.$emit('cast-local-item')
        return
      }
      AbsAudioPlayer.requestSession()
    },
    clickContainer() {
      this.expandToFullscreen()
    },
    expandFullscreen() {
      this.expandToFullscreen()
    },
    expandToFullscreen() {
      this.swipeOffset = 0
      this.isSwipeActive = false

      // Start slide and fade transition
      this.isExpanding = true

      // Show fullscreen immediately
      this.showFullscreen = true
      if (this.titleMarquee) this.titleMarquee.reset()

      // End animation state after animation completes
      setTimeout(() => {
        this.isExpanding = false
      }, 400) // Match fade animation duration

      // Update track for total time bar if useChapterTrack is set
      this.$nextTick(() => {
        this.updateTrack()
      })
    },
    collapseFullscreen() {
      this.swipeOffset = 0
      this.isSwipeActive = false

      // Start slide and fade transition
      this.isCollapsing = true

      // Wait for animation to complete before hiding fullscreen
      setTimeout(() => {
        this.showFullscreen = false
        this.isCollapsing = false
        if (this.titleMarquee) this.titleMarquee.reset()
      }, 300) // Match fade animation duration

      this.forceCloseDropdownMenu()
    },
    async jumpNextChapter() {
      await this.$hapticsImpact()
      if (this.isLoading) return
      if (!this.nextChapter) return
      this.seek(this.nextChapter.start)
    },
    async jumpChapterStart() {
      await this.$hapticsImpact()
      if (this.isLoading) return
      if (!this.currentChapter) {
        return this.restart()
      }

      // If 4 seconds or less into current chapter, then go to previous
      if (this.currentTime - this.currentChapter.start <= 4) {
        const currChapterIndex = this.chapters.findIndex((ch) => Number(ch.start) <= this.currentTime && Number(ch.end) >= this.currentTime)
        if (currChapterIndex > 0) {
          const prevChapter = this.chapters[currChapterIndex - 1]
          this.seek(prevChapter.start)
        }
      } else {
        this.seek(this.currentChapter.start)
      }
    },
    showSleepTimerModal() {
      this.$emit('showSleepTimer')
    },
    async setPlaybackSpeed(speed) {
      console.log(`[AudioPlayer] Set Playback Rate: ${speed}`)
      this.currentPlaybackRate = speed
      this.updateTimestamp()
      AbsAudioPlayer.setPlaybackSpeed({ value: speed })
    },
    restart() {
      this.seek(0)
    },
    async jumpBackwards() {
      await this.$hapticsImpact()
      if (this.isLoading) return
      AbsAudioPlayer.seekBackward({ value: this.jumpBackwardsTime })
    },
    async jumpForward() {
      await this.$hapticsImpact()
      if (this.isLoading) return
      AbsAudioPlayer.seekForward({ value: this.jumpForwardTime })
    },
    setStreamReady() {
      this.readyTrackWidth = this.trackWidth
      this.updateReadyTrack()
    },
    setChunksReady(chunks, numSegments) {
      let largestSeg = 0
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        if (typeof chunk === 'string') {
          const chunkRange = chunk.split('-').map((c) => Number(c))
          if (chunkRange.length < 2) continue
          if (chunkRange[1] > largestSeg) largestSeg = chunkRange[1]
        } else if (chunk > largestSeg) {
          largestSeg = chunk
        }
      }
      const percentageReady = largestSeg / numSegments
      const widthReady = Math.round(this.trackWidth * percentageReady)
      if (this.readyTrackWidth === widthReady) {
        return
      }
      this.readyTrackWidth = widthReady
      this.updateReadyTrack()
    },
    updateReadyTrack() {
      if (this.playerSettings.useChapterTrack) {
        if (this.$refs.totalReadyTrack) {
          this.$refs.totalReadyTrack.style.width = this.readyTrackWidth + 'px'
        }
        this.$refs.readyTrack.style.width = this.trackWidth + 'px'
      } else {
        this.$refs.readyTrack.style.width = this.readyTrackWidth + 'px'
      }
    },
    updateTimestamp() {
      const ts = this.$refs.currentTimestamp
      if (!ts) {
        console.error('No timestamp el')
        return
      }

      let currentTime = this.isDraggingCursor ? this.draggingCurrentTime : this.currentTime
      if (this.playerSettings.useChapterTrack && this.currentChapter) {
        currentTime = Math.max(0, currentTime - this.currentChapter.start)
      }
      if (this.playerSettings.scaleElapsedTimeBySpeed) {
        currentTime = currentTime / this.currentPlaybackRate
      }

      ts.innerText = this.$secondsToTimestamp(currentTime)
    },
    timeupdate() {
      if (!this.$refs.playedTrack) {
        console.error('Invalid no played track ref')
        return
      }
      this.$emit('updateTime', this.currentTime)

      if (this.seekLoading) {
        this.seekLoading = false
        if (this.$refs.playedTrack) {
          this.$refs.playedTrack.classList.remove('bg-yellow-300')
          this.$refs.playedTrack.classList.add('bg-surface-container')
        }
      }

      this.updateTimestamp()
      this.updateTrack()
    },
    updateTrack() {
      // Update progress track UI
      let currentTimeToUse = this.isDraggingCursor ? this.draggingCurrentTime : this.currentTime
      let percentDone = currentTimeToUse / this.totalDuration
      const totalPercentDone = percentDone
      let bufferedPercent = this.bufferedTime / this.totalDuration
      const totalBufferedPercent = bufferedPercent

      if (this.playerSettings.useChapterTrack && this.currentChapter) {
        const currChapTime = currentTimeToUse - this.currentChapter.start
        percentDone = currChapTime / this.currentChapterDuration
        bufferedPercent = Math.max(0, Math.min(1, (this.bufferedTime - this.currentChapter.start) / this.currentChapterDuration))
      }

      const ptWidth = Math.round(percentDone * this.trackWidth)
      this.$refs.playedTrack.style.width = ptWidth + 'px'
      this.$refs.bufferedTrack.style.width = Math.round(bufferedPercent * this.trackWidth) + 'px'

      if (this.$refs.trackCursor) {
        this.$refs.trackCursor.style.left = ptWidth - 14 + 'px'
      }

      if (this.playerSettings.useChapterTrack) {
        if (this.$refs.totalPlayedTrack) this.$refs.totalPlayedTrack.style.width = Math.round(totalPercentDone * this.trackWidth) + 'px'
        if (this.$refs.totalBufferedTrack) this.$refs.totalBufferedTrack.style.width = Math.round(totalBufferedPercent * this.trackWidth) + 'px'
      }
    },
    seek(time) {
      if (this.isLoading) return
      if (this.seekLoading) {
        console.error('Already seek loading', this.seekedTime)
        return
      }

      this.seekedTime = time
      this.seekLoading = true

      AbsAudioPlayer.seek({ value: Math.floor(time) })

      if (this.$refs.playedTrack) {
        const perc = time / this.totalDuration
        const ptWidth = Math.round(perc * this.trackWidth)
        this.$refs.playedTrack.style.width = ptWidth + 'px'

        this.$refs.playedTrack.classList.remove('bg-surface-container')
        this.$refs.playedTrack.classList.add('bg-yellow-300')
      }
    },
    async touchstartCursor(e) {
      if (!e || !e.touches || !this.$refs.track || !this.showFullscreen || this.playerSettings.lockUi) return

      await this.$hapticsImpact()
      this.isDraggingCursor = true
      this.draggingTouchStartX = e.touches[0].pageX
      this.draggingTouchStartTime = this.currentTime
      this.draggingCurrentTime = this.currentTime
      this.updateTrack()
    },
    async playPauseClick() {
      await this.$hapticsImpact()
      if (this.isLoading) return

      this.isPlaying = !!((await AbsAudioPlayer.playPause()) || {}).playing
      this.isEnded = false
    },
    play() {
      AbsAudioPlayer.playPlayer()
      this.startPlayInterval()
      this.isPlaying = true
    },
    pause() {
      AbsAudioPlayer.pausePlayer()
      this.stopPlayInterval()
      this.isPlaying = false
    },
    startPlayInterval() {
      clearInterval(this.playInterval)
      this.playInterval = setInterval(async () => {
        var data = await AbsAudioPlayer.getCurrentTime()
        this.currentTime = Number(data.value.toFixed(2))
        this.bufferedTime = Number(data.bufferedTime.toFixed(2))
        this.timeupdate()
      }, 1000)
    },
    stopPlayInterval() {
      clearInterval(this.playInterval)
    },
    resetStream(startTime) {
      this.closePlayback()
    },
    touchstart(e) {
      if (!e.changedTouches || this.$store.state.globals.isModalOpen) return
      const touchPosY = e.changedTouches[0].pageY
      // when minimized only listen to touchstart on the player
      if (!this.showFullscreen && touchPosY < window.innerHeight - 120) return

      // for ios
      if (!this.showFullscreen && e.pageX < 20) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      this.touchStartY = touchPosY
      this.touchStartTime = Date.now()
    },
    touchend(e) {
      if (!e.changedTouches) return
      const touchDuration = Date.now() - this.touchStartTime
      const touchEndY = e.changedTouches[0].pageY
      const touchDistanceY = touchEndY - this.touchStartY

      // reset touch start data
      this.touchStartTime = 0
      this.touchStartY = 0

      if (this.isDraggingCursor) {
        if (this.draggingCurrentTime !== this.currentTime) {
          this.seek(this.draggingCurrentTime)
        }
        this.isDraggingCursor = false
      } else {
        if (touchDuration > 1200) {
          // console.log('touch too long', touchDuration)
          return
        }
        if (this.showFullscreen) {
          // Touch start higher than touchend
          if (touchDistanceY > 100) {
            this.collapseFullscreen()
          }
        } else if (touchDistanceY < -100) {
          this.expandToFullscreen()
        }
      }
    },
    touchmove(e) {
      if (!this.isDraggingCursor || !e.touches) return

      const distanceMoved = e.touches[0].pageX - this.draggingTouchStartX
      let duration = this.totalDuration
      let minTime = 0
      let maxTime = duration
      if (this.playerSettings.useChapterTrack && this.currentChapter) {
        duration = this.currentChapterDuration
        minTime = this.currentChapter.start
        maxTime = minTime + duration
      }

      const timePerPixel = duration / this.trackWidth
      const newTime = this.draggingTouchStartTime + timePerPixel * distanceMoved
      this.draggingCurrentTime = Math.min(maxTime, Math.max(minTime, newTime))

      this.updateTimestamp()
      this.updateTrack()
    },
    async clickMenuAction(action) {
      await this.$hapticsImpact()
      this.showMoreMenuDialog = false
      this.$nextTick(() => {
        if (action === 'history') {
          this.$router.push(`/media/${this.mediaId}/history?title=${this.title}`)
          this.showFullscreen = false
        } else if (action === 'scale_elapsed_time') {
          this.playerSettings.scaleElapsedTimeBySpeed = !this.playerSettings.scaleElapsedTimeBySpeed
          this.updateTimestamp()
          this.savePlayerSettings()
        } else if (action === 'lock') {
          this.playerSettings.lockUi = !this.playerSettings.lockUi
          this.savePlayerSettings()
        } else if (action === 'chapter_track') {
          this.playerSettings.useChapterTrack = !this.playerSettings.useChapterTrack
          this.playerSettings.useTotalTrack = !this.playerSettings.useChapterTrack || this.playerSettings.useTotalTrack

          this.updateTimestamp()
          this.updateTrack()
          this.updateReadyTrack()
          this.updateUseChapterTrack()
          this.savePlayerSettings()
        } else if (action === 'total_track') {
          this.playerSettings.useTotalTrack = !this.playerSettings.useTotalTrack
          this.playerSettings.useChapterTrack = !this.playerSettings.useTotalTrack || this.playerSettings.useChapterTrack

          this.updateTimestamp()
          this.updateTrack()
          this.updateReadyTrack()
          this.updateUseChapterTrack()
          this.savePlayerSettings()
        } else if (action === 'close') {
          this.closePlayback()
        }
      })
    },
    updateUseChapterTrack() {
      // Chapter track in NowPlaying only supported on iOS for now
      if (this.$platform === 'ios') {
        AbsAudioPlayer.setChapterTrack({ enabled: this.playerSettings.useChapterTrack })
      }
    },
    forceCloseDropdownMenu() {
      if (this.$refs.dropdownMenu && this.$refs.dropdownMenu.closeMenu) {
        this.$refs.dropdownMenu.closeMenu()
      }
    },
    closePlayback() {
      this.endPlayback()
      AbsAudioPlayer.closePlayback()
    },
    endPlayback() {
      this.$store.commit('setPlaybackSession', null)
      this.showFullscreen = false
      this.isEnded = false
      this.isLoading = false
      this.playbackSession = null
    },
    async loadPlayerSettings() {
      const savedPlayerSettings = await this.$localStore.getPlayerSettings()
      if (!savedPlayerSettings) {
        // In 0.9.72-beta 'useChapterTrack', 'useTotalTrack' and 'playerLock' was replaced with 'playerSettings' JSON object
        // Check if this old key was set and if so migrate them over to 'playerSettings'
        const chapterTrackPref = await this.$localStore.getPreferenceByKey('useChapterTrack')
        if (chapterTrackPref) {
          this.playerSettings.useChapterTrack = chapterTrackPref === '1'
          const totalTrackPref = await this.$localStore.getPreferenceByKey('useTotalTrack')
          this.playerSettings.useTotalTrack = totalTrackPref === '1'
          const playerLockPref = await this.$localStore.getPreferenceByKey('playerLock')
          this.playerSettings.lockUi = playerLockPref === '1'
        }
        this.savePlayerSettings()
      } else {
        this.playerSettings.useChapterTrack = !!savedPlayerSettings.useChapterTrack
        this.playerSettings.useTotalTrack = !!savedPlayerSettings.useTotalTrack
        this.playerSettings.lockUi = !!savedPlayerSettings.lockUi
        this.playerSettings.scaleElapsedTimeBySpeed = !!savedPlayerSettings.scaleElapsedTimeBySpeed
      }
    },
    savePlayerSettings() {
      return this.$localStore.setPlayerSettings({ ...this.playerSettings })
    },
    //
    // Listeners from audio AbsAudioPlayer
    //
    onPlayingUpdate(data) {
      console.log('onPlayingUpdate', JSON.stringify(data))
      this.isPlaying = !!data.value
      this.$store.commit('setPlayerPlaying', this.isPlaying)
      if (this.isPlaying) {
        this.startPlayInterval()
      } else {
        this.stopPlayInterval()
      }
    },
    onMetadata(data) {
      console.log('onMetadata', JSON.stringify(data))
      this.totalDuration = Number(data.duration.toFixed(2))
      this.currentTime = Number(data.currentTime.toFixed(2))

      // Done loading
      if (data.playerState !== 'BUFFERING' && data.playerState !== 'IDLE') {
        this.isLoading = false
      }

      if (data.playerState === 'ENDED') {
        console.log('[AudioPlayer] Playback ended')
      }
      this.isEnded = data.playerState === 'ENDED'

      console.log('received metadata update', data)

      this.timeupdate()
    },
    // When a playback session is started the native android/ios will send the session
    onPlaybackSession(playbackSession) {
      console.log('onPlaybackSession received', JSON.stringify(playbackSession))
      this.playbackSession = playbackSession

      this.isEnded = false
      this.isLoading = true
      this.syncStatus = 0
      this.$store.commit('setPlaybackSession', this.playbackSession)

      // Set track width
      this.$nextTick(() => {
        if (this.titleMarquee) this.titleMarquee.reset()
        this.titleMarquee = new WrappingMarquee(this.$refs.titlewrapper)
        this.titleMarquee.init(this.title)

        if (this.$refs.track) {
          this.trackWidth = this.$refs.track.clientWidth
        } else {
          console.error('Track not loaded', this.$refs)
        }
      })
    },
    onPlaybackClosed() {
      this.endPlayback()
    },
    onPlaybackFailed(data) {
      console.log('Received onPlaybackFailed evt')
      var errorMessage = data.value || 'Unknown Error'
      this.$toast.error(`Playback Failed: ${errorMessage}`)
      this.endPlayback()
    },
    onPlaybackSpeedChanged(data) {
      if (!data.value || isNaN(data.value)) return
      this.currentPlaybackRate = Number(data.value)
      this.updateTimestamp()
    },
    async init() {
      await this.loadPlayerSettings()

      AbsAudioPlayer.addListener('onPlaybackSession', this.onPlaybackSession)
      AbsAudioPlayer.addListener('onPlaybackClosed', this.onPlaybackClosed)
      AbsAudioPlayer.addListener('onPlaybackFailed', this.onPlaybackFailed)
      AbsAudioPlayer.addListener('onPlayingUpdate', this.onPlayingUpdate)
      AbsAudioPlayer.addListener('onMetadata', this.onMetadata)
      AbsAudioPlayer.addListener('onProgressSyncFailing', this.showProgressSyncIsFailing)
      AbsAudioPlayer.addListener('onProgressSyncSuccess', this.hideProgressSyncIsFailing)
      AbsAudioPlayer.addListener('onPlaybackSpeedChanged', this.onPlaybackSpeedChanged)

      // Check for last playback session on app start
      await this.checkForLastPlaybackSession()
    },
    async checkForLastPlaybackSession() {
      try {
        // Only check on first app load and if no current session
        if (!this.$store.state.isFirstAudioLoad || this.$store.state.currentPlaybackSession) {
          return
        }

        console.log('[AudioPlayer] Checking for last playback session to resume')
        const lastSession = await this.$store.dispatch('loadLastPlaybackSession')

        if (lastSession) {
          // Check if this session is worth resuming (not at the very beginning)
          const progress = lastSession.currentTime / lastSession.duration
          if (progress > 0.01) {
            console.log(`[AudioPlayer] Found resumable session: ${lastSession.displayTitle} at ${Math.floor(progress * 100)}%`)

            // For now, just log that we found a resumable session
            // The native Android/iOS will handle the actual resume logic
            // This gives us the foundation for future UI prompts like "Resume where you left off?"
          }
        }
      } catch (error) {
        console.error('[AudioPlayer] Failed to check for last playback session', error)
      }
    },
    async resumeFromLastSession() {
      try {
        console.log('[AudioPlayer] Attempting to resume from last session')
        await AbsAudioPlayer.resumeLastPlaybackSession()
        console.log('[AudioPlayer] Successfully resumed from last session')
      } catch (error) {
        console.error('[AudioPlayer] Failed to resume from last session', error)
        throw error
      }
    },
    async screenOrientationChange() {
      if (this.isRefreshingUI) return
      this.isRefreshingUI = true
      const windowWidth = window.innerWidth
      this.refreshUI()

      // Window width does not always change right away. Wait up to 250ms for a change.
      // iPhone 10 on iOS 16 took between 100 - 200ms to update when going from portrait to landscape
      //   but landscape to portrait was immediate
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (window.innerWidth !== windowWidth) {
          this.refreshUI()
          break
        }
      }

      this.isRefreshingUI = false
    },
    refreshUI() {
      this.updateScreenSize()
      if (this.$refs.track) {
        this.trackWidth = this.$refs.track.clientWidth
        this.updateTrack()
        this.updateReadyTrack()
      }
    },
    updateScreenSize() {
      setTimeout(() => {
        if (this.titleMarquee) this.titleMarquee.init(this.title)
      }, 500)

      this.windowHeight = window.innerHeight
      this.windowWidth = window.innerWidth
      const coverHeight = this.fullscreenBookCoverWidth * this.bookCoverAspectRatio
      const coverImageWidthCollapsed = 46 / this.bookCoverAspectRatio
      const titleAuthorLeftOffsetCollapsed = 30 + coverImageWidthCollapsed
      const titleAuthorWidthCollapsed = this.windowWidth - 128 - titleAuthorLeftOffsetCollapsed - 10

      document.documentElement.style.setProperty('--cover-image-width', this.fullscreenBookCoverWidth + 'px')
      document.documentElement.style.setProperty('--cover-image-height', coverHeight + 'px')
      document.documentElement.style.setProperty('--cover-image-width-collapsed', coverImageWidthCollapsed + 'px')
      document.documentElement.style.setProperty('--cover-image-height-collapsed', 46 + 'px')
      document.documentElement.style.setProperty('--title-author-left-offset-collapsed', titleAuthorLeftOffsetCollapsed + 'px')
      document.documentElement.style.setProperty('--title-author-width-collapsed', titleAuthorWidthCollapsed + 'px')
    },
    minimizePlayerEvt() {
      this.collapseFullscreen()
    },
    showProgressSyncIsFailing() {
      this.syncStatus = this.$constants.SyncStatus.FAILED
    },
    showProgressSyncSuccess() {
      this.syncStatus = this.$constants.SyncStatus.SUCCESS
    }
  },
  mounted() {
    this.updateScreenSize()
    if (screen.orientation) {
      // Not available on ios
      screen.orientation.addEventListener('change', this.screenOrientationChange)
    } else {
      document.addEventListener('orientationchange', this.screenOrientationChange)
    }
    window.addEventListener('resize', this.screenOrientationChange)

    this.$eventBus.$on('minimize-player', this.minimizePlayerEvt)
    document.body.addEventListener('touchstart', this.touchstart, { passive: false })
    document.body.addEventListener('touchend', this.touchend)
    document.body.addEventListener('touchmove', this.touchmove)
    this.$nextTick(this.init)
  },
  beforeDestroy() {
    if (screen.orientation) {
      // Not available on ios
      screen.orientation.removeEventListener('change', this.screenOrientationChange)
    } else {
      document.removeEventListener('orientationchange', this.screenOrientationChange)
    }
    window.removeEventListener('resize', this.screenOrientationChange)

    if (this.playbackSession) {
      console.log('[AudioPlayer] Before destroy closing playback')
      this.closePlayback()
    }

    this.forceCloseDropdownMenu()
    this.$eventBus.$off('minimize-player', this.minimizePlayerEvt)
    document.body.removeEventListener('touchstart', this.touchstart)
    document.body.removeEventListener('touchend', this.touchend)
    document.body.removeEventListener('touchmove', this.touchmove)

    if (AbsAudioPlayer.removeAllListeners) {
      AbsAudioPlayer.removeAllListeners()
    }
    clearInterval(this.playInterval)
  }
}
</script>

<style>
:root {
  --cover-image-width: 0px;
  --cover-image-height: 0px;
  --cover-image-width-collapsed: 48px;
  --cover-image-height-collapsed: 48px;
  --title-author-left-offset-collapsed: 80px;
  --title-author-width-collapsed: 40%;
}

/* Mini player components */
.cover-wrapper-mini {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--md-sys-elevation-surface-container-low);
  flex-shrink: 0;
}

.play-btn-mini {
  width: 40px;
  height: 40px;
  background: var(--md-sys-color-primary);
  box-shadow: var(--md-sys-elevation-fab-primary);
}

.play-btn-mini .material-symbols {
  font-size: 1.5rem;
  color: var(--md-sys-color-on-primary);
}

/* Material 3 Expressive Player Transition System */
#streamContainer {
  transition: all 300ms cubic-bezier(0.2, 0, 0, 1);
}

#streamContainer.player-expanding {
  transition: all 700ms cubic-bezier(0.05, 0.7, 0.1, 1) !important;
}

#streamContainer.player-collapsing {
  transition: all 500ms cubic-bezier(0.3, 0, 0.8, 0.15) !important;
}

.playerContainer {
  height: 80px;
  background: rgba(var(--md-sys-color-surface-container-rgb), 0.85);
  backdrop-filter: blur(20px);
  border-radius: 16px;
  box-shadow: var(--md-sys-elevation-surface-container-high);
  margin: 0;
  transition: all 300ms cubic-bezier(0.2, 0, 0, 1);
  transition-property: height, border-radius, background-color, backdrop-filter, transform;
}

.player-expanding .playerContainer {
  transition: all 700ms cubic-bezier(0.05, 0.7, 0.1, 1) !important;
}

.player-collapsing .playerContainer {
  transition: all 500ms cubic-bezier(0.3, 0, 0.8, 0.15) !important;
}

.fullscreen .playerContainer {
  height: 200px;
  transform: scale(1);
}
#playerContent {
  box-shadow: var(--md-sys-elevation-surface-container-high);
  border-radius: 16px;
  background: rgba(var(--md-sys-color-surface-container-rgb), 0.85);
  backdrop-filter: blur(20px);
  margin: 0; /* Remove all margins - positioning handled by container */
}
.fullscreen #playerContent {
  box-shadow: none;
}

#playerTrack {
  transition: all 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  transition-property: margin;
  bottom: 43px;
}
#progressBarsContainer {
  bottom: 260px; /* More space above the buttons that are now at the bottom */
  left: 0;
  right: 0;
  z-index: 20;
}

.cover-wrapper {
  bottom: 76px;
  left: 16px;
  height: var(--cover-image-height-collapsed);
  width: var(--cover-image-width-collapsed);
  transition: all 0.25s cubic-bezier(0.39, 0.575, 0.565, 1);
  transition-property: left, bottom, width, height;
  transform-origin: left bottom;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--md-sys-elevation-surface-container-low);
}

.cover-wrapper-fullscreen {
  border-radius: 16px;
  overflow: hidden;
  box-shadow: var(--md-sys-elevation-surface-container-low);
}

.title-author-texts {
  transition: all 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  transition-property: left, bottom, width, height;
  transform-origin: left bottom;

  width: var(--title-author-width-collapsed);
  bottom: 84px;
  left: var(--title-author-left-offset-collapsed);
  text-align: left;
}
.title-author-texts .title-text {
  transition: all 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  transition-property: font-size;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--md-sys-color-on-surface);
  font-weight: 500;
}
.title-author-texts .author-text {
  transition: all 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  transition-property: font-size;
  font-size: 0.75rem;
  line-height: 1.2;
  color: var(--md-sys-color-on-surface-variant);
}

#playerControls {
  transition: all 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  transition-property: width, bottom;
  width: 128px;
  padding-right: 16px;
  bottom: 78px;
}
#playerControls .jump-icon {
  transition: all 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  transition-property: font-size;

  margin: 0px 0px;
  font-size: 1.6rem;
  color: var(--md-sys-color-on-surface-variant);
}
#playerControls .play-btn {
  transition: all 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  transition-property: padding, margin, height, width, min-width, min-height;

  height: 48px;
  width: 48px;
  min-width: 48px;
  min-height: 48px;
  margin: 0px 8px;
  background: var(--md-sys-color-primary) !important;
  box-shadow: var(--md-sys-elevation-fab-primary);
}
#playerControls .play-btn .material-symbols {
  transition: all 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  transition-property: font-size;

  font-size: 1.75rem;
  color: var(--md-sys-color-on-primary);
}

/* Material 3 Expressive Cover Animation - Removed, now uses simple layout */

/* Fullscreen player controls styling */
.fullscreen #playerControls .w-16 {
  width: 4rem !important;
  height: 4rem !important;
}

.fullscreen #playerControls .w-12 {
  width: 3rem !important;
  height: 3rem !important;
}

.fullscreen {
  background: rgb(var(--md-sys-color-surface));
}

/* Disable transitions during swipe for real-time animation */
.fullscreen-player .cover-wrapper.no-transition {
  transition: none !important;
  transform: unset !important;
  opacity: unset !important;
}

.player-expanding .cover-wrapper {
  transition: all 700ms cubic-bezier(0.05, 0.7, 0.1, 1) !important;
}

.player-collapsing .cover-wrapper {
  transition: all 500ms cubic-bezier(0.3, 0, 0.8, 0.15) !important;
}

.fullscreen .cover-wrapper {
  transform: scale(1) rotate(0deg) !important;
}

/* Material 3 Player Slide & Fade Transitions */

/* Full Screen Player Animations */
.fullscreen-player {
  transition-property: opacity;
  transition-duration: 400ms;
  transition-timing-function: cubic-bezier(0.05, 0.7, 0.1, 1);
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
}

/* Disable transitions during swipe for immediate response */
.fullscreen-player.no-transition {
  transition: none !important;
  animation: none !important;
}

/* Disable all transitions and animations in fullscreen mode to prevent unwanted animations */
.fullscreen-player * {
  transition: none !important;
  animation: none !important;
}

.fullscreen-player button {
  transition: none !important;
  animation: none !important;
}

/* Fullscreen player entrance/exit animations removed for cleaner transitions */

@keyframes fullscreenSlideIn {
  0% {
    opacity: 0;
    transform: translateY(20px) scale(0.9);
  }
  60% {
    opacity: 0.8;
    transform: translateY(-2px) scale(1.01);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes fullscreenSlideOut {
  0% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  40% {
    opacity: 0.6;
    transform: translateY(8px) scale(0.98);
  }
  100% {
    opacity: 0;
    transform: translateY(20px) scale(0.9);
  }
}

/* Mini Player Animations */
.mini-player {
  opacity: 1;
  transform: translateY(0);
  transition: all 600ms cubic-bezier(0.05, 0.7, 0.1, 1);
  transition-property: opacity;
}

.mini-player.mini-exiting {
  animation: miniSlideOut 600ms cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}

.mini-player.mini-entering {
  animation: miniSlideIn 400ms cubic-bezier(0.3, 0, 0.8, 0.15) forwards;
}

@keyframes miniSlideOut {
  0% {
    opacity: 1;
    transform: translateY(0);
  }
  70% {
    opacity: 0.3;
    transform: translateY(-30px);
  }
  100% {
    opacity: 0;
    transform: translateY(-50px);
  }
}

@keyframes miniSlideIn {
  0% {
    opacity: 0;
    transform: translateY(-50px);
  }
  30% {
    opacity: 0.3;
    transform: translateY(-30px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Fullscreen States - Simplified (animations removed) */

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes fadeOut {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

/* Complex morphing animations removed for cleaner transitions */

/* Ensure smooth interaction during transitions */
.mini-exiting,
.mini-entering,
.fullscreen-entering,
.fullscreen-exiting {
  pointer-events: none;
}

/* Re-enable pointer events when animations complete */
.mini-player:not(.mini-exiting):not(.mini-entering),
.fullscreen-player:not(.fullscreen-entering):not(.fullscreen-exiting) {
  pointer-events: auto;
}
</style>
