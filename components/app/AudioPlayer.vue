<template>
  <!-- Root wrapper required because we have two sibling root elements (shared cover + sheet) -->
  <div>
    <!-- ─── Player sheet ─────────────────────────────────────────────────────────
         Unified container for the mini bar and full-screen player.
         playerSheetStyle interpolates height, bottom offset, and border-radius. -->
    <div
      v-show="playbackSession"
      id="playerSheet"
      class="bg-surface-dynamic"
      :class="{
        fullscreen: showFullscreen,
        'ios-player': $platform === 'ios',
        'web-player': $platform === 'web'
      }"
      :style="playerSheetStyle"
      @touchstart="handleTouchStart"
      @touchmove="handleTouchMove"
      @touchend="handleTouchEnd"
    >
      <!-- ─── Full-screen layer ──────────────────────────────────────────────────
           Always in the DOM; fullLayerStyle controls opacity and pointer-events.
           position:absolute fills the player sheet. -->
      <div class="fullscreen-container absolute inset-0 pointer-events-auto bg-surface-dynamic" :class="{ 'landscape-layout': isLandscape }" :style="fullLayerStyle">
        <!-- Background coverage -->
        <div class="absolute inset-0 pointer-events-none bg-surface-dynamic" />

        <!-- Drag handle pill — tap to collapse -->
        <div class="absolute top-0 left-0 right-0 flex justify-center pt-2 pb-1 z-50" style="pointer-events: auto" @click="animateTo(0)">
          <div class="w-9 h-1 rounded-full bg-on-surface-variant opacity-30" />
        </div>

        <div class="top-4 left-4 absolute">
          <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-2 transition-all duration-200 hover:shadow-elevation-3 active:scale-95" @click="animateTo(0)">
            <span class="material-symbols text-2xl text-on-surface">keyboard_arrow_down</span>
          </button>
        </div>
        <div v-show="showCastBtn" class="top-4 right-36 absolute">
          <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-2 transition-all duration-200 hover:shadow-elevation-3 active:scale-95" @click="castClick">
            <span class="material-symbols text-xl text-on-surface">{{ isCasting ? 'cast_connected' : 'cast' }}</span>
          </button>
        </div>
        <div class="top-4 right-20 absolute">
          <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-2 transition-all duration-200 hover:shadow-elevation-3 active:scale-95" :disabled="!chapters.length" @click="clickChaptersBtn">
            <span class="material-symbols text-xl text-on-surface" :class="chapters.length ? '' : 'opacity-30'">format_list_bulleted</span>
          </button>
        </div>
        <div class="top-4 right-4 absolute">
          <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-2 transition-all duration-200 hover:shadow-elevation-3 active:scale-95" @click="showMoreMenuDialog = true">
            <span class="material-symbols text-xl text-on-surface">more_vert</span>
          </button>
        </div>
        <p v-if="!isLandscape" class="top-16 absolute left-0 right-0 mx-auto text-center uppercase tracking-widest text-on-surface-variant opacity-75" style="font-size: 10px">{{ isDirectPlayMethod ? $strings.LabelPlaybackDirect : isLocalPlayMethod ? $strings.LabelPlaybackLocal : $strings.LabelPlaybackTranscode }}</p>

        <!-- Portrait Layout (existing) -->
        <template v-if="!isLandscape">
          <!-- Fullscreen Cover — portrait.
             The actual image is the shared cover element (position:fixed above the sheet).
             This spacer keeps the flex layout so controls are pushed to their expected positions. -->
          <div class="cover-wrapper-portrait flex justify-center items-start pointer-events-auto" @click="animateTo(0)">
            <div class="cover-container">
              <!-- Invisible placeholder matching full-cover dimensions -->
              <div :style="{ width: fullCoverWidth + 'px', height: fullCoverHeight + 'px' }" />
            </div>
          </div>

          <!-- Fullscreen Controls with responsive positioning -->
          <div id="playerControls" class="controls-container-portrait pointer-events-auto">
            <!-- Main playback controls row -->
            <div class="flex items-center max-w-full mb-4" :class="playerSettings.lockUi ? 'justify-center' : 'justify-between'">
              <button v-show="showFullscreen && !playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" :disabled="isLoading" @click.stop="jumpChapterStart">
                <span class="material-symbols text-xl text-on-surface" :class="isLoading ? 'opacity-30' : ''">first_page</span>
              </button>
              <button v-show="!playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" :disabled="isLoading" @click.stop="jumpBackwards">
                <span class="material-symbols text-xl text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpBackwardsIcon }}</span>
              </button>
              <button
                class="expressive-play-btn w-[72px] h-[72px] bg-primary text-on-primary flex items-center justify-center shadow-elevation-3 transition-all duration-300 ease-expressive hover:shadow-elevation-4 active:scale-95 mx-4 relative overflow-hidden"
                :class="[isPlaying ? 'is-playing' : 'is-paused', { 'animate-spin': seekLoading }]"
                :disabled="isLoading"
                @mousedown.prevent
                @mouseup.prevent
                @click.stop="playPauseClick"
              >
                <span v-if="!isLoading" class="material-symbols text-3xl text-on-primary">{{ seekLoading ? 'autorenew' : !isPlaying ? 'play_arrow' : 'pause' }}</span>
                <widgets-spinner-icon v-else class="h-7 w-7" />
              </button>
              <button v-show="!playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" :disabled="isLoading" @click.stop="jumpForward">
                <span class="material-symbols text-xl text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpForwardIcon }}</span>
              </button>
              <button v-show="showFullscreen && !playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" :disabled="!nextChapter || isLoading" @click.stop="jumpNextChapter">
                <span class="material-symbols text-xl text-on-surface" :class="nextChapter && !isLoading ? '' : 'opacity-30'">last_page</span>
              </button>
            </div>

            <!-- Secondary controls row - Sleep Timer, Speed, and Bookmarks -->
            <div v-show="showFullscreen && !playerSettings.lockUi" class="flex items-center justify-center space-x-8">
              <!-- Sleep Timer Button (under and between back and play buttons) -->
              <button v-if="!sleepTimerRunning" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click.stop="$emit('showSleepTimer')">
                <span class="material-symbols text-xl text-on-surface">bedtime</span>
              </button>
              <button v-else class="px-3 py-2 rounded-full bg-tertiary-container text-on-tertiary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click.stop="$emit('showSleepTimer')">
                <span class="text-sm font-mono font-medium">{{ sleepTimeRemainingPretty }}</span>
              </button>

              <!-- Speed Button (under and between play and forward buttons) -->
              <button class="px-4 py-2 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click="$emit('selectPlaybackSpeed')">
                <span class="font-mono text-sm font-medium">{{ currentPlaybackRate }}x</span>
              </button>

              <!-- Bookmarks Button -->
              <button class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click="$emit('showBookmarks')">
                <span class="material-symbols text-xl text-on-surface" :class="{ fill: bookmarks.length }">bookmark</span>
              </button>
            </div>
          </div>

          <!-- Progress Bars Container - manages both tracks -->
          <div v-if="showFullscreen" id="progressBarsContainer" class="absolute left-0 right-0 mx-auto w-full px-6" style="max-width: 414px; bottom: 280px">
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
                <p class="font-mono text-on-surface text-sm" ref="currentTimestampFull">0:00</p>
                <div class="flex-grow" />
                <p class="font-mono text-on-surface text-sm">{{ timeRemainingPretty }}</p>
              </div>
              <div ref="trackFull" class="expressive-track h-3 w-full relative rounded-full bg-surface-variant shadow-inner cursor-pointer transition-all duration-200 ease-expressive hover:bg-surface-variant/80 hover:shadow-md active:bg-surface-variant/90 select-none" :class="{ 'animate-pulse': isLoading }" @click.stop="seekToPosition" @mousedown="startDragSeek" @touchstart="startDragSeek">
                <div ref="readyTrackFull" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-outline transition-all duration-500 ease-expressive" />
                <div ref="bufferedTrackFull" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-on-surface-variant transition-all duration-500 ease-expressive" />
                <div ref="playedTrackFull" class="expressive-played h-full absolute top-0 left-0 rounded-full pointer-events-none bg-primary transition-all duration-300 ease-expressive hover:bg-primary/90" />
                <div
                  ref="trackCursorFull"
                  class="h-7 w-7 rounded-full absolute pointer-events-auto flex items-center justify-center shadow-elevation-3 bg-primary ring-4 ring-primary ring-opacity-25 transition-all duration-200 ease-expressive hover:scale-110 hover:shadow-elevation-3 active:scale-95 active:shadow-elevation-1"
                  :style="{ top: '-10px' }"
                  :class="{ 'opacity-0': playerSettings.lockUi || !showFullscreen }"
                  @touchstart.stop="touchstartCursor"
                >
                  <div class="rounded-full w-3 h-3 pointer-events-none bg-on-primary transition-all duration-200 ease-expressive" />
                </div>
              </div>
            </div>
          </div>

          <!-- Fullscreen Title and Author - positioned below progress bars -->
          <div v-if="showFullscreen" class="title-author-texts absolute z-30 left-0 right-0 bottom-48 px-6 text-center overflow-hidden" @click="clickTitleAndAuthor">
            <div ref="titlewrapper" class="overflow-hidden relative">
              <p class="title-text whitespace-nowrap text-on-surface text-lg font-medium">{{ title }}</p>
            </div>
            <p class="author-text text-on-surface-variant text-sm truncate">{{ authorName }}</p>
          </div>
        </template>

        <!-- Landscape Layout -->
        <template v-else>
          <!-- Top Action Bar for Landscape -->
          <div class="landscape-top-bar absolute top-0 left-0 right-0 z-40 flex items-center justify-between p-3" style="height: 60px">
            <!-- Left: Close Button -->
            <button class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click="animateTo(0)">
              <span class="material-symbols text-xl text-on-surface">keyboard_arrow_down</span>
            </button>

            <!-- Right: Action Buttons -->
            <div class="flex items-center space-x-2">
              <button v-show="showCastBtn" class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click="castClick">
                <span class="material-symbols text-lg text-on-surface">{{ isCasting ? 'cast_connected' : 'cast' }}</span>
              </button>
              <button class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" :disabled="!chapters.length" @click="clickChaptersBtn">
                <span class="material-symbols text-lg text-on-surface" :class="chapters.length ? '' : 'opacity-30'">format_list_bulleted</span>
              </button>
              <button class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click="showMoreMenuDialog = true">
                <span class="material-symbols text-lg text-on-surface">more_vert</span>
              </button>
            </div>
          </div>

          <!-- Landscape Content Container with flexible grid -->
          <div class="landscape-content-container flex" :style="{ top: '60px', height: `calc(100vh - 60px - ${fullscreenTopPadding})`, padding: '20px' }">
            <!-- Left Side: Cover — spacer only; actual image is the shared cover element -->
            <div class="landscape-cover-section flex items-center justify-center" style="flex: 0 0 45%; min-width: 0">
              <div class="cover-wrapper-landscape relative pointer-events-auto" @click="animateTo(0)">
                <div class="cover-container-landscape">
                  <!-- Invisible placeholder matching landscape cover dimensions -->
                  <div :style="{ width: landscapeBookCoverWidth + 'px', height: landscapeBookCoverWidth * bookCoverAspectRatio + 'px' }" />

                  <div v-if="syncStatus === $constants.SyncStatus.FAILED" class="absolute inset-0 flex items-center justify-center z-10" @click.stop="showSyncsFailedDialog">
                    <span class="material-symbols text-error text-3xl">error</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Right Side: Controls and Content -->
            <div class="landscape-controls-section flex flex-col justify-center overflow-hidden" style="flex: 1; min-width: 0; padding-left: 20px">
              <!-- Title and Author -->
              <div class="title-author-texts-landscape mb-4 text-left">
                <div ref="titlewrapper" class="overflow-hidden relative">
                  <p class="title-text whitespace-nowrap text-on-surface text-xl font-medium truncate">{{ title }}</p>
                </div>
                <p class="author-text text-on-surface-variant text-base truncate mt-1">{{ authorName }}</p>
              </div>

              <!-- Progress Bars Container -->
              <div class="landscape-progress-container mb-4">
                <!-- Total Progress Track (shown when both tracks enabled) -->
                <div v-if="playerSettings.useChapterTrack && playerSettings.useTotalTrack" class="mb-3">
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
                  <div class="flex pointer-events-none mb-1">
                    <p class="font-mono text-on-surface text-sm" ref="currentTimestampFull">0:00</p>
                    <div class="flex-grow" />
                    <p class="font-mono text-on-surface text-sm">{{ timeRemainingPretty }}</p>
                  </div>
                  <div ref="trackFull" class="expressive-track h-3 w-full relative rounded-full bg-surface-variant shadow-inner cursor-pointer transition-all duration-200 ease-expressive hover:bg-surface-variant/80 hover:shadow-md active:bg-surface-variant/90 select-none" :class="{ 'animate-pulse': isLoading }" @click.stop="seekToPosition" @mousedown="startDragSeek" @touchstart="startDragSeek">
                    <div ref="readyTrackFull" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-outline transition-all duration-500 ease-expressive" />
                    <div ref="bufferedTrackFull" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-on-surface-variant transition-all duration-500 ease-expressive" />
                    <div ref="playedTrackFull" class="expressive-played h-full absolute top-0 left-0 rounded-full pointer-events-none bg-primary transition-all duration-300 ease-expressive hover:bg-primary/90" />
                    <div
                      ref="trackCursorFull"
                      class="h-7 w-7 rounded-full absolute pointer-events-auto flex items-center justify-center shadow-elevation-3 bg-primary ring-4 ring-primary ring-opacity-25 transition-all duration-200 ease-expressive hover:scale-110 hover:shadow-elevation-3 active:scale-95 active:shadow-elevation-1"
                      :style="{ top: '-10px' }"
                      :class="{ 'opacity-0': playerSettings.lockUi || !showFullscreen }"
                      @touchstart.stop="touchstartCursor"
                    >
                      <div class="rounded-full w-3 h-3 pointer-events-none bg-on-primary transition-all duration-200 ease-expressive" />
                    </div>
                  </div>
                </div>
              </div>

              <!-- Main playback controls -->
              <div class="landscape-main-controls flex items-center justify-center mb-3">
                <button v-show="!playerSettings.lockUi" class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95 mr-2" :disabled="isLoading" @click.stop="jumpChapterStart">
                  <span class="material-symbols text-lg text-on-surface" :class="isLoading ? 'opacity-30' : ''">first_page</span>
                </button>
                <button v-show="!playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95 mr-2" :disabled="isLoading" @click.stop="jumpBackwards">
                  <span class="material-symbols text-xl text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpBackwardsIcon }}</span>
                </button>
                <button
                  class="expressive-play-btn w-[72px] h-[72px] bg-primary text-on-primary flex items-center justify-center shadow-elevation-3 transition-all duration-300 ease-expressive hover:shadow-elevation-4 active:scale-95 mx-3 relative overflow-hidden"
                  :class="[isPlaying ? 'is-playing' : 'is-paused', { 'animate-spin': seekLoading }]"
                  :disabled="isLoading"
                  @mousedown.prevent
                  @mouseup.prevent
                  @click.stop="playPauseClick"
                >
                  <span v-if="!isLoading" class="material-symbols text-3xl text-on-primary">{{ seekLoading ? 'autorenew' : !isPlaying ? 'play_arrow' : 'pause' }}</span>
                  <widgets-spinner-icon v-else class="h-7 w-7" />
                </button>
                <button v-show="!playerSettings.lockUi" class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95 ml-2" :disabled="isLoading" @click.stop="jumpForward">
                  <span class="material-symbols text-xl text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpForwardIcon }}</span>
                </button>
                <button v-show="!playerSettings.lockUi" class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95 ml-2" :disabled="!nextChapter || isLoading" @click.stop="jumpNextChapter">
                  <span class="material-symbols text-lg text-on-surface" :class="nextChapter && !isLoading ? '' : 'opacity-30'">last_page</span>
                </button>
              </div>

              <!-- Secondary controls row - Sleep Timer, Speed, and Bookmarks -->
              <div v-show="!playerSettings.lockUi" class="landscape-secondary-controls flex items-center justify-center space-x-3 mt-2">
                <!-- Sleep Timer Button -->
                <button v-if="!sleepTimerRunning" class="w-9 h-9 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click.stop="$emit('showSleepTimer')">
                  <span class="material-symbols text-base text-on-surface">bedtime</span>
                </button>
                <button v-else class="px-2 py-1 rounded-full bg-tertiary-container text-on-tertiary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click.stop="$emit('showSleepTimer')">
                  <span class="text-xs font-mono font-medium">{{ sleepTimeRemainingPretty }}</span>
                </button>

                <!-- Speed Button -->
                <button class="px-3 py-1 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click="$emit('selectPlaybackSpeed')">
                  <span class="font-mono text-xs font-medium">{{ currentPlaybackRate }}x</span>
                </button>

                <!-- Bookmarks Button -->
                <button class="w-9 h-9 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95" @click="$emit('showBookmarks')">
                  <span class="material-symbols text-base text-on-surface" :class="{ fill: bookmarks.length }">bookmark</span>
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- ─── Mini-player layer ─────────────────────────────────────────────────
           position:absolute at the bottom of the sheet.
           miniLayerStyle fades it out as the sheet expands and also carries
           the horizontal swipe-to-dismiss translateX. -->
      <div id="playerContent" class="playerContainer w-full bg-player-overlay backdrop-blur-sm shadow-elevation-3 border-t border-outline-variant border-opacity-20" :style="miniLayerStyle">
        <!-- Mini bar layout: Cover placeholder → Text → Controls -->
        <div class="flex items-center h-full px-2 pb-4">
          <!-- Cover placeholder: invisible div that matches the mini cover dimensions
               so the text and controls are correctly pushed to the right.
               The actual cover image is the shared element above the sheet. -->
          <div class="cover-wrapper-mini flex-shrink-0 mr-2" style="visibility: hidden" />

          <!-- Text Content -->
          <div class="flex-1 min-w-0 mr-2" @click="animateTo(1)">
            <div ref="titlewrapper" class="overflow-hidden relative">
              <p class="title-text whitespace-nowrap truncate text-on-surface text-sm font-medium">{{ title }}</p>
            </div>
            <p class="author-text text-on-surface-variant text-xs truncate">{{ authorName }}</p>
          </div>

          <!-- Controls -->
          <div class="flex items-center flex-shrink-0">
            <button v-show="!playerSettings.lockUi" class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95 mr-1" :disabled="isLoading" @click.stop="jumpBackwards">
              <span class="material-symbols text-lg text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpBackwardsIcon }}</span>
            </button>
            <button
              class="expressive-play-btn expressive-play-btn--mini w-12 h-12 bg-primary text-on-primary flex items-center justify-center shadow-elevation-2 transition-all duration-300 ease-expressive hover:shadow-elevation-3 active:scale-95 mx-2 relative overflow-hidden"
              :class="[isPlaying ? 'is-playing' : 'is-paused', { 'animate-spin': seekLoading }]"
              :disabled="isLoading"
              @mousedown.prevent
              @mouseup.prevent
              @click.stop="playPauseClick"
            >
              <span v-if="!isLoading" class="material-symbols text-xl text-on-primary">{{ seekLoading ? 'autorenew' : !isPlaying ? 'play_arrow' : 'pause' }}</span>
              <widgets-spinner-icon v-else class="h-5 w-5" />
            </button>
            <button v-show="!playerSettings.lockUi" class="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-elevation-1 transition-all duration-200 hover:shadow-elevation-2 active:scale-95 ml-1" :disabled="isLoading" @click.stop="jumpForward">
              <span class="material-symbols text-lg text-on-surface" :class="isLoading ? 'opacity-30' : ''">{{ jumpForwardIcon }}</span>
            </button>
          </div>
        </div>

        <!-- Mini Progress Bar -->
        <div id="playerTrackMini" class="absolute bottom-2 left-0 w-full px-2">
          <div
            ref="trackMini"
            class="expressive-track expressive-track--mini h-1.5 w-full relative rounded-full bg-surface-variant shadow-inner cursor-pointer transition-all duration-200 ease-expressive hover:bg-surface-variant/80 hover:shadow-md active:bg-surface-variant/90 select-none"
            :class="{ 'animate-pulse': isLoading }"
            @click.stop="seekToPosition"
            @mousedown="startDragSeek"
            @touchstart.stop="startDragSeek"
          >
            <div ref="readyTrackMini" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-outline transition-all duration-500 ease-expressive" />
            <div ref="bufferedTrackMini" class="h-full absolute top-0 left-0 rounded-full pointer-events-none bg-on-surface-variant transition-all duration-500 ease-expressive" />
            <div ref="playedTrackMini" class="expressive-played h-full absolute top-0 left-0 rounded-full pointer-events-none bg-primary transition-all duration-300 ease-expressive hover:bg-primary/90" />
          </div>
        </div>
      </div>

      <modals-chapters-modal v-model="showChapterModal" :current-chapter="currentChapter" :chapters="chapters" :playback-rate="currentPlaybackRate" @select="selectChapter" />
      <modals-dialog v-model="showMoreMenuDialog" :items="menuItems" width="80vw" @action="clickMenuAction" />
      <modals-cast-device-selection-modal ref="castDeviceModal" @cast-device-connected="onCastDeviceConnected" @cast-device-disconnected="onCastDeviceDisconnected" />
    </div>

    <!-- ─── Shared cover ────────────────────────────────────────────────────────
         MUST be after playerSheet in DOM: browsers clamp z-index at INT32_MAX so
         when both share the same effective z-index, later DOM order wins. -->
    <div v-if="playbackSession && (libraryItem || localLibraryItemCoverSrc)" id="sharedCoverWrapper" :style="sharedCoverStyle" @click="onSharedCoverTap">
      <covers-book-cover ref="cover" :library-item="libraryItem" :download-cover="localLibraryItemCoverSrc" :width="fullCoverWidth" :book-cover-aspect-ratio="bookCoverAspectRatio" raw @imageLoaded="coverImageLoaded" />
      <div v-if="syncStatus === $constants.SyncStatus.FAILED" class="absolute inset-0 flex items-center justify-center z-10" @click.stop="showSyncsFailedDialog">
        <span class="material-symbols text-error text-3xl">error</span>
      </div>
    </div>
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
      // expandProgress: 0 = fully mini, 1 = fully full-screen
      // This drives ALL animation; showFullscreen is a computed alias.
      expandProgress: 0,
      // dragMode: 'none' | 'expand' | 'collapse' — set during interactive drag
      dragMode: 'none',
      miniBarHeight: 80, // matches CSS .playerContainer { height: 80px }
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
      // Chapter transition debouncing
      lastChapterTransitionTime: 0,
      chapterTransitionCooldown: 500, // 500ms cooldown
      touchStartY: 0,
      touchStartTime: 0,
      swipeOffset: 0,
      isSwipeActive: false,
      swipeStartY: 0,
      // Horizontal swipe state for closing mini player
      swipeStartX: 0,
      swipeOffsetX: 0,
      isHorizontalSwipeActive: false,
      horizontalSwipeThreshold: 80,
      // Gesture axis locking: 'none' | 'vertical' | 'horizontal'
      gestureAxis: 'none',
      // Minimum move (px) before deciding axis
      gestureDetectionThreshold: 8,
      swipeThreshold: 50, // pixels to trigger fullscreen
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
      // New drag-to-seek properties
      isDraggingSeek: false,
      draggingTrackElement: null,
      draggingStartTime: 0,
      draggingStartX: 0,
      draggingTrackRect: null,
      syncStatus: 0,
      showMoreMenuDialog: false,
      titleMarquee: null,
      isRefreshingUI: false,
      fullscreenTopPadding: '0px',
      miniPlayerPositionsReady: false,
      _safeAreaObserver: null
    }
  },
  watch: {
    showFullscreen(val) {
      // showFullscreen is now computed (expandProgress >= 0.5).
      // The Vuex commit is handled by _onAnimationComplete at the true boundaries.
      // We still need to trigger updateScreenSize when the state changes.
      this.updateScreenSize()
      if (val) {
        // The full-screen track refs (`trackFull`, `playedTrackFull`, ...) only
        // exist while showFullscreen is true. When opening the full player from
        // the mini bar without playback running, no `timeupdate` event fires,
        // so the bars would stay empty until play is pressed. Force a refresh
        // once the DOM has rendered the full-screen track elements.
        this.$nextTick(() => {
          this.trackWidth = 0
          this.updateTrack()
          this.updateTimestamp()
          // Second tick in case layout width settles on the next frame.
          requestAnimationFrame(() => {
            this.trackWidth = 0
            this.updateTrack()
            this.updateTimestamp()
          })
        })
      }
    },
    bookCoverAspectRatio() {
      this.updateScreenSize()
    },
    title(val) {
      if (this.titleMarquee) this.titleMarquee.init(val)
    }
  },
  computed: {
    // ─── YouTube Music–style player animation ─────────────────────────────────
    // showFullscreen is now a COMPUTED (derived from expandProgress) rather than data.
    // Every place that used `this.showFullscreen = true/false` now calls
    // animateTo(1) / animateTo(0) or sets expandProgress directly.
    showFullscreen() {
      return this.expandProgress >= 0.5
    },
    miniBottomOffsetPx() {
      return parseFloat(this.playerBottomOffset) || 0
    },
    // Width of the mini cover image (height is always 48px in mini mode)
    miniCoverWidth() {
      return 48 / (this.bookCoverAspectRatio || 1)
    },
    // Viewport top of the mini cover (vertically centred within the mini bar's
    // content row, which has 16px bottom padding to lift contents above the
    // progress track at the bottom of the bar).
    miniCoverViewportTop() {
      const contentBottomPad = 16
      const contentHeight = this.miniBarHeight - contentBottomPad
      return this.windowHeight - this.miniBottomOffsetPx - this.miniBarHeight + (contentHeight - 48) / 2
    },
    // Viewport left of the mini cover (px-2 padding = 8px)
    miniCoverViewportLeft() {
      return 8
    },
    // Full-screen cover dimensions (portrait)
    fullCoverWidth() {
      return this.isLandscape ? this.landscapeBookCoverWidth : this.fullscreenBookCoverWidth
    },
    fullCoverHeight() {
      return this.fullCoverWidth * (this.bookCoverAspectRatio || 1)
    },
    // Uniform scale that shrinks the full-size cover element to appear as the mini cover
    miniCoverScale() {
      return this.fullCoverHeight > 0 ? 48 / this.fullCoverHeight : 1
    },
    // Viewport top of the full cover when the player is expanded (portrait)
    fullCoverViewportTop() {
      const topPad = parseFloat(this.fullscreenTopPadding) || 0
      if (this.isLandscape) {
        // landscape: cover is vertically centred in the left column (top bar = 60px + padding 20px)
        const topBarH = 80
        const availH = this.windowHeight - topBarH
        return topBarH + (availH - this.fullCoverHeight) / 2
      }
      // portrait: safe area + cover-wrapper-portrait padding-top (100px from CSS)
      return topPad + 100
    },
    // Viewport left of the full cover when expanded
    fullCoverViewportLeft() {
      if (this.isLandscape) {
        // left column is 45% of viewport, cover is centred within it (20px container padding)
        const colW = this.windowWidth * 0.45 - 40
        return 20 + (colW - this.fullCoverWidth) / 2
      }
      return (this.windowWidth - this.fullCoverWidth) / 2
    },

    // ── Animated style objects ──────────────────────────────────────────────
    playerSheetStyle() {
      const p = this.expandProgress
      const mini = this.miniBarHeight
      const topPad = parseFloat(this.fullscreenTopPadding) || 0
      const height = mini + (this.windowHeight - topPad - mini) * p
      const bottom = this.miniBottomOffsetPx * (1 - p)
      const radius = Math.round(16 * (1 - p))
      return {
        position: 'fixed',
        left: '0',
        right: '0',
        bottom: bottom + 'px',
        height: height + 'px',
        borderTopLeftRadius: radius + 'px',
        borderTopRightRadius: radius + 'px',
        // NavBar has zIndex 2147483646; we need 2147483647 (INT32_MAX) to sit above it when expanded
        zIndex: p > 0 ? 2147483647 : 50,
        overflow: 'hidden',
        pointerEvents: this.playbackSession ? 'auto' : 'none',
        transform: 'translateZ(0)',
        backfaceVisibility: 'hidden',
        WebkitBackfaceVisibility: 'hidden',
        willChange: 'height, bottom, border-top-left-radius, border-top-right-radius'
      }
    },

    // The single shared cover element: position:fixed, morphs between mini and full positions
    sharedCoverStyle() {
      if (!this.playbackSession) return { display: 'none' }
      const p = this.expandProgress
      // Uniform scale: miniCoverScale at p=0, 1.0 at p=1
      const scale = this.miniCoverScale + (1 - this.miniCoverScale) * p
      // Viewport top/left of the cover's top-left corner
      const top = this.miniCoverViewportTop + (this.fullCoverViewportTop - this.miniCoverViewportTop) * p
      // Horizontal offset also carries the swipe-to-dismiss translation (mini state only)
      const horizOffset = p < 0.05 ? this.swipeOffsetX : this.swipeOffsetX * (1 - p / 0.05)
      const left = this.miniCoverViewportLeft + (this.fullCoverViewportLeft - this.miniCoverViewportLeft) * p + horizOffset
      // The CSS border-radius is divided by scale so the VISUAL radius stays consistent
      // (scale shrinks the element, which would shrink a raw radius too)
      const visualRadius = 8 + (16 - 8) * p
      const cssRadius = scale > 0 ? visualRadius / scale : visualRadius
      return {
        position: 'fixed',
        top: '0',
        left: '0',
        width: this.fullCoverWidth + 'px',
        height: this.fullCoverHeight + 'px',
        transform: `translate3d(${left}px, ${top}px, 0) scale(${scale})`,
        transformOrigin: 'top left',
        borderRadius: cssRadius + 'px',
        overflow: 'hidden',
        // Same INT32_MAX value as playerSheet but later in DOM → paints above it
        zIndex: p > 0 ? 2147483647 : 51,
        // Tapping the cover while mini expands; while full, the full layer handles clicks
        pointerEvents: p < 0.3 ? 'auto' : 'none',
        backfaceVisibility: 'hidden',
        WebkitBackfaceVisibility: 'hidden',
        willChange: 'transform, border-radius'
      }
    },

    // Mini bar layer: stays visible and scales up as the sheet grows (like the album art)
    miniLayerStyle() {
      const p = this.expandProgress
      // Stay fully visible until ~40%, then fade out by ~75%
      const opacity = Math.max(0, 1 - p / 0.75)
      // Scale up slightly as the sheet expands (origin: center-bottom so it grows upward)
      const scale = 1 + p * 0.18
      // Drift upward a little as it grows
      const translateY = -p * 20
      return {
        position: 'absolute',
        bottom: '0',
        left: '0',
        right: '0',
        height: this.miniBarHeight + 'px',
        opacity,
        pointerEvents: opacity > 0.05 ? 'auto' : 'none',
        transform: `translateX(${this.swipeOffsetX}px) translateY(${translateY}px) scale(${scale})`,
        transformOrigin: 'center bottom',
        backfaceVisibility: 'hidden',
        WebkitBackfaceVisibility: 'hidden',
        willChange: 'transform, opacity'
      }
    },

    // Full-screen layer: delayed until sheet is large enough (starts at p=0.3, full at p=0.85)
    fullLayerStyle() {
      const p = this.expandProgress
      const opacity = Math.max(0, Math.min(1, (p - 0.3) / 0.55))
      return {
        position: 'absolute',
        inset: '0',
        opacity,
        pointerEvents: p > 0.6 ? 'auto' : 'none',
        willChange: 'opacity'
      }
    },
    // ─── End of animation computeds ───────────────────────────────────────────

    theme() {
      return document.documentElement.dataset.theme || 'dark'
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
    isLandscape() {
      const result = this.windowWidth > this.windowHeight
      if (this.showFullscreen) {
        console.log('[AudioPlayer] Landscape check:', {
          windowWidth: this.windowWidth,
          windowHeight: this.windowHeight,
          isLandscape: result,
          coverWidth: this.fullscreenBookCoverWidth
        })
      }
      return result
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
        // Landscape - proper height calculation accounting for all UI elements
        const topButtonsHeight = 70 // Space for top buttons
        const titleHeight = 80 // Space for title and author
        const progressHeight = 80 // Space for progress bars
        const controlsHeight = 100 // Space for main controls
        const bottomControlsHeight = 120 // Space for bottom controls row
        const padding = 40 // General padding

        const availableHeight = this.windowHeight - topButtonsHeight - titleHeight - progressHeight - controlsHeight - bottomControlsHeight - padding
        const availableWidth = this.windowWidth * 0.45 // 45% of screen width for cover area

        // Calculate based on both constraints
        let widthBasedOnHeight = availableHeight / this.bookCoverAspectRatio
        let heightBasedOnWidth = availableWidth * this.bookCoverAspectRatio

        // Use the constraint that gives us the smaller size to ensure it fits
        let finalWidth
        if (heightBasedOnWidth <= availableHeight) {
          // Width is the limiting factor
          finalWidth = availableWidth
        } else {
          // Height is the limiting factor
          finalWidth = widthBasedOnHeight
        }

        // Ensure minimum reasonable size but max out to prevent overflow
        const minWidth = Math.min(200, availableWidth * 0.7)
        const maxWidth = Math.min(300, availableWidth * 0.9)
        finalWidth = Math.max(Math.min(finalWidth, maxWidth), minWidth)

        console.log('AudioPlayer: landscape cover size - available height:', availableHeight, 'final width:', finalWidth)
        return finalWidth
      }
    },
    landscapeBookCoverWidth() {
      if (!this.isLandscape) return this.bookCoverWidth

      // Use much more aggressive sizing for landscape
      const availableHeight = this.windowHeight - 120 // Account for top bar and padding
      const availableWidth = this.windowWidth * 0.45 - 40 // 45% of width minus padding

      // Calculate based on aspect ratio and available space
      const aspectRatio = this.bookCoverAspectRatio
      let finalWidth = Math.min(availableWidth, availableHeight / aspectRatio)

      // Ensure good minimum size for landscape
      const minWidth = Math.min(250, availableWidth * 0.8)
      const maxWidth = Math.min(400, availableWidth)
      finalWidth = Math.max(Math.min(finalWidth, maxWidth), minWidth)

      console.log('AudioPlayer: landscape cover width - available space:', availableWidth, 'x', availableHeight, 'final width:', finalWidth)
      return finalWidth
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
      if (this.showFullscreen) return '0px'

      // Use pre-calculated positions from init.client.js
      // Force reactivity by checking this.miniPlayerPositionsReady
      if (this.miniPlayerPositionsReady && window.MINI_PLAYER_POSITIONS) {
        const position = this.isInBookshelfContext ? window.MINI_PLAYER_POSITIONS.withTabBar : window.MINI_PLAYER_POSITIONS.withoutTabBar
        console.log('[AudioPlayer] Using calculated position:', position, 'bookshelf context:', this.isInBookshelfContext)
        return position
      }

      // Fallback if positions haven't been calculated yet
      let fallback = '8px'
      if (this.isInBookshelfContext) {
        try {
          const navHeightRaw = getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height') || ''
          const navHeight = parseFloat(navHeightRaw.replace('px', '')) || 92
          fallback = `${Math.round(navHeight + 10)}px`
        } catch (e) {
          fallback = '102px'
        }
      }
      console.log('[AudioPlayer] Using fallback position:', fallback, 'positions ready:', this.miniPlayerPositionsReady, 'global positions:', !!window.MINI_PLAYER_POSITIONS)
      return fallback
    },
    fullscreenTopPadding() {
      // Only apply status bar padding when in fullscreen mode
      if (!this.showFullscreen) return '0px'
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top') || ''
        const px = parseFloat(raw.replace('px', '')) || 0
        const cap = Math.min(Math.max(px, 0), 64) // cap at 64px to avoid excessive spacing
        return `${cap}px`
      } catch (e) {
        return '0px'
      }
    }
  },
  methods: {
    // ─── Touch / gesture handlers ─────────────────────────────────────────────
    // These are attached to #playerSheet and handle both the mini→full expand
    // gesture (swipe up) and the full→mini collapse gesture (swipe down on the
    // full-screen view).  Horizontal swipe-to-dismiss is only active when the
    // player is fully collapsed (expandProgress === 0).
    handleTouchStart(event) {
      // Cancel any in-flight animation so the user takes direct control
      if (this._animRaf) {
        cancelAnimationFrame(this._animRaf)
        this._animRaf = null
      }

      const touch = event.touches[0]
      this._dragStartY = touch.clientY
      this._dragStartX = touch.clientX
      this._dragStartProgress = this.expandProgress
      this._dragStartTime = Date.now()
      this.swipeStartY = touch.clientY
      this.swipeStartX = touch.clientX
      this.isSwipeActive = true
      this.gestureAxis = 'none'
      this.swipeOffsetX = 0
      this.isHorizontalSwipeActive = false
    },
    handleTouchMove(event) {
      if (!this.isSwipeActive) return

      event.preventDefault()
      const touch = event.touches[0]
      const deltaY = this._dragStartY - touch.clientY // positive = swipe up
      const deltaX = touch.clientX - this._dragStartX // positive = swipe right

      // Determine dominant axis on first sufficient movement
      if (this.gestureAxis === 'none') {
        const mag = Math.max(Math.abs(deltaX), Math.abs(deltaY))
        if (mag > this.gestureDetectionThreshold) {
          this.gestureAxis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical'
        }
      }

      if (this.gestureAxis === 'vertical') {
        // Swipe up from mini expands; swipe down from full collapses.
        const viewportH = window.innerHeight || this.windowHeight || 1
        const progress = deltaY / viewportH
        this.expandProgress = Math.max(0, Math.min(1, this._dragStartProgress + progress))
        this.swipeOffsetX = 0
      } else if (this.gestureAxis === 'horizontal' && this._dragStartProgress < 0.05) {
        // Horizontal swipe only when fully in mini state
        this.isHorizontalSwipeActive = true
        this.swipeOffsetX = Math.max(Math.min(deltaX, window.innerWidth), -window.innerWidth)
      } else {
        this.swipeOffsetX = 0
      }
    },
    handleTouchEnd(event) {
      if (!this.isSwipeActive) return

      this.isSwipeActive = false
      this.isHorizontalSwipeActive = false

      const touch = event.changedTouches[0]
      const deltaY = this._dragStartY - touch.clientY // positive = swipe up
      const elapsed = Math.max(Date.now() - this._dragStartTime, 1)
      const velocityY = deltaY / elapsed // px/ms, positive = upward

      if (this.gestureAxis === 'horizontal') {
        const deltaX = touch.clientX - this._dragStartX
        if (Math.abs(deltaX) > this.horizontalSwipeThreshold) {
          this.swipeOffsetX = deltaX > 0 ? window.innerWidth : -window.innerWidth
          setTimeout(() => {
            this.closePlayback()
          }, 120)
          this.gestureAxis = 'none'
          return
        }
        this.swipeOffsetX = 0
      } else if (this.gestureAxis === 'vertical') {
        // Snap decision: commit if past 30% of travel or fast enough flick
        const shouldExpand = this.expandProgress > 0.3 || (velocityY > 0.5 && deltaY > 0)
        const shouldCollapse = this.expandProgress < 0.7 || (velocityY < -0.5 && deltaY < 0)
        if (this._dragStartProgress < 0.5) {
          // Was in mini → snap to full or mini
          this.animateTo(shouldExpand ? 1 : 0)
        } else {
          // Was in full → snap to mini or full
          this.animateTo(shouldCollapse ? 0 : 1)
        }
      } else {
        // No decisive gesture — snap to nearest boundary
        this.swipeOffsetX = 0
        this.animateTo(this.expandProgress >= 0.5 ? 1 : 0)
      }

      this.gestureAxis = 'none'
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
        this.expandProgress = 0
      }
    },
    async selectChapter(chapter) {
      await this.$hapticsImpact()
      this.seek(chapter.start)
      this.showChapterModal = false
    },
    async castClick() {
      await this.$hapticsImpact()

      // Always show the Cast device selection modal when clicking the cast button
      // This allows users to connect to a new device, disconnect from current device,
      // or switch between devices regardless of current state
      this.$refs.castDeviceModal.init()

      // For local items, also emit the cast-local-item event for any additional handling
      if (this.isLocalPlayMethod) {
        this.$eventBus.$emit('cast-local-item')
      }
    },

    // ─── Animation engine ──────────────────────────────────────────────────────
    /**
     * animateTo(target) — smoothly drives expandProgress to 0 (mini) or 1 (full)
     * using requestAnimationFrame and M3 emphasized easing.
     * @param {number} target  0 = collapse to mini, 1 = expand to full
     */
    animateTo(target) {
      // Respect prefers-reduced-motion
      const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (prefersReduced) {
        this.expandProgress = target
        this._onAnimationComplete(target)
        return
      }

      const duration = target === 1 ? 320 : 220
      // M3 emphasized-decelerate for expand, emphasized-accelerate for collapse
      const ease =
        target === 1
          ? (t) => 1 - Math.pow(1 - t, 3) // ease-out cubic ≈ emphasized-decelerate
          : (t) => t * t // ease-in quadratic ≈ emphasized-accelerate

      const startValue = this.expandProgress
      if (Math.abs(target - startValue) < 0.001) {
        this.expandProgress = target
        this._onAnimationComplete(target)
        return
      }
      const startTime = performance.now()

      if (this._animRaf) {
        cancelAnimationFrame(this._animRaf)
        this._animRaf = null
      }

      const step = (now) => {
        const t = Math.min((now - startTime) / duration, 1)
        const nextValue = startValue + (target - startValue) * ease(t)
        if (Math.abs(nextValue - this.expandProgress) > 0.001 || t === 1) {
          this.expandProgress = nextValue
        }
        if (t < 1) {
          this._animRaf = requestAnimationFrame(step)
        } else {
          this.expandProgress = target
          this._animRaf = null
          this._onAnimationComplete(target)
        }
      }
      this._animRaf = requestAnimationFrame(step)
    },

    _onAnimationComplete(target) {
      // Commit Vuex state only at the hard boundaries
      this.$store.commit('setPlayerFullscreen', target === 1)
      if (target === 0) {
        this.forceCloseDropdownMenu()
      }
      // Recalculate track width after layout settles
      this.trackWidth = 0
      this.$nextTick(() => {
        this.updateTrack()
      })
      if (this.titleMarquee) this.titleMarquee.reset()
    },

    /** Called when the user taps the shared cover image */
    onSharedCoverTap() {
      if (this.expandProgress < 0.5) {
        this.animateTo(1)
      }
      // When fully expanded the full-layer handles taps; cover pointer-events are none
    },

    clickContainer() {
      this.animateTo(1)
    },
    expandFullscreen() {
      this.animateTo(1)
    },
    expandToFullscreen() {
      this.swipeOffset = 0
      this.isSwipeActive = false
      this.animateTo(1)
    },
    collapseFullscreen() {
      this.swipeOffset = 0
      this.isSwipeActive = false
      this.animateTo(0)
    },
    async jumpNextChapter() {
      console.log('[NUXT_SKIP_DEBUG] jumpNextChapter called', {
        isLoading: this.isLoading,
        hasNextChapter: !!this.nextChapter,
        nextChapter: this.nextChapter,
        currentChapter: this.currentChapter,
        currentTime: this.currentTime,
        chapters: this.chapters.length
      })

      await this.$hapticsImpact()
      if (this.isLoading) {
        console.log('[NUXT_SKIP_DEBUG] jumpNextChapter: Skipping due to isLoading=true')
        return
      }

      // Check chapter transition cooldown
      const now = Date.now()
      const timeSinceLastTransition = now - this.lastChapterTransitionTime
      if (timeSinceLastTransition < this.chapterTransitionCooldown) {
        console.log('[NUXT_SKIP_DEBUG] jumpNextChapter: Skipping due to cooldown period', timeSinceLastTransition, 'ms since last transition')
        return
      }

      if (!this.nextChapter) {
        console.log('[NUXT_SKIP_DEBUG] jumpNextChapter: No next chapter available')
        return
      }

      console.log('[NUXT_SKIP_DEBUG] jumpNextChapter: Seeking to next chapter start:', this.nextChapter.start)
      this.lastChapterTransitionTime = now
      this.seek(this.nextChapter.start)
    },
    async jumpChapterStart() {
      console.log('[NUXT_SKIP_DEBUG] jumpChapterStart called', {
        isLoading: this.isLoading,
        hasCurrentChapter: !!this.currentChapter,
        currentChapter: this.currentChapter,
        currentTime: this.currentTime,
        chapters: this.chapters.length
      })

      await this.$hapticsImpact()
      if (this.isLoading) {
        console.log('[NUXT_SKIP_DEBUG] jumpChapterStart: Skipping due to isLoading=true')
        return
      }
      if (!this.currentChapter) {
        console.log('[NUXT_SKIP_DEBUG] jumpChapterStart: No current chapter, calling restart()')
        return this.restart()
      }

      // If 4 seconds or less into current chapter, then go to previous
      const timeSinceChapterStart = this.currentTime - this.currentChapter.start
      console.log('[NUXT_SKIP_DEBUG] jumpChapterStart: Time since chapter start:', timeSinceChapterStart)

      if (timeSinceChapterStart <= 4) {
        console.log('[NUXT_SKIP_DEBUG] jumpChapterStart: Within 4 seconds, seeking to previous chapter')
        const currChapterIndex = this.chapters.findIndex((ch) => Number(ch.start) <= this.currentTime && Number(ch.end) >= this.currentTime)
        console.log('[NUXT_SKIP_DEBUG] jumpChapterStart: Current chapter index:', currChapterIndex)
        if (currChapterIndex > 0) {
          const prevChapter = this.chapters[currChapterIndex - 1]
          console.log('[NUXT_SKIP_DEBUG] jumpChapterStart: Seeking to previous chapter:', prevChapter)
          this.seek(prevChapter.start)
        } else {
          console.log('[NUXT_SKIP_DEBUG] jumpChapterStart: Already at first chapter')
        }
      } else {
        console.log('[NUXT_SKIP_DEBUG] jumpChapterStart: More than 4 seconds, seeking to current chapter start:', this.currentChapter.start)
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
      console.log('[NUXT_SKIP_DEBUG] jumpBackwards called', {
        isLoading: this.isLoading,
        jumpBackwardsTime: this.jumpBackwardsTime,
        currentTime: this.currentTime,
        totalDuration: this.totalDuration
      })

      await this.$hapticsImpact()
      if (this.isLoading) {
        console.log('[NUXT_SKIP_DEBUG] jumpBackwards: Skipping due to isLoading=true')
        return
      }

      console.log('[NUXT_SKIP_DEBUG] jumpBackwards: Calling AbsAudioPlayer.seekBackward with value:', this.jumpBackwardsTime)
      try {
        const result = await AbsAudioPlayer.seekBackward({ value: this.jumpBackwardsTime })
        console.log('[NUXT_SKIP_DEBUG] jumpBackwards: AbsAudioPlayer.seekBackward result:', result)
      } catch (error) {
        console.error('[NUXT_SKIP_DEBUG] jumpBackwards: Error calling AbsAudioPlayer.seekBackward:', error)
      }
    },
    async jumpForward() {
      console.log('[NUXT_SKIP_DEBUG] jumpForward called', {
        isLoading: this.isLoading,
        jumpForwardTime: this.jumpForwardTime,
        currentTime: this.currentTime,
        totalDuration: this.totalDuration
      })

      await this.$hapticsImpact()
      if (this.isLoading) {
        console.log('[NUXT_SKIP_DEBUG] jumpForward: Skipping due to isLoading=true')
        return
      }

      console.log('[NUXT_SKIP_DEBUG] jumpForward: Calling AbsAudioPlayer.seekForward with value:', this.jumpForwardTime)
      try {
        const result = await AbsAudioPlayer.seekForward({ value: this.jumpForwardTime })
        console.log('[NUXT_SKIP_DEBUG] jumpForward: AbsAudioPlayer.seekForward result:', result)
      } catch (error) {
        console.error('[NUXT_SKIP_DEBUG] jumpForward: Error calling AbsAudioPlayer.seekForward:', error)
      }
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
      // Update both full and mini ready tracks where present
      if (this.playerSettings.useChapterTrack) {
        if (this.$refs.totalReadyTrack) this.$refs.totalReadyTrack.style.width = this.readyTrackWidth + 'px'
        if (this.$refs.readyTrackFull) this.$refs.readyTrackFull.style.width = this.trackWidth + 'px'
        if (this.$refs.readyTrack) this.$refs.readyTrack.style.width = this.trackWidth + 'px'
        if (this.$refs.readyTrackMini) this.$refs.readyTrackMini.style.width = this.trackWidth + 'px'
      } else {
        if (this.$refs.readyTrackFull) this.$refs.readyTrackFull.style.width = this.readyTrackWidth + 'px'
        if (this.$refs.readyTrack) this.$refs.readyTrack.style.width = this.readyTrackWidth + 'px'
        if (this.$refs.readyTrackMini) this.$refs.readyTrackMini.style.width = this.readyTrackWidth + 'px'
      }
    },
    updateTimestamp() {
      const tsFull = this.$refs.currentTimestampFull
      const tsMini = this.$refs.currentTimestamp
      // Only require at least one timestamp element to exist
      if (!tsFull && !tsMini) {
        // Skip error if neither element exists (may be during component lifecycle)
        return
      }

      let currentTime = this.isDraggingCursor ? this.draggingCurrentTime : this.currentTime
      if (this.playerSettings.useChapterTrack && this.currentChapter) {
        currentTime = Math.max(0, currentTime - this.currentChapter.start)
      }
      if (this.playerSettings.scaleElapsedTimeBySpeed) {
        currentTime = currentTime / this.currentPlaybackRate
      }

      const rounded = this.$secondsToTimestamp(currentTime)
      if (tsFull) tsFull.innerText = rounded
      if (tsMini) tsMini.innerText = rounded
    },
    timeupdate() {
      console.log('[NUXT_SKIP_DEBUG] timeupdate called', {
        currentTime: this.currentTime,
        totalDuration: this.totalDuration,
        isPlaying: this.isPlaying,
        seekLoading: this.seekLoading,
        isDraggingCursor: this.isDraggingCursor
      })

      // Ensure at least one played track exists
      if (!this.$refs.playedTrackFull && !this.$refs.playedTrack && !this.$refs.playedTrackMini) {
        console.error('[NUXT_SKIP_DEBUG] timeupdate: Invalid no played track ref')
        return
      }
      this.$emit('updateTime', this.currentTime)

      if (this.seekLoading) {
        console.log('[NUXT_SKIP_DEBUG] timeupdate: Seek loading completed, resetting track colors')
        this.seekLoading = false
        // Restore original colors for all progress tracks after seek completes
        if (this.$refs.playedTrack) {
          this.$refs.playedTrack.classList.remove('bg-yellow-300')
          this.$refs.playedTrack.classList.add('bg-primary')
        }
        if (this.$refs.playedTrackFull) {
          this.$refs.playedTrackFull.classList.remove('bg-yellow-300')
          this.$refs.playedTrackFull.classList.add('bg-primary')
        }
        if (this.$refs.playedTrackMini) {
          this.$refs.playedTrackMini.classList.remove('bg-yellow-300')
          this.$refs.playedTrackMini.classList.add('bg-primary')
        }
      }

      this.updateTimestamp()
      this.updateTrack()
    },
    updateTrack() {
      // Update progress track UI
      // Ensure trackWidth is valid; attempt to re-measure if it's not set yet
      if (!this.trackWidth || this.trackWidth === 0) {
        const el = this.getTrackElement()
        if (el) this.trackWidth = el.clientWidth
        if (!this.trackWidth) {
          // Can't compute widths yet; this may happen if DOM hasn't finished layout. Skip for now.
          console.warn('[AudioPlayer] updateTrack skipped, trackWidth not ready')
          return
        }
      }
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

      const ptWidth = Math.max(0, Math.min(Math.round(percentDone * this.trackWidth), this.trackWidth))
      const bufferedWidth = Math.max(0, Math.min(Math.round(bufferedPercent * this.trackWidth), this.trackWidth))

      // Log first timeupdate to help debug initial sizing issues
      if (!this._firstTimeUpdateLogged) {
        console.log('[AudioPlayer] timeupdate init', {
          currentTime: this.currentTime,
          trackWidth: this.trackWidth,
          percentDone: percentDone,
          ptWidth: ptWidth,
          bufferedWidth: bufferedWidth
        })
        this._firstTimeUpdateLogged = true
      }
      // Full view
      if (this.$refs.playedTrackFull) this.$refs.playedTrackFull.style.width = ptWidth + 'px'
      if (this.$refs.bufferedTrackFull) this.$refs.bufferedTrackFull.style.width = bufferedWidth + 'px'
      if (this.$refs.trackCursorFull && !this.isDraggingSeek) this.$refs.trackCursorFull.style.left = Math.max(0, Math.min(ptWidth - 14, this.trackWidth - 28)) + 'px'
      // Mini view
      if (this.$refs.playedTrackMini) this.$refs.playedTrackMini.style.width = ptWidth + 'px'
      if (this.$refs.bufferedTrackMini) this.$refs.bufferedTrackMini.style.width = bufferedWidth + 'px'

      if (this.playerSettings.useChapterTrack) {
        if (this.$refs.totalPlayedTrack) this.$refs.totalPlayedTrack.style.width = Math.round(totalPercentDone * this.trackWidth) + 'px'
        if (this.$refs.totalBufferedTrack) this.$refs.totalBufferedTrack.style.width = Math.round(totalBufferedPercent * this.trackWidth) + 'px'
      }
    },
    seek(time) {
      console.log('[NUXT_SKIP_DEBUG] seek called', {
        time: time,
        isLoading: this.isLoading,
        seekLoading: this.seekLoading,
        currentTime: this.currentTime,
        totalDuration: this.totalDuration
      })

      if (this.isLoading) {
        console.log('[NUXT_SKIP_DEBUG] seek: Skipping due to isLoading=true')
        return
      }
      if (this.seekLoading) {
        console.error('[NUXT_SKIP_DEBUG] seek: Already seek loading', this.seekedTime)
        return
      }

      this.seekedTime = time
      this.seekLoading = true

      console.log('[NUXT_SKIP_DEBUG] seek: Calling AbsAudioPlayer.seek with value:', Math.floor(time))
      try {
        AbsAudioPlayer.seek({ value: Math.floor(time) })

        // Add a small delay after seek to let the player stabilize
        setTimeout(() => {
          console.log('[NUXT_SKIP_DEBUG] seek: Post-seek stabilization delay completed')
        }, 200)
      } catch (error) {
        console.error('[NUXT_SKIP_DEBUG] seek: Error calling AbsAudioPlayer.seek:', error)
      }

      const perc = time / this.totalDuration
      const ptWidth = Math.max(0, Math.min(Math.round(perc * this.trackWidth), this.trackWidth))
      if (this.$refs.playedTrackFull) {
        this.$refs.playedTrackFull.style.width = ptWidth + 'px'
        this.$refs.playedTrackFull.classList.remove('bg-primary')
        this.$refs.playedTrackFull.classList.add('bg-yellow-300')
      }
      if (this.$refs.playedTrackMini) {
        this.$refs.playedTrackMini.style.width = ptWidth + 'px'
        this.$refs.playedTrackMini.classList.remove('bg-primary')
        this.$refs.playedTrackMini.classList.add('bg-yellow-300')
      }
    },
    async touchstartCursor(e) {
      if (!e || !e.touches || !this.$refs.trackFull || !this.showFullscreen || this.playerSettings.lockUi) return

      await this.$hapticsImpact()
      this.isDraggingCursor = true
      this.draggingTouchStartX = e.touches[0].pageX
      this.draggingTouchStartTime = this.currentTime
      this.draggingCurrentTime = this.currentTime

      // Also set up seek drag mechanism for cursor dragging
      this.isDraggingSeek = true
      this.draggingTrackElement = this.$refs.trackFull
      this.draggingStartTime = this.currentTime

      // Get initial position
      const rect = this.draggingTrackElement.getBoundingClientRect()
      const clientX = e.touches[0].clientX
      this.draggingStartX = clientX - rect.left
      this.draggingTrackRect = rect

      // Add global event listeners for seek drag
      document.addEventListener('touchmove', this.handleDragSeek, { passive: false })
      document.addEventListener('touchend', this.endDragSeek)

      // Prevent text selection during drag
      document.body.style.userSelect = 'none'

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
      console.log('[NUXT_SKIP_DEBUG] startPlayInterval called')
      clearInterval(this.playInterval)
      this.playInterval = setInterval(async () => {
        try {
          var data = await AbsAudioPlayer.getCurrentTime()
          const newCurrentTime = Number(data.value.toFixed(2))
          const newBufferedTime = Number(data.bufferedTime.toFixed(2))

          // Only log if time actually changed to avoid spam
          if (newCurrentTime !== this.currentTime) {
            console.log('[NUXT_SKIP_DEBUG] Progress update:', {
              oldTime: this.currentTime,
              newTime: newCurrentTime,
              bufferedTime: newBufferedTime,
              totalDuration: this.totalDuration
            })
          }

          this.currentTime = newCurrentTime
          this.bufferedTime = newBufferedTime
          this.timeupdate()
        } catch (error) {
          console.error('[NUXT_SKIP_DEBUG] Error in playInterval getCurrentTime:', error)
        }
      }, 1000)
    },
    stopPlayInterval() {
      clearInterval(this.playInterval)
    },
    resetStream() {
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

        // Also clean up seek drag state
        this.isDraggingSeek = false
        this.draggingTrackElement = null
        this.draggingStartTime = 0
        this.draggingCurrentTime = 0
        this.draggingStartX = 0
        this.draggingTrackRect = null

        // Remove global event listeners
        document.removeEventListener('touchmove', this.handleDragSeek)
        document.removeEventListener('touchend', this.endDragSeek)

        // Restore text selection
        document.body.style.userSelect = ''
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
      if (!this.isDraggingCursor || !e.touches || this.isDraggingSeek) return

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
    async seekToPosition(event) {
      if (this.isLoading || this.playerSettings.lockUi) return

      await this.$hapticsImpact()

      // Get the track element - use currentTarget if available, otherwise target
      const trackElement = event.currentTarget || event.target
      if (!trackElement) {
        console.warn('[AudioPlayer] seekToPosition: No track element found')
        return
      }

      const rect = trackElement.getBoundingClientRect()
      if (!rect) {
        console.warn('[AudioPlayer] seekToPosition: Could not get bounding rect')
        return
      }

      const clickX = event.clientX - rect.left
      const percentage = Math.max(0, Math.min(1, clickX / rect.width))

      let duration = this.totalDuration
      let minTime = 0
      let maxTime = duration

      if (this.playerSettings.useChapterTrack && this.currentChapter) {
        duration = this.currentChapterDuration
        minTime = this.currentChapter.start
        maxTime = minTime + duration
      }

      const seekTime = minTime + percentage * duration
      const clampedSeekTime = Math.min(maxTime, Math.max(minTime, seekTime))

      this.seek(clampedSeekTime)
    },
    async startDragSeek(event) {
      if (this.isLoading || this.playerSettings.lockUi) return

      event.preventDefault()
      await this.$hapticsImpact()

      this.isDraggingSeek = true
      this.draggingTrackElement = event.currentTarget || event.target
      this.draggingStartTime = this.currentTime

      // Get initial position
      const rect = this.draggingTrackElement.getBoundingClientRect()
      const clientX = event.clientX || (event.touches && event.touches[0] ? event.touches[0].clientX : 0)
      this.draggingStartX = clientX - rect.left
      this.draggingTrackRect = rect

      // Add global event listeners
      document.addEventListener('mousemove', this.handleDragSeek)
      document.addEventListener('mouseup', this.endDragSeek)
      document.addEventListener('touchmove', this.handleDragSeek, { passive: false })
      document.addEventListener('touchend', this.endDragSeek)

      // Prevent text selection during drag
      document.body.style.userSelect = 'none'
    },
    handleDragSeek(event) {
      if (!this.isDraggingSeek || !this.draggingTrackElement) return

      event.preventDefault()

      const clientX = event.clientX || (event.touches && event.touches[0] ? event.touches[0].clientX : 0)
      const rect = this.draggingTrackRect
      const clickX = clientX - rect.left
      const percentage = Math.max(0, Math.min(1, clickX / rect.width))

      let duration = this.totalDuration
      let minTime = 0
      let maxTime = duration

      if (this.playerSettings.useChapterTrack && this.currentChapter) {
        duration = this.currentChapterDuration
        minTime = this.currentChapter.start
        maxTime = minTime + duration
      }

      const seekTime = minTime + percentage * duration
      this.draggingCurrentTime = Math.min(maxTime, Math.max(minTime, seekTime))

      // Update cursor position directly for smooth dragging - center the 24px cursor on the touch position
      if (this.$refs.trackCursorFull) {
        const cursorLeft = Math.max(0, Math.min(clickX - 12, rect.width - 24))
        this.$refs.trackCursorFull.style.left = cursorLeft + 'px'
      }

      this.updateTimestamp()
      this.updateTrack()
    },
    endDragSeek(event) {
      if (!this.isDraggingSeek) return

      event.preventDefault()

      // Remove global event listeners
      document.removeEventListener('mousemove', this.handleDragSeek)
      document.removeEventListener('mouseup', this.endDragSeek)
      document.removeEventListener('touchmove', this.handleDragSeek)
      document.removeEventListener('touchend', this.endDragSeek)

      // Restore text selection
      document.body.style.userSelect = ''

      // Perform the actual seek if the time changed
      if (this.draggingCurrentTime !== this.draggingStartTime) {
        this.seek(this.draggingCurrentTime)
      }

      // Reset drag state
      this.isDraggingSeek = false
      this.draggingTrackElement = null
      this.draggingStartTime = 0
      this.draggingCurrentTime = 0
      this.draggingStartX = 0
      this.draggingTrackRect = null
    },
    async clickMenuAction(action) {
      await this.$hapticsImpact()
      this.showMoreMenuDialog = false
      this.$nextTick(() => {
        if (action === 'history') {
          this.$router.push(`/media/${this.mediaId}/history?title=${this.title}`)
          this.expandProgress = 0
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
    // Return the currently-visible track DOM element (prefer fullscreen when active)
    getTrackElement() {
      if (this.showFullscreen && this.$refs.trackFull) return this.$refs.trackFull
      if (!this.showFullscreen && this.$refs.trackMini) return this.$refs.trackMini
      // fallbacks for older refs
      if (this.$refs.track) return this.$refs.track
      if (this.$refs.trackFull) return this.$refs.trackFull
      if (this.$refs.trackMini) return this.$refs.trackMini
      return null
    },
    forceCloseDropdownMenu() {
      if (this.$refs.dropdownMenu && this.$refs.dropdownMenu.closeMenu) {
        this.$refs.dropdownMenu.closeMenu()
      }
    },
    closePlayback() {
      // Reset swipe offsets to avoid leaving UI translated
      this.swipeOffset = 0
      this.swipeOffsetX = 0
      this.isSwipeActive = false
      this.isHorizontalSwipeActive = false
      this.endPlayback()
      AbsAudioPlayer.closePlayback()
    },
    endPlayback() {
      this.$store.commit('setPlaybackSession', null)
      this.expandProgress = 0
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

        const el = this.getTrackElement()
        if (el) {
          this.trackWidth = el.clientWidth
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
    onCastSessionConnected(data) {
      console.log('Cast session connected:', data)
      const deviceName = data.deviceName || 'Unknown Device'
      this.$toast.success(`Connected to ${deviceName}`)
      // Update store to reflect casting state
      this.$store.commit('setMediaPlayer', 'cast-player')
    },
    onCastSessionDisconnected(data) {
      console.log('Cast session disconnected:', data)
      this.$toast.info('Cast session disconnected')

      // Update store to reflect local playback FIRST
      this.$store.commit('setMediaPlayer', 'local-player')

      // Check if we need to switch back to local content
      // First check if session already has local library item
      const sessionLocalLibraryItem = this.playbackSession?.localLibraryItem
      const serverLibraryItemId = this.playbackSession?.libraryItemId || this.playbackSession?.serverLibraryItemId

      if (sessionLocalLibraryItem) {
        console.log('Found local library item in session, switching back to local content:', sessionLocalLibraryItem.id)
        this.restoreLocalPlaybackFromSession(sessionLocalLibraryItem)
      } else if (serverLibraryItemId) {
        // Session doesn't have local item, but we have server ID - check if downloaded version exists
        console.log('No local library item in session, checking for downloaded version of server item:', serverLibraryItemId)
        this.checkForDownloadedVersion(serverLibraryItemId)
      } else {
        console.log('No local library item found and no server ID - cannot restore local playback')
      }
    },
    onCastSessionFailed(data) {
      console.log('Cast session failed:', data)
      this.$toast.error('Failed to connect to cast device')
    },
    onCastSessionRequested(data) {
      console.log('Cast session requested:', data)
      // Show the Cast device selection modal
      this.$refs.castDeviceModal.init()
    },
    async checkForDownloadedVersion(serverLibraryItemId) {
      try {
        // Query the database for a local library item that matches this server ID
        const localLibraryItem = await this.$db.getLocalLibraryItemByLId(serverLibraryItemId)

        if (localLibraryItem) {
          console.log('Found downloaded version for server item:', serverLibraryItemId, '-> local:', localLibraryItem.id)
          this.restoreLocalPlaybackFromLocalItem(localLibraryItem)
        } else {
          console.log('No downloaded version found for server item:', serverLibraryItemId, '- continuing with server playback')
        }
      } catch (error) {
        console.error('Error checking for downloaded version:', error)
        console.log('Failed to check for local version - continuing with server playback')
      }
    },
    restoreLocalPlaybackFromSession(sessionLocalLibraryItem) {
      const currentTime = this.currentTime || 0
      const localEpisodeId = this.playbackSession?.localEpisodeId || null

      // Determine library item ID - use local library item from session
      let libraryItemId = sessionLocalLibraryItem.id
      let serverLibraryItemId = this.playbackSession?.serverLibraryItemId || sessionLocalLibraryItem.libraryItemId || null
      let selectedEpisodeId = localEpisodeId
      let serverEpisodeId = this.playbackSession?.serverEpisodeId || null

      console.log('Restoring local playback from session:', {
        libraryItemId,
        serverLibraryItemId,
        episodeId: selectedEpisodeId,
        serverEpisodeId,
        currentTime,
        sessionLocalItem: sessionLocalLibraryItem.id
      })

      this.executeLocalPlaybackRestore(libraryItemId, serverLibraryItemId, selectedEpisodeId, serverEpisodeId, currentTime)
    },
    restoreLocalPlaybackFromLocalItem(localLibraryItem) {
      const currentTime = this.currentTime || 0
      const serverEpisodeId = this.playbackSession?.episodeId || null

      // Find matching local episode if this is a podcast
      let localEpisodeId = null
      if (serverEpisodeId && localLibraryItem.mediaType === 'podcast') {
        const localEpisode = localLibraryItem.media.episodes?.find((ep) => ep.serverEpisodeId === serverEpisodeId)
        localEpisodeId = localEpisode?.id || null
      }

      console.log('Restoring local playback from found local item:', {
        libraryItemId: localLibraryItem.id,
        serverLibraryItemId: localLibraryItem.libraryItemId,
        episodeId: localEpisodeId,
        serverEpisodeId,
        currentTime
      })

      this.executeLocalPlaybackRestore(localLibraryItem.id, localLibraryItem.libraryItemId, localEpisodeId, serverEpisodeId, currentTime)
    },
    executeLocalPlaybackRestore(libraryItemId, serverLibraryItemId, episodeId, serverEpisodeId, currentTime) {
      // Add a delay to ensure cast session is fully disconnected and force local playback
      const restoreLocalPlayback = () => {
        // Double-check that we're not casting anymore
        this.$store.commit('setMediaPlayer', 'local-player')

        // Verify casting state is cleared
        if (this.$store.state.isCasting) {
          console.warn('Casting state still active, retrying in 500ms...')
          setTimeout(restoreLocalPlayback, 500)
          return
        }

        // Use the same event pattern as the book info screen
        const playPayload = {
          libraryItemId,
          serverLibraryItemId,
          startTime: currentTime
        }

        // Add episode info if applicable
        if (episodeId) {
          playPayload.episodeId = episodeId
          if (serverEpisodeId) {
            playPayload.serverEpisodeId = serverEpisodeId
          }
        }

        console.log('Emitting play-item event for local restoration:', playPayload)
        console.log('Library item ID for local playback:', libraryItemId)
        console.log('Casting state cleared:', !this.$store.state.isCasting)
        console.log('Expected to use local playback method (PlayMethod.LOCAL = 3)')

        this.$eventBus.$emit('play-item', playPayload)
      }

      // Start the restoration process after a delay
      setTimeout(restoreLocalPlayback, 1000)
    },
    onCastDeviceConnected(device) {
      console.log('Cast device connected from modal:', device)
      // Device connection is handled by the modal and native layer
      // The onCastSessionConnected method will be called by the native layer
    },
    onCastDeviceDisconnected(device) {
      console.log('Cast device disconnected from modal:', device)
      // Device disconnection is handled by the modal and native layer
      // The onCastSessionDisconnected method will be called by the native layer
    },
    async init() {
      await this.loadPlayerSettings()

      // Check if there's already a playback session in the store (from native sync)
      if (this.$store.state.currentPlaybackSession && !this.playbackSession) {
        console.log('[AudioPlayer] Found existing playback session in store, setting it')
        this.onPlaybackSession(this.$store.state.currentPlaybackSession)
      }

      // Check for last playback session on app start
      await this.checkForLastPlaybackSession()
    },
    async checkForLastPlaybackSession() {
      try {
        // Only check on first app load and if no current session
        if (!this.$store.state.isFirstAudioLoad || this.$store.state.currentPlaybackSession) {
          console.log('[NUXT_SKIP_DEBUG] AudioPlayer.checkForLastPlaybackSession: Skipping check - isFirstAudioLoad:', this.$store.state.isFirstAudioLoad, 'currentSession:', !!this.$store.state.currentPlaybackSession)
          return
        }

        console.log('[NUXT_SKIP_DEBUG] AudioPlayer.checkForLastPlaybackSession: Checking for last playback session to resume')
        const lastSession = await this.$store.dispatch('loadLastPlaybackSession')

        if (lastSession) {
          // Check if this session is worth resuming (not at the very beginning)
          const progress = lastSession.currentTime / lastSession.duration
          if (progress > 0.01) {
            console.log(`[NUXT_SKIP_DEBUG] AudioPlayer.checkForLastPlaybackSession: Found resumable session: ${lastSession.displayTitle} at ${Math.floor(progress * 100)}%`)

            // Resume the session
            await this.resumeFromLastSession()
          } else {
            console.log(`[NUXT_SKIP_DEBUG] AudioPlayer.checkForLastPlaybackSession: Session found but progress too low: ${Math.floor(progress * 100)}%`)
          }
        } else {
          console.log('[NUXT_SKIP_DEBUG] AudioPlayer.checkForLastPlaybackSession: No last session found')
        }
      } catch (error) {
        console.error('[NUXT_SKIP_DEBUG] AudioPlayer.checkForLastPlaybackSession: Failed to check for last playback session:', error)
        console.error('[NUXT_SKIP_DEBUG] AudioPlayer.checkForLastPlaybackSession: Error type:', error.constructor.name)
        console.error('[NUXT_SKIP_DEBUG] AudioPlayer.checkForLastPlaybackSession: Error message:', error.message)
      }
    },
    async resumeFromLastSession() {
      try {
        console.log('[NUXT_SKIP_DEBUG] AudioPlayer.resumeFromLastSession: Attempting to resume from last session')
        await AbsAudioPlayer.resumeLastPlaybackSession()
        console.log('[NUXT_SKIP_DEBUG] AudioPlayer.resumeFromLastSession: Successfully resumed from last session')
      } catch (error) {
        console.error('[NUXT_SKIP_DEBUG] AudioPlayer.resumeFromLastSession: Failed to resume from last session:', error)
        console.error('[NUXT_SKIP_DEBUG] AudioPlayer.resumeFromLastSession: Error type:', error.constructor.name)
        console.error('[NUXT_SKIP_DEBUG] AudioPlayer.resumeFromLastSession: Error message:', error.message)
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
      const el = this.getTrackElement()
      if (el) {
        this.trackWidth = el.clientWidth
        this.updateTrack()
        this.updateReadyTrack()
        this.updateTimestamp()
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
    onAbsUiReady() {
      // Called when app layout/CSS variables are ready. Force a UI refresh so
      // playerBottomOffset calculates against the correct navbar height.
      console.log('[AudioPlayer] abs-ui-ready received, refreshing UI')
      this.$nextTick(() => {
        this.refreshUI()
        // Also nudge DOM and recalc bottom offset
        setTimeout(() => {
          this.refreshUI()
          // Mini player positioning is now handled by global positions
          // No need to force update anymore
        }, 50)
      })
    },
    showProgressSyncIsFailing() {
      this.syncStatus = this.$constants.SyncStatus.FAILED
    },
    showProgressSyncSuccess() {
      this.syncStatus = this.$constants.SyncStatus.SUCCESS
    }
  },
  created() {
    // Add listeners early to ensure they're available when Android syncs playback state
    AbsAudioPlayer.addListener('onPlaybackSession', this.onPlaybackSession)
    AbsAudioPlayer.addListener('onPlaybackClosed', this.onPlaybackClosed)
    AbsAudioPlayer.addListener('onPlaybackFailed', this.onPlaybackFailed)
    AbsAudioPlayer.addListener('onPlayingUpdate', this.onPlayingUpdate)
    AbsAudioPlayer.addListener('onMetadata', this.onMetadata)
    AbsAudioPlayer.addListener('onProgressSyncFailing', this.showProgressSyncIsFailing)
    AbsAudioPlayer.addListener('onProgressSyncSuccess', this.hideProgressSyncIsFailing)
    AbsAudioPlayer.addListener('onPlaybackSpeedChanged', this.onPlaybackSpeedChanged)

    // Cast event listeners
    AbsAudioPlayer.addListener('onCastSessionConnected', this.onCastSessionConnected)
    AbsAudioPlayer.addListener('onCastSessionDisconnected', this.onCastSessionDisconnected)
    AbsAudioPlayer.addListener('onCastSessionFailed', this.onCastSessionFailed)
    AbsAudioPlayer.addListener('onCastSessionRequested', this.onCastSessionRequested)
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
    // Ensure we recalculate offsets after app UI is ready (CSS vars / nav mounted)
    this.$eventBus.$on('abs-ui-ready', this.onAbsUiReady)
    document.body.addEventListener('touchstart', this.touchstart, { passive: false })
    document.body.addEventListener('touchend', this.touchend)
    document.body.addEventListener('touchmove', this.touchmove)

    // Listen for mini player positions being ready
    this.handlePositionsReady = () => {
      console.log('[AudioPlayer] Mini player positions are ready')
      this.miniPlayerPositionsReady = true
    }

    if (window.MINI_PLAYER_POSITIONS) {
      // Positions already calculated
      this.miniPlayerPositionsReady = true
    } else {
      // Wait for positions to be calculated
      window.addEventListener('miniPlayerPositionsReady', this.handlePositionsReady)
    }

    // Set up safe area observer for fullscreen status bar padding
    const updateFullscreenTopPadding = () => {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top') || ''
        const px = parseFloat(raw.replace('px', '')) || 0
        const cap = Math.min(Math.max(px, 0), 64) // cap at 64px to avoid excessive spacing
        this.fullscreenTopPadding = `${cap}px`
      } catch (e) {
        this.fullscreenTopPadding = '0px'
      }
    }

    // Run immediately and when the safe-area-ready attribute toggles
    updateFullscreenTopPadding()
    // Observe attribute set by plugin to know when CSS vars are injected
    this._safeAreaObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'data-safe-area-ready') {
          updateFullscreenTopPadding()
        }
      }
    })
    this._safeAreaObserver.observe(document.documentElement, { attributes: true })
    window.addEventListener('resize', updateFullscreenTopPadding)

    // Non-reactive animation state (not in Vue data to avoid triggering renders)
    this._animRaf = null
    this._dragStartY = 0
    this._dragStartX = 0
    this._dragStartProgress = 0
    this._dragStartTime = 0

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
    this.$eventBus.$off('abs-ui-ready', this.onAbsUiReady)

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
    if (this._animRaf) {
      cancelAnimationFrame(this._animRaf)
      this._animRaf = null
    }

    // Clean up safe area observer
    if (this._safeAreaObserver) {
      this._safeAreaObserver.disconnect()
    }

    // Clean up mini player positions event listener
    window.removeEventListener('miniPlayerPositionsReady', this.handlePositionsReady)
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

/* Material 3 Expressive primary play/pause button \u2014 shape morph between
   rounded-3xl (paused) and full circle (playing) plus a soft glow ring. */
.expressive-play-btn {
  position: relative;
  border-radius: 28px;
  transition: border-radius 380ms cubic-bezier(0.34, 1.56, 0.64, 1), transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 240ms cubic-bezier(0.2, 0, 0, 1);
}
.expressive-play-btn.is-playing {
  border-radius: 9999px;
}
.expressive-play-btn.is-paused {
  border-radius: 28px;
}
.expressive-play-btn--mini.is-paused {
  border-radius: 16px;
}
.expressive-play-btn::after {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(closest-side, rgba(var(--md-sys-color-primary), 0.35), rgba(var(--md-sys-color-primary), 0) 75%);
  opacity: 0;
  transition: opacity 320ms cubic-bezier(0.2, 0, 0, 1);
  z-index: -1;
}
.expressive-play-btn.is-playing::after {
  opacity: 1;
}
.expressive-play-btn:active {
  transform: scale(0.94);
}

/* M3 Expressive progress track \u2014 soft halo on the played portion + gentle
   pulse while playing. */
.expressive-track {
  overflow: visible;
}
.expressive-track .expressive-played {
  box-shadow: 0 0 8px 0 rgba(var(--md-sys-color-primary), 0.55), 0 0 18px 0 rgba(var(--md-sys-color-primary), 0.25);
}
.expressive-track--mini .expressive-played {
  box-shadow: 0 0 6px 0 rgba(var(--md-sys-color-primary), 0.45);
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

.playerContainer {
  height: 80px;
  /* Solid M3 expressive surface for crisp text legibility over any cover */
  background: rgb(var(--md-sys-color-surface-container-high));
  /* border-radius is driven by playerSheetStyle now */
  box-shadow: var(--md-sys-elevation-surface-container-high);
  margin: 0;
}
/* Fullscreen .playerContainer override is no longer needed — the sheet itself controls its height */

/* #playerContent is now the mini bar layer (position:absolute bottom of sheet) */
#playerContent {
  background: rgb(var(--md-sys-color-surface-container-high));
  margin: 0;
}

/* #playerSheet is the new root — it already handles its own background via the full layer */
#playerSheet {
  background: transparent;
}

#playerTrack {
  transition: margin 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
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
  transition: left 0.25s cubic-bezier(0.39, 0.575, 0.565, 1), bottom 0.25s cubic-bezier(0.39, 0.575, 0.565, 1), width 0.25s cubic-bezier(0.39, 0.575, 0.565, 1), height 0.25s cubic-bezier(0.39, 0.575, 0.565, 1), border-radius 0.2s cubic-bezier(0.39, 0.575, 0.565, 1);
  transform-origin: left bottom;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--md-sys-elevation-surface-container-low);
}

.title-author-texts {
  transition: left 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), bottom 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), width 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), height 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  transform-origin: left bottom;

  width: var(--title-author-width-collapsed);
  bottom: 84px;
  left: var(--title-author-left-offset-collapsed);
  text-align: left;
}
.title-author-texts .title-text {
  transition: font-size 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--md-sys-color-on-surface);
  font-weight: 500;
}
.title-author-texts .author-text {
  transition: font-size 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  font-size: 0.75rem;
  line-height: 1.2;
  color: var(--md-sys-color-on-surface-variant);
}

