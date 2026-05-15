<template>
  <div class="w-full h-full overflow-y-auto bg-surface-dynamic" :style="contentPaddingStyle">
    <div class="settings-page mx-auto w-full max-w-2xl px-4 py-6 space-y-6">
      <!-- Display settings -->
      <section>
        <h2 class="settings-section-header">{{ $strings.HeaderUserInterfaceSettings }}</h2>
        <div class="settings-card">
          <!-- screen.orientation.lock not supported on iOS webview -->
          <div v-if="!isiOS" class="settings-row" @click="toggleLockOrientation">
            <span class="settings-row-icon material-symbols">screen_rotation</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelLockOrientation }}</p>
            </div>
            <ui-toggle-switch v-model="lockCurrentOrientation" class="pointer-events-none" />
          </div>
          <div class="settings-row" @click.stop="showHapticFeedbackOptions">
            <span class="settings-row-icon material-symbols">vibration</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelHapticFeedback }}</p>
              <p class="settings-row-value">{{ hapticFeedbackOption }}</p>
            </div>
            <span class="material-symbols settings-row-trailing">expand_more</span>
          </div>
          <div class="settings-row" @click.stop="showLanguageOptions">
            <span class="settings-row-icon material-symbols">language</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelLanguage }}</p>
              <p class="settings-row-value">{{ languageOption }}</p>
            </div>
            <span class="material-symbols settings-row-trailing">expand_more</span>
          </div>
          <div class="settings-row" @click.stop="showThemeOptions">
            <span class="settings-row-icon material-symbols">palette</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelTheme }}</p>
              <p class="settings-row-value">{{ themeOption }}</p>
            </div>
            <span class="material-symbols settings-row-trailing">expand_more</span>
          </div>
          <div v-if="$platform === 'android'" class="settings-row" @click="toggleDynamicColors">
            <span class="settings-row-icon material-symbols">colors</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelUseDynamicColors || 'Use Dynamic Colors (Material You)' }}</p>
              <p class="settings-row-supporting">{{ $strings.LabelUseDynamicColorsHelp || 'Tint the app with colors from your wallpaper' }}</p>
            </div>
            <button class="settings-row-info" @click.stop="showInfo('dynamicColors')">
              <span class="material-symbols">info</span>
            </button>
            <ui-toggle-switch v-model="settings.enableDynamicColors" class="pointer-events-none" />
          </div>
          <div class="settings-row" @click="toggleHideNonAudiobooksGlobal">
            <span class="settings-row-icon material-symbols">headphones</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelHideNonAudiobooksGlobal || 'Hide non-audiobooks globally' }}</p>
            </div>
            <ui-toggle-switch :value="hideNonAudiobooksGlobal" class="pointer-events-none" />
          </div>
        </div>
      </section>

      <!-- Playback settings -->
      <section>
        <h2 class="settings-section-header">{{ $strings.HeaderPlaybackSettings }}</h2>
        <div class="settings-card">
          <div class="settings-row" @click="toggleDisableAutoRewind">
            <span class="settings-row-icon material-symbols">replay</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelDisableAutoRewind }}</p>
            </div>
            <ui-toggle-switch v-model="settings.disableAutoRewind" class="pointer-events-none" />
          </div>
          <div class="settings-row" @click.stop="showJumpBackwardsOptions">
            <span class="material-symbols settings-row-icon">{{ currentJumpBackwardsTimeIcon }}</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelJumpBackwardsTime }}</p>
              <p class="settings-row-value">{{ jumpBackwardsTimeOption }}</p>
            </div>
            <span class="material-symbols settings-row-trailing">expand_more</span>
          </div>
          <div class="settings-row" @click.stop="showJumpForwardOptions">
            <span class="material-symbols settings-row-icon">{{ currentJumpForwardTimeIcon }}</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelJumpForwardsTime }}</p>
              <p class="settings-row-value">{{ jumpForwardTimeOption }}</p>
            </div>
            <span class="material-symbols settings-row-trailing">expand_more</span>
          </div>
          <div v-if="!isiOS" class="settings-row" @click="toggleEnableMp3IndexSeeking">
            <span class="settings-row-icon material-symbols">fast_forward</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelEnableMp3IndexSeeking }}</p>
            </div>
            <button class="settings-row-info" @click.stop="showConfirmMp3IndexSeeking">
              <span class="material-symbols">info</span>
            </button>
            <ui-toggle-switch v-model="settings.enableMp3IndexSeeking" class="pointer-events-none" />
          </div>
          <div class="settings-row" @click="toggleAllowSeekingOnMediaControls">
            <span class="settings-row-icon material-symbols">touch_app</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelAllowSeekingOnMediaControls }}</p>
            </div>
            <ui-toggle-switch v-model="settings.allowSeekingOnMediaControls" class="pointer-events-none" />
          </div>
        </div>
      </section>

      <!-- Sleep timer settings -->
      <section v-if="!isiOS">
        <h2 class="settings-section-header">{{ $strings.HeaderSleepTimerSettings }}</h2>
        <div class="settings-card">
          <div class="settings-row" @click="toggleDisableShakeToResetSleepTimer">
            <span class="settings-row-icon material-symbols">vibration</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelDisableShakeToReset }}</p>
            </div>
            <button class="settings-row-info" @click.stop="showInfo('disableShakeToResetSleepTimer')">
              <span class="material-symbols">info</span>
            </button>
            <ui-toggle-switch v-model="settings.disableShakeToResetSleepTimer" class="pointer-events-none" />
          </div>
          <div v-if="!settings.disableShakeToResetSleepTimer" class="settings-row" @click.stop="showShakeSensitivityOptions">
            <span class="settings-row-icon material-symbols">tune</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelShakeSensitivity }}</p>
              <p class="settings-row-value">{{ shakeSensitivityOption }}</p>
            </div>
            <span class="material-symbols settings-row-trailing">expand_more</span>
          </div>
          <div class="settings-row" @click="toggleDisableSleepTimerFadeOut">
            <span class="settings-row-icon material-symbols">volume_off</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelDisableAudioFadeOut }}</p>
            </div>
            <button class="settings-row-info" @click.stop="showInfo('disableSleepTimerFadeOut')">
              <span class="material-symbols">info</span>
            </button>
            <ui-toggle-switch v-model="settings.disableSleepTimerFadeOut" class="pointer-events-none" />
          </div>
          <div class="settings-row" @click="toggleDisableSleepTimerResetFeedback">
            <span class="settings-row-icon material-symbols">vibration</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelDisableVibrateOnReset }}</p>
            </div>
            <button class="settings-row-info" @click.stop="showInfo('disableSleepTimerResetFeedback')">
              <span class="material-symbols">info</span>
            </button>
            <ui-toggle-switch v-model="settings.disableSleepTimerResetFeedback" class="pointer-events-none" />
          </div>
          <div class="settings-row" @click="toggleSleepTimerAlmostDoneChime">
            <span class="settings-row-icon material-symbols">notifications_active</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelSleepTimerAlmostDoneChime }}</p>
            </div>
            <button class="settings-row-info" @click.stop="showInfo('enableSleepTimerAlmostDoneChime')">
              <span class="material-symbols">info</span>
            </button>
            <ui-toggle-switch v-model="settings.enableSleepTimerAlmostDoneChime" class="pointer-events-none" />
          </div>
          <div class="settings-row" @click="toggleAutoSleepTimer">
            <span class="settings-row-icon material-symbols">schedule</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelAutoSleepTimer }}</p>
            </div>
            <button class="settings-row-info" @click.stop="showInfo('autoSleepTimer')">
              <span class="material-symbols">info</span>
            </button>
            <ui-toggle-switch v-model="settings.autoSleepTimer" class="pointer-events-none" />
          </div>
          <template v-if="settings.autoSleepTimer">
            <div class="settings-row">
              <span class="settings-row-icon material-symbols">bedtime</span>
              <div class="settings-row-text">
                <p class="settings-row-title">{{ $strings.LabelStartTime }}</p>
              </div>
              <ui-text-input type="time" v-model="settings.autoSleepTimerStartTime" variant="outlined" style="width: 130px" @input="autoSleepTimerTimeUpdated" />
            </div>
            <div class="settings-row">
              <span class="settings-row-icon material-symbols">alarm</span>
              <div class="settings-row-text">
                <p class="settings-row-title">{{ $strings.LabelEndTime }}</p>
              </div>
              <ui-text-input type="time" v-model="settings.autoSleepTimerEndTime" variant="outlined" style="width: 130px" @input="autoSleepTimerTimeUpdated" />
            </div>
            <div class="settings-row" @click.stop="showSleepTimerOptions">
              <span class="settings-row-icon material-symbols">timer</span>
              <div class="settings-row-text">
                <p class="settings-row-title">{{ $strings.LabelSleepTimer }}</p>
                <p class="settings-row-value">{{ sleepTimerLengthOption }}</p>
              </div>
              <span class="material-symbols settings-row-trailing">expand_more</span>
            </div>
            <div class="settings-row" @click="toggleAutoSleepTimerAutoRewind">
              <span class="settings-row-icon material-symbols">replay_30</span>
              <div class="settings-row-text">
                <p class="settings-row-title">{{ $strings.LabelAutoSleepTimerAutoRewind }}</p>
              </div>
              <button class="settings-row-info" @click.stop="showInfo('autoSleepTimerAutoRewind')">
                <span class="material-symbols">info</span>
              </button>
              <ui-toggle-switch v-model="settings.autoSleepTimerAutoRewind" class="pointer-events-none" />
            </div>
            <div v-if="settings.autoSleepTimerAutoRewind" class="settings-row" @click.stop="showAutoSleepTimerRewindOptions">
              <span class="settings-row-icon material-symbols">history</span>
              <div class="settings-row-text">
                <p class="settings-row-title">{{ $strings.LabelAutoRewindTime }}</p>
                <p class="settings-row-value">{{ autoSleepTimerRewindLengthOption }}</p>
              </div>
              <span class="material-symbols settings-row-trailing">expand_more</span>
            </div>
          </template>
        </div>
      </section>

      <!-- iOS-only fade-out toggle (no auto sleep timer section above) -->
      <section v-else>
        <h2 class="settings-section-header">{{ $strings.HeaderSleepTimerSettings }}</h2>
        <div class="settings-card">
          <div class="settings-row" @click="toggleDisableSleepTimerFadeOut">
            <span class="settings-row-icon material-symbols">volume_off</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelDisableAudioFadeOut }}</p>
            </div>
            <button class="settings-row-info" @click.stop="showInfo('disableSleepTimerFadeOut')">
              <span class="material-symbols">info</span>
            </button>
            <ui-toggle-switch v-model="settings.disableSleepTimerFadeOut" class="pointer-events-none" />
          </div>
        </div>
      </section>

      <!-- Data settings -->
      <section>
        <h2 class="settings-section-header">{{ $strings.HeaderDataSettings }}</h2>
        <div class="settings-card">
          <div class="settings-row" @click.stop="showDownloadUsingCellularOptions">
            <span class="settings-row-icon material-symbols">download</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelDownloadUsingCellular }}</p>
              <p class="settings-row-value">{{ downloadUsingCellularOption }}</p>
            </div>
            <span class="material-symbols settings-row-trailing">expand_more</span>
          </div>
          <div class="settings-row" @click.stop="showStreamingUsingCellularOptions">
            <span class="settings-row-icon material-symbols">network_cell</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelStreamingUsingCellular }}</p>
              <p class="settings-row-value">{{ streamingUsingCellularOption }}</p>
            </div>
            <span class="material-symbols settings-row-trailing">expand_more</span>
          </div>
        </div>
      </section>

      <!-- Android Auto settings -->
      <section v-if="!isiOS">
        <h2 class="settings-section-header">{{ $strings.HeaderAndroidAutoSettings }}</h2>
        <div class="settings-card">
          <div class="settings-row">
            <span class="settings-row-icon material-symbols">format_list_numbered</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelAndroidAutoBrowseLimitForGrouping }}</p>
            </div>
            <button class="settings-row-info" @click.stop="showInfo('androidAutoBrowseLimitForGrouping')">
              <span class="material-symbols">info</span>
            </button>
            <ui-text-input type="number" v-model="settings.androidAutoBrowseLimitForGrouping" variant="outlined" style="width: 110px" @input="androidAutoBrowseLimitForGroupingUpdated" />
          </div>
          <div class="settings-row" @click.stop="showAndroidAutoBrowseSeriesSequenceOrderOptions">
            <span class="settings-row-icon material-symbols">sort</span>
            <div class="settings-row-text">
              <p class="settings-row-title">{{ $strings.LabelAndroidAutoBrowseSeriesSequenceOrder }}</p>
              <p class="settings-row-value">{{ androidAutoBrowseSeriesSequenceOrderOption }}</p>
            </div>
            <span class="material-symbols settings-row-trailing">expand_more</span>
          </div>
        </div>
      </section>
    </div>

    <div v-show="loading" class="w-full h-full absolute top-0 left-0 flex items-center justify-center z-10">
      <ui-loading-indicator />
    </div>

    <modals-dialog v-model="showMoreMenuDialog" :items="moreMenuItems" @action="clickMenuAction" />
    <modals-sleep-timer-length-modal v-model="showSleepTimerLengthModal" @change="sleepTimerLengthModalSelection" />
    <modals-auto-sleep-timer-rewind-length-modal v-model="showAutoSleepTimerRewindLengthModal" @change="showAutoSleepTimerRewindLengthModalSelection" />
  </div>
</template>

<script>
import { Dialog } from '@capacitor/dialog'

export default {
  data() {
    return {
      loading: false,
      deviceData: null,
      showMoreMenuDialog: false,
      showSleepTimerLengthModal: false,
      showAutoSleepTimerRewindLengthModal: false,
      moreMenuSetting: '',
      settings: {
        disableAutoRewind: false,
        enableAltView: true,
        allowSeekingOnMediaControls: false,
        jumpForwardTime: 10,
        jumpBackwardsTime: 10,
        enableMp3IndexSeeking: false,
        disableShakeToResetSleepTimer: false,
        shakeSensitivity: 'MEDIUM',
        lockOrientation: 0,
        hapticFeedback: 'LIGHT',
        autoSleepTimer: false,
        autoSleepTimerStartTime: '22:00',
        autoSleepTimerEndTime: '06:00',
        sleepTimerLength: 900000, // 15 minutes
        disableSleepTimerFadeOut: false,
        disableSleepTimerResetFeedback: false,
        enableSleepTimerAlmostDoneChime: false,
        autoSleepTimerAutoRewind: false,
        autoSleepTimerAutoRewindTime: 300000, // 5 minutes
        languageCode: 'en-us',
        downloadUsingCellular: 'ALWAYS',
        streamingUsingCellular: 'ALWAYS',
        androidAutoBrowseLimitForGrouping: 100,
        androidAutoBrowseSeriesSequenceOrder: 'ASC',
        enableDynamicColors: true
      },
      theme: 'system',
      lockCurrentOrientation: false,
      settingInfo: {
        disableShakeToResetSleepTimer: {
          name: this.$strings.LabelDisableShakeToReset,
          message: this.$strings.LabelDisableShakeToResetHelp
        },
        autoSleepTimer: {
          name: this.$strings.LabelAutoSleepTimer,
          message: this.$strings.LabelAutoSleepTimerHelp
        },
        disableSleepTimerFadeOut: {
          name: this.$strings.LabelDisableAudioFadeOut,
          message: this.$strings.LabelDisableAudioFadeOutHelp
        },
        disableSleepTimerResetFeedback: {
          name: this.$strings.LabelDisableVibrateOnReset,
          message: this.$strings.LabelDisableVibrateOnResetHelp
        },
        dynamicColors: {
          name: 'Dynamic Colors',
          message: 'Use Material You dynamic colors based on your wallpaper. Available on Android 12+ devices. The app will restart to apply changes.'
        },
        enableSleepTimerAlmostDoneChime: {
          name: this.$strings.LabelSleepTimerAlmostDoneChime,
          message: this.$strings.LabelSleepTimerAlmostDoneChimeHelp
        },
        autoSleepTimerAutoRewind: {
          name: this.$strings.LabelAutoSleepTimerAutoRewind,
          message: this.$strings.LabelAutoSleepTimerAutoRewindHelp
        },
        enableMp3IndexSeeking: {
          name: this.$strings.LabelEnableMp3IndexSeeking,
          message: this.$strings.LabelEnableMp3IndexSeekingHelp
        },
        androidAutoBrowseLimitForGrouping: {
          name: this.$strings.LabelAndroidAutoBrowseLimitForGrouping,
          message: this.$strings.LabelAndroidAutoBrowseLimitForGroupingHelp
        }
      },
      hapticFeedbackItems: [
        {
          text: this.$strings.LabelOff,
          value: 'OFF'
        },
        {
          text: this.$strings.LabelLight,
          value: 'LIGHT'
        },
        {
          text: this.$strings.LabelMedium,
          value: 'MEDIUM'
        },
        {
          text: this.$strings.LabelHeavy,
          value: 'HEAVY'
        }
      ],
      shakeSensitivityItems: [
        {
          text: this.$strings.LabelVeryLow,
          value: 'VERY_LOW'
        },
        {
          text: this.$strings.LabelLow,
          value: 'LOW'
        },
        {
          text: this.$strings.LabelMedium,
          value: 'MEDIUM'
        },
        {
          text: this.$strings.LabelHigh,
          value: 'HIGH'
        },
        {
          text: this.$strings.LabelVeryHigh,
          value: 'VERY_HIGH'
        }
      ],
      downloadUsingCellularItems: [
        {
          text: this.$strings.LabelAskConfirmation,
          value: 'ASK'
        },
        {
          text: this.$strings.LabelAlways,
          value: 'ALWAYS'
        },
        {
          text: this.$strings.LabelNever,
          value: 'NEVER'
        }
      ],
      streamingUsingCellularItems: [
        {
          text: this.$strings.LabelAskConfirmation,
          value: 'ASK'
        },
        {
          text: this.$strings.LabelAlways,
          value: 'ALWAYS'
        },
        {
          text: this.$strings.LabelNever,
          value: 'NEVER'
        }
      ],
      androidAutoBrowseSeriesSequenceOrderItems: [
        {
          text: this.$strings.LabelSequenceAscending,
          value: 'ASC'
        },
        {
          text: this.$strings.LabelSequenceDescending,
          value: 'DESC'
        }
      ]
    }
  },
  computed: {
    isiOS() {
      return this.$platform === 'ios'
    },
    jumpForwardItems() {
      const items = this.$store.state.globals.jumpForwardItems || []
      return items.map((i) => ({ ...i, text: `${i.value}s` }))
    },
    jumpBackwardsItems() {
      const items = this.$store.state.globals.jumpBackwardsItems || []
      return items.map((i) => ({ ...i, text: `${i.value}s` }))
    },
    languageOptionItems() {
      return this.$languageCodeOptions || []
    },
    themeOptionItems() {
      return [
        {
          text: this.$strings.LabelThemeSystem || 'System',
          value: 'system'
        },
        {
          text: this.$strings.LabelThemeDark || 'Dark',
          value: 'dark'
        },
        {
          text: this.$strings.LabelThemeLight || 'Light',
          value: 'light'
        }
      ]
    },
    currentJumpForwardTimeIcon() {
      return this.jumpForwardItems[this.currentJumpForwardTimeIndex].icon
    },
    currentJumpForwardTimeIndex() {
      var index = this.jumpForwardItems.findIndex((jfi) => jfi.value === this.settings.jumpForwardTime)
      return index >= 0 ? index : 1
    },
    currentJumpBackwardsTimeIcon() {
      return this.jumpBackwardsItems[this.currentJumpBackwardsTimeIndex].icon
    },
    currentJumpBackwardsTimeIndex() {
      var index = this.jumpBackwardsItems.findIndex((jfi) => jfi.value === this.settings.jumpBackwardsTime)
      return index >= 0 ? index : 1
    },
    jumpForwardTimeOption() {
      const item = this.jumpForwardItems.find((i) => i.value === this.settings.jumpForwardTime)
      return item?.text || `${this.settings.jumpForwardTime}s`
    },
    jumpBackwardsTimeOption() {
      const item = this.jumpBackwardsItems.find((i) => i.value === this.settings.jumpBackwardsTime)
      return item?.text || `${this.settings.jumpBackwardsTime}s`
    },
    shakeSensitivityOption() {
      const item = this.shakeSensitivityItems.find((i) => i.value === this.settings.shakeSensitivity)
      return item?.text || 'Error'
    },
    hapticFeedbackOption() {
      const item = this.hapticFeedbackItems.find((i) => i.value === this.settings.hapticFeedback)
      return item?.text || 'Error'
    },
    languageOption() {
      return this.languageOptionItems.find((i) => i.value === this.settings.languageCode)?.text || ''
    },
    themeOption() {
      return this.themeOptionItems.find((i) => i.value === this.theme)?.text || ''
    },
    hideNonAudiobooksGlobal() {
      return !!this.$store.getters['user/getUserSetting']('hideNonAudiobooksGlobal')
    },
    sleepTimerLengthOption() {
      if (!this.settings.sleepTimerLength) return this.$strings.LabelEndOfChapter
      const minutes = Number(this.settings.sleepTimerLength) / 1000 / 60
      return `${minutes} min`
    },
    autoSleepTimerRewindLengthOption() {
      const minutes = Number(this.settings.autoSleepTimerAutoRewindTime) / 1000 / 60
      return `${minutes} min`
    },
    downloadUsingCellularOption() {
      const item = this.downloadUsingCellularItems.find((i) => i.value === this.settings.downloadUsingCellular)
      return item?.text || 'Error'
    },
    streamingUsingCellularOption() {
      const item = this.streamingUsingCellularItems.find((i) => i.value === this.settings.streamingUsingCellular)
      return item?.text || 'Error'
    },
    androidAutoBrowseSeriesSequenceOrderOption() {
      const item = this.androidAutoBrowseSeriesSequenceOrderItems.find((i) => i.value === this.settings.androidAutoBrowseSeriesSequenceOrder)
      return item?.text || 'Error'
    },
    moreMenuItems() {
      if (this.moreMenuSetting === 'shakeSensitivity') return this.shakeSensitivityItems
      else if (this.moreMenuSetting === 'hapticFeedback') return this.hapticFeedbackItems
      else if (this.moreMenuSetting === 'language') return this.languageOptionItems
      else if (this.moreMenuSetting === 'theme') return this.themeOptionItems
      else if (this.moreMenuSetting === 'downloadUsingCellular') return this.downloadUsingCellularItems
      else if (this.moreMenuSetting === 'streamingUsingCellular') return this.streamingUsingCellularItems
      else if (this.moreMenuSetting === 'androidAutoBrowseSeriesSequenceOrder') return this.androidAutoBrowseSeriesSequenceOrderItems
      else if (this.moreMenuSetting === 'jumpForward') return this.jumpForwardItems
      else if (this.moreMenuSetting === 'jumpBackwards') return this.jumpBackwardsItems
      return []
    },
    contentPaddingStyle() {
      return this.$store.getters['getIsPlayerOpen'] ? { paddingBottom: '120px' } : {}
    }
  },
  methods: {
    sleepTimerLengthModalSelection(value) {
      this.settings.sleepTimerLength = value
      this.saveSettings()
    },
    showAutoSleepTimerRewindLengthModalSelection(value) {
      this.settings.autoSleepTimerAutoRewindTime = value
      this.saveSettings()
    },
    showSleepTimerOptions() {
      this.showSleepTimerLengthModal = true
    },
    showAutoSleepTimerRewindOptions() {
      this.showAutoSleepTimerRewindLengthModal = true
    },
    showHapticFeedbackOptions() {
      this.moreMenuSetting = 'hapticFeedback'
      this.showMoreMenuDialog = true
    },
    showShakeSensitivityOptions() {
      this.moreMenuSetting = 'shakeSensitivity'
      this.showMoreMenuDialog = true
    },
    showLanguageOptions() {
      this.moreMenuSetting = 'language'
      this.showMoreMenuDialog = true
    },
    showThemeOptions() {
      this.moreMenuSetting = 'theme'
      this.showMoreMenuDialog = true
    },
    showDownloadUsingCellularOptions() {
      this.moreMenuSetting = 'downloadUsingCellular'
      this.showMoreMenuDialog = true
    },
    showStreamingUsingCellularOptions() {
      this.moreMenuSetting = 'streamingUsingCellular'
      this.showMoreMenuDialog = true
    },
    showAndroidAutoBrowseSeriesSequenceOrderOptions() {
      this.moreMenuSetting = 'androidAutoBrowseSeriesSequenceOrder'
      this.showMoreMenuDialog = true
    },
    clickMenuAction(action) {
      this.showMoreMenuDialog = false
      if (this.moreMenuSetting === 'shakeSensitivity') {
        this.settings.shakeSensitivity = action
        this.saveSettings()
      } else if (this.moreMenuSetting === 'hapticFeedback') {
        this.settings.hapticFeedback = action
        this.hapticFeedbackUpdated(action)
      } else if (this.moreMenuSetting === 'language') {
        this.settings.languageCode = action
        this.saveSettings()
      } else if (this.moreMenuSetting === 'theme') {
        this.theme = action
        this.saveTheme(action)
      } else if (this.moreMenuSetting === 'downloadUsingCellular') {
        this.settings.downloadUsingCellular = action
        this.saveSettings()
      } else if (this.moreMenuSetting === 'streamingUsingCellular') {
        this.settings.streamingUsingCellular = action
        this.saveSettings()
      } else if (this.moreMenuSetting === 'androidAutoBrowseSeriesSequenceOrder') {
        this.settings.androidAutoBrowseSeriesSequenceOrder = action
        this.saveSettings()
      } else if (this.moreMenuSetting === 'jumpForward') {
        this.settings.jumpForwardTime = action
        this.saveSettings()
      } else if (this.moreMenuSetting === 'jumpBackwards') {
        this.settings.jumpBackwardsTime = action
        this.saveSettings()
      }
    },
    saveTheme(theme) {
      console.log('=== THEME CHANGE DEBUG ===')
      console.log('New theme requested:', theme)
      console.log('Current document theme:', document.documentElement.dataset.theme)
      console.log('Dynamic colors enabled:', this.settings.enableDynamicColors)
      console.log('DynamicColor service available:', !!this.$dynamicColor)

      if (theme === 'system') {
        // Use system theme - detect and apply based on Android system preference
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        console.log('System prefers dark mode:', prefersDark)
        document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light'
        console.log('Applied document theme:', document.documentElement.dataset.theme)

        // Listen for system theme changes
        if (window.matchMedia) {
          const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
          mediaQuery.addEventListener('change', (e) => {
            if (this.theme === 'system') {
              console.log('System theme changed, new dark mode:', e.matches)
              document.documentElement.dataset.theme = e.matches ? 'dark' : 'light'
              // Reapply Material You colors for the new theme
              if (this.$dynamicColor && this.settings.enableDynamicColors) {
                console.log('Reapplying Material You colors for system theme change')
                this.$dynamicColor.initialize('system')
              }
            }
          })
        }
      } else if (theme === 'dark') {
        // Use Material You dark theme
        console.log('Applying dark theme to document')
        document.documentElement.dataset.theme = 'dark'
      } else if (theme === 'light') {
        // Use Material You light theme
        console.log('Applying light theme to document')
        document.documentElement.dataset.theme = 'light'
      }

      // Apply Material You colors for all themes if enabled - pass the theme parameter
      if (this.$dynamicColor && this.settings.enableDynamicColors) {
        console.log('Calling Material You initialize with theme:', theme)
        this.$dynamicColor.initialize(theme)
      } else if (!this.$dynamicColor) {
        console.log('DynamicColor service not available - Material You colors will not be applied')
      } else if (!this.settings.enableDynamicColors) {
        console.log('Dynamic colors disabled in settings - skipping Material You colors')
      }

      console.log('=== END THEME CHANGE DEBUG ===')

      this.$localStore.setTheme(theme)
    },
    autoSleepTimerTimeUpdated(val) {
      if (!val) return // invalid times return falsy
      this.saveSettings()
    },
    androidAutoBrowseLimitForGroupingUpdated(val) {
      if (!val) return // invalid times return falsy
      if (val > 1000) val = 1000
      if (val < 30) val = 30
      this.saveSettings()
    },
    hapticFeedbackUpdated(val) {
      this.$store.commit('globals/setHapticFeedback', val)
      this.saveSettings()
    },
    showInfo(setting) {
      if (this.settingInfo[setting]) {
        Dialog.alert({
          title: this.settingInfo[setting].name,
          message: this.settingInfo[setting].message
        })
      }
    },
    async showConfirmMp3IndexSeeking() {
      const confirmResult = await Dialog.confirm({
        title: this.settingInfo.enableMp3IndexSeeking.name,
        message: this.settingInfo.enableMp3IndexSeeking.message,
        cancelButtonTitle: 'View More'
      })
      if (!confirmResult.value) {
        window.open('https://exoplayer.dev/troubleshooting.html#why-is-seeking-inaccurate-in-some-mp3-files', '_blank')
      }
    },
    toggleEnableMp3IndexSeeking() {
      this.settings.enableMp3IndexSeeking = !this.settings.enableMp3IndexSeeking
      this.saveSettings()
    },
    toggleAutoSleepTimer() {
      this.settings.autoSleepTimer = !this.settings.autoSleepTimer
      this.saveSettings()
    },
    toggleAutoSleepTimerAutoRewind() {
      this.settings.autoSleepTimerAutoRewind = !this.settings.autoSleepTimerAutoRewind
      this.saveSettings()
    },
    toggleDisableSleepTimerFadeOut() {
      this.settings.disableSleepTimerFadeOut = !this.settings.disableSleepTimerFadeOut
      this.saveSettings()
    },
    toggleDisableShakeToResetSleepTimer() {
      this.settings.disableShakeToResetSleepTimer = !this.settings.disableShakeToResetSleepTimer
      this.saveSettings()
    },
    toggleDisableSleepTimerResetFeedback() {
      this.settings.disableSleepTimerResetFeedback = !this.settings.disableSleepTimerResetFeedback
      this.saveSettings()
    },
    toggleSleepTimerAlmostDoneChime() {
      this.settings.enableSleepTimerAlmostDoneChime = !this.settings.enableSleepTimerAlmostDoneChime
      this.saveSettings()
    },
    toggleDisableAutoRewind() {
      this.settings.disableAutoRewind = !this.settings.disableAutoRewind
      this.saveSettings()
    },
    toggleAllowSeekingOnMediaControls() {
      this.settings.allowSeekingOnMediaControls = !this.settings.allowSeekingOnMediaControls
      this.saveSettings()
    },
    async toggleDynamicColors() {
      this.settings.enableDynamicColors = !this.settings.enableDynamicColors
      this.saveSettings()

      // Apply or remove dynamic colors immediately
      if (this.$dynamicColor) {
        if (this.settings.enableDynamicColors) {
          // Get current theme and pass it to initialize
          const currentTheme = this.theme || 'system'
          await this.$dynamicColor.initialize(currentTheme)
          this.$toast.info('Material You colors enabled', { timeout: 2000 })
        } else {
          // Clear dynamic colors and use static Material 3 theme
          this.$dynamicColor.clearDynamicColors()
          this.$toast.info('Using static Material 3 theme', { timeout: 2000 })
        }
      }
    },
    async toggleHideNonAudiobooksGlobal() {
      const nextValue = !this.hideNonAudiobooksGlobal
      await this.$hapticsImpact()
      await this.$store.dispatch('user/updateUserSettings', {
        hideNonAudiobooksGlobal: nextValue
      })
    },
    getCurrentOrientation() {
      const orientation = window.screen?.orientation || {}
      const type = orientation.type || ''

      if (type.includes('landscape')) return 'LANDSCAPE'
      return 'PORTRAIT' // default
    },
    toggleLockOrientation() {
      this.lockCurrentOrientation = !this.lockCurrentOrientation
      if (this.lockCurrentOrientation) {
        this.settings.lockOrientation = this.getCurrentOrientation()
      } else {
        this.settings.lockOrientation = 'NONE'
      }
      this.$setOrientationLock(this.settings.lockOrientation)
      this.saveSettings()
    },
    toggleJumpForward() {
      var next = (this.currentJumpForwardTimeIndex + 1) % 3
      this.settings.jumpForwardTime = this.jumpForwardItems[next].value
      this.saveSettings()
    },
    toggleJumpBackwards() {
      var next = (this.currentJumpBackwardsTimeIndex + 4) % 3
      if (next > 2) return
      this.settings.jumpBackwardsTime = this.jumpBackwardsItems[next].value
      this.saveSettings()
    },
    showJumpForwardOptions() {
      this.moreMenuSetting = 'jumpForward'
      this.showMoreMenuDialog = true
    },
    showJumpBackwardsOptions() {
      this.moreMenuSetting = 'jumpBackwards'
      this.showMoreMenuDialog = true
    },
    async saveSettings() {
      await this.$hapticsImpact()
      const updatedDeviceData = await this.$db.updateDeviceSettings({ ...this.settings })
      if (updatedDeviceData) {
        this.$store.commit('setDeviceData', updatedDeviceData)
        this.deviceData = updatedDeviceData
        this.$setLanguageCode(updatedDeviceData.deviceSettings?.languageCode || 'en-us')
        this.setDeviceSettings()
      }
    },
    setDeviceSettings() {
      const deviceSettings = this.deviceData.deviceSettings || {}
      this.settings.disableAutoRewind = !!deviceSettings.disableAutoRewind
      this.settings.enableAltView = !!deviceSettings.enableAltView
      this.settings.allowSeekingOnMediaControls = !!deviceSettings.allowSeekingOnMediaControls
      this.settings.jumpForwardTime = deviceSettings.jumpForwardTime || 10
      this.settings.jumpBackwardsTime = deviceSettings.jumpBackwardsTime || 10
      this.settings.enableMp3IndexSeeking = !!deviceSettings.enableMp3IndexSeeking

      this.settings.lockOrientation = deviceSettings.lockOrientation || 'NONE'
      this.lockCurrentOrientation = this.settings.lockOrientation !== 'NONE'
      this.settings.hapticFeedback = deviceSettings.hapticFeedback || 'LIGHT'

      this.settings.disableShakeToResetSleepTimer = !!deviceSettings.disableShakeToResetSleepTimer
      this.settings.shakeSensitivity = deviceSettings.shakeSensitivity || 'MEDIUM'
      this.settings.autoSleepTimer = !!deviceSettings.autoSleepTimer
      this.settings.autoSleepTimerStartTime = deviceSettings.autoSleepTimerStartTime || '22:00'
      this.settings.autoSleepTimerEndTime = deviceSettings.autoSleepTimerEndTime || '06:00'
      this.settings.sleepTimerLength = !isNaN(deviceSettings.sleepTimerLength) ? deviceSettings.sleepTimerLength : 900000 // 15 minutes
      this.settings.disableSleepTimerFadeOut = !!deviceSettings.disableSleepTimerFadeOut
      this.settings.disableSleepTimerResetFeedback = !!deviceSettings.disableSleepTimerResetFeedback
      this.settings.enableSleepTimerAlmostDoneChime = !!deviceSettings.enableSleepTimerAlmostDoneChime

      this.settings.autoSleepTimerAutoRewind = !!deviceSettings.autoSleepTimerAutoRewind
      this.settings.autoSleepTimerAutoRewindTime = !isNaN(deviceSettings.autoSleepTimerAutoRewindTime) ? deviceSettings.autoSleepTimerAutoRewindTime : 300000 // 5 minutes

      this.settings.languageCode = deviceSettings.languageCode || 'en-us'

      this.settings.downloadUsingCellular = deviceSettings.downloadUsingCellular || 'ALWAYS'
      this.settings.streamingUsingCellular = deviceSettings.streamingUsingCellular || 'ALWAYS'

      this.settings.enableDynamicColors = deviceSettings.enableDynamicColors !== undefined ? deviceSettings.enableDynamicColors : true

      this.settings.androidAutoBrowseLimitForGrouping = deviceSettings.androidAutoBrowseLimitForGrouping
      this.settings.androidAutoBrowseSeriesSequenceOrder = deviceSettings.androidAutoBrowseSeriesSequenceOrder || 'ASC'
    },
    async init() {
      this.loading = true
      this.theme = (await this.$localStore.getTheme()) || 'system'

      // Apply theme immediately
      this.saveTheme(this.theme)

      this.deviceData = await this.$db.getDeviceData()
      this.$store.commit('setDeviceData', this.deviceData)
      this.setDeviceSettings()
      this.loading = false
    }
  },
  mounted() {
    this.init()
  }
}
</script>