.fullscreen .title-author-texts {
  bottom: 190px; /* Position below progress bars (260px), with extra breathing room */
  width: 80%;
  left: 10%;
  text-align: center;
  padding-bottom: 0;
  pointer-events: auto;
}
.fullscreen .title-author-texts .title-text {
  font-size: clamp(0.8rem, calc(var(--cover-image-height) / 260 * 20), 1.3rem);
}
.fullscreen .title-author-texts .author-text {
  font-size: clamp(0.6rem, calc(var(--cover-image-height) / 260 * 16), 1rem);
}

#playerControls {
  transition: width 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), bottom 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), padding-left 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), padding-right 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);
  width: 128px;
  padding-right: 16px;
  bottom: 78px;
}
#playerControls .jump-icon {
  transition: font-size 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), color 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);

  margin: 0px 0px;
  font-size: 1.6rem;
  color: var(--md-sys-color-on-surface-variant);
}
#playerControls .play-btn {
  transition: padding 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), margin 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), height 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), width 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), min-width 0.15s cubic-bezier(0.39, 0.575, 0.565, 1), min-height 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);

  height: 48px;
  width: 48px;
  min-width: 48px;
  min-height: 48px;
  margin: 0px 8px;
  background: var(--md-sys-color-primary) !important;
  box-shadow: var(--md-sys-elevation-fab-primary);
}
#playerControls .play-btn .material-symbols {
  transition: font-size 0.15s cubic-bezier(0.39, 0.575, 0.565, 1);

  font-size: 1.75rem;
  color: var(--md-sys-color-on-primary);
}