<style scoped>
.settings-section-header {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(var(--md-sys-color-primary));
  padding: 0 16px 8px 16px;
}

.settings-card {
  background-color: rgb(var(--md-sys-color-surface-container));
  border-radius: 24px;
  overflow: hidden;
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  min-height: 64px;
  cursor: pointer;
  position: relative;
  transition: background-color 150ms ease;
}

.settings-row + .settings-row {
  border-top: 1px solid rgb(var(--md-sys-color-outline-variant) / 0.5);
}

.settings-row:active {
  background-color: rgb(var(--md-sys-color-on-surface) / 0.08);
}

.settings-row-icon {
  font-size: 24px;
  color: rgb(var(--md-sys-color-on-surface-variant));
  flex-shrink: 0;
  width: 32px;
  text-align: center;
}

.settings-row-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-row-title {
  font-size: 1rem;
  line-height: 1.4;
  color: rgb(var(--md-sys-color-on-surface));
}

.settings-row-value {
  font-size: 0.8125rem;
  line-height: 1.3;
  color: rgb(var(--md-sys-color-on-surface-variant));
}

.settings-row-supporting {
  font-size: 0.8125rem;
  line-height: 1.3;
  color: rgb(var(--md-sys-color-on-surface-variant));
}

.settings-row-trailing {
  font-size: 22px;
  color: rgb(var(--md-sys-color-on-surface-variant));
  flex-shrink: 0;
}

.settings-row-info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 18px;
  color: rgb(var(--md-sys-color-on-surface-variant));
  flex-shrink: 0;
  transition: background-color 150ms ease;
}

.settings-row-info:active {
  background-color: rgb(var(--md-sys-color-on-surface) / 0.12);
}

.settings-row-info .material-symbols {
  font-size: 20px;
}

/* Keep the toggle switch flush-right and consistent across rows by
   canceling the negative margins from its state-layer wrapper. */
.settings-row > .state-layer {
  margin: 0 !important;
  padding: 8px !important;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.settings-row > .state-layer > .material-3-switch {
  width: 52px !important;
  height: 32px !important;
}
</style>