.fullscreen .cover-wrapper {
  margin: 0 auto;
  height: var(--cover-image-height);
  width: var(--cover-image-width);
  left: calc(50% - (calc(var(--cover-image-width)) / 2));
  bottom: calc(50% + 120px - (calc(var(--cover-image-height)) / 2));
  border-radius: 16px;
  overflow: hidden;
}

.fullscreen #playerControls {
  width: 100%;
  padding-left: 24px;
  padding-right: 24px;
  bottom: 24px; /* Move controls to very bottom with standard padding */
  left: 0;
}
.fullscreen #playerControls .jump-icon {
  font-size: 2.4rem;
}
.fullscreen #playerControls .next-icon {
  font-size: 2rem;
}
.fullscreen #playerControls .play-btn {
  height: 65px;
  width: 65px;
  min-width: 65px;
  min-height: 65px;
}
.fullscreen #playerControls .play-btn .material-symbols {
  font-size: 2.1rem;
}

/* Fullscreen Layout Styles */
.fullscreen-container {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Portrait Layout Styles */
.cover-wrapper-portrait {
  flex: 1;
  padding: 100px 20px 10px;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.cover-container {
  max-height: 50vh;
  max-width: 85vw;
  display: flex;
  align-items: center;
  justify-content: center;
}

.controls-container-portrait {
  flex: 0 0 auto;
  padding: 10px 20px 20px;
  max-width: 500px;
  margin: 0 auto;
  z-index: 10;
  position: relative;
}

/* Landscape Layout Styles */
.landscape-layout {
  overflow: hidden;
}

.landscape-layout .cover-wrapper-portrait,
.landscape-layout .controls-container-portrait,
.landscape-layout #progressBarsContainer,
.landscape-layout .title-author-texts {
  display: none !important;
}

/* Hide the original positioned top buttons in landscape mode */
.landscape-layout .top-4.left-4.absolute,
.landscape-layout .top-4.right-36.absolute,
.landscape-layout .top-4.right-20.absolute,
.landscape-layout .top-4.right-4.absolute {
  display: none !important;
}

.landscape-content-container {
  position: absolute;
  inset: 0;
  max-height: 100vh;
  align-items: center;
}

.landscape-cover-section {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding-bottom: 10px;
}

.cover-wrapper-landscape {
  border-radius: 20px;
  overflow: hidden;
  box-shadow: var(--md-sys-elevation-surface-container-high);
  transition: transform 0.3s cubic-bezier(0.39, 0.575, 0.565, 1), box-shadow 0.3s cubic-bezier(0.39, 0.575, 0.565, 1);
  max-height: 75vh;
  max-width: 100%;
  width: fit-content;
  height: fit-content;
}

.cover-container-landscape {
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-wrapper-landscape:active {
  transform: scale(0.98);
}

.landscape-controls-section {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 0;
  overflow: hidden;
}

.title-author-texts-landscape {
  margin-bottom: 1.5rem;
}

.title-author-texts-landscape .title-text {
  font-size: clamp(1.125rem, 2.5vw, 1.75rem);
  line-height: 1.2;
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.title-author-texts-landscape .author-text {
  font-size: clamp(0.875rem, 2vw, 1.25rem);
  line-height: 1.3;
  opacity: 0.85;
}

.landscape-progress-container {
  margin-bottom: 1.5rem;
}

.landscape-main-controls {
  margin-bottom: 1rem;
}

.landscape-secondary-controls {
  flex-wrap: wrap;
  gap: 0.75rem;
}

/* Responsive adjustments for smaller landscape screens */
@media screen and (max-height: 500px) {
  .landscape-content-container {
    padding-top: 15px !important;
  }

  .title-author-texts-landscape {
    margin-bottom: 1rem;
  }

  .title-author-texts-landscape .title-text {
    font-size: clamp(1rem, 2.5vw, 1.5rem);
    margin-bottom: 0.125rem;
  }

  .title-author-texts-landscape .author-text {
    font-size: clamp(0.75rem, 2vw, 1.125rem);
  }

  .landscape-progress-container {
    margin-bottom: 1rem;
  }

  .landscape-main-controls {
    margin-bottom: 0.75rem;
  }

  .landscape-main-controls button {
    transform: scale(0.9);
  }

  .landscape-secondary-controls {
    margin-top: 0.25rem;
  }

  .landscape-secondary-controls button {
    transform: scale(0.9);
  }
}

/* Very small landscape screens (phones in landscape) */
@media screen and (max-height: 400px) {
  .landscape-content-container {
    padding-top: 10px !important;
  }

  .landscape-cover-section {
    width: 45% !important;
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }

  .landscape-controls-section {
    max-width: 55% !important;
    padding-left: 0.75rem;
    padding-right: 1rem;
  }

  .title-author-texts-landscape {
    margin-bottom: 0.75rem;
  }

  .title-author-texts-landscape .title-text {
    font-size: clamp(0.875rem, 2.5vw, 1.25rem);
    margin-bottom: 0.125rem;
  }

  .title-author-texts-landscape .author-text {
    font-size: clamp(0.75rem, 2vw, 1rem);
  }

  .landscape-progress-container {
    margin-bottom: 0.75rem;
  }

  .landscape-main-controls {
    margin-bottom: 0.5rem;
  }

  .landscape-main-controls button {
    transform: scale(0.8);
  }

  .landscape-secondary-controls button {
    transform: scale(0.85);
  }
}

/* Portrait responsive adjustments */
@media screen and (max-width: 480px) {
  .cover-wrapper-portrait {
    padding: 90px 15px 5px;
  }

  .controls-container-portrait {
    padding: 5px 15px 15px;
  }
}

@media screen and (max-height: 667px) {
  .cover-wrapper-portrait {
    padding: 80px 20px 5px;
  }

  .cover-container {
    max-height: 45vh;
  }

  .controls-container-portrait {
    padding: 5px 20px 15px;
  }
}

@media screen and (max-height: 568px) {
  .cover-wrapper-portrait {
    padding: 70px 15px 5px;
  }

  .cover-container {
    max-height: 40vh;
  }

  .controls-container-portrait {
    padding: 5px 15px 10px;
  }
}

@media screen and (max-height: 480px) {
  .cover-wrapper-portrait {
    padding: 60px 15px 5px;
  }

  .cover-container {
    max-height: 35vh;
  }

  .controls-container-portrait {
    padding: 5px 15px 8px;
  }
}

/* Fix button visibility issues */
.controls-container-portrait button,
.landscape-controls-section button {
  pointer-events: auto;
  z-index: 10;
  position: relative;
}

/* Ensure all control elements are visible and interactive */
.controls-container-portrait *,
.landscape-controls-section * {
  pointer-events: auto;
}
</style>
