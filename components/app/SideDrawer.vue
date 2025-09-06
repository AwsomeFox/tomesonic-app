<template>
  <div class="fixed top-0 left-0 right-0 layout-wrapper w-full overflow-hidden pointer-events-none" style="z-index: 80">
    <!-- Material 3 Scrim -->
    <div class="absolute top-0 left-0 w-full h-full bg-black transition-opacity duration-300 ease-standard" :class="show ? 'bg-opacity-32 pointer-events-auto' : 'bg-opacity-0'" @click="clickBackground" />

    <!-- Material 3 Navigation Drawer -->
    <div class="absolute top-0 left-0 w-80 h-full bg-surface-dynamic shadow-elevation-1 transform transition-transform duration-300 ease-emphasized pointer-events-auto" :class="show ? '' : '-translate-x-80'" @click.stop>
      <!-- Header Section -->
      <div class="px-6 py-6 border-b border-outline-variant">
        <p v-if="user" class="text-title-medium text-on-surface">
          {{ $strings.HeaderWelcome }},
          <span class="text-primary font-medium">{{ username }}</span>
        </p>
        <p v-else class="text-title-medium text-on-surface">{{ $strings.HeaderMenu }}</p>
      </div>

      <!-- Navigation Items -->
      <div class="w-full overflow-y-auto flex-1 py-2">
        <template v-for="item in navItems">
          <button v-if="item.action" :key="item.text" class="w-full state-layer flex items-center py-4 px-6 text-on-surface-variant hover:bg-on-surface/8 transition-colors duration-200 ease-standard" @click="clickAction(item.action)">
            <span class="material-symbols text-2xl mr-3 text-on-surface-variant" :class="item.iconOutlined ? '' : 'fill'">{{ item.icon }}</span>
            <p class="text-body-large">{{ item.text }}</p>
          </button>
          <nuxt-link v-else :to="item.to" :key="item.text" class="w-full state-layer flex items-center py-4 px-6 transition-colors duration-200 ease-standard" :class="currentRoutePath.startsWith(item.to) ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-on-surface/8'">
            <span class="material-symbols text-2xl mr-3" :class="[item.iconOutlined ? '' : 'fill', currentRoutePath.startsWith(item.to) ? 'text-on-primary-container' : 'text-on-surface-variant']">{{ item.icon }}</span>
            <p class="text-body-large">{{ item.text }}</p>
          </nuxt-link>
        </template>
      </div>

      <!-- Footer Section -->
      <div class="border-t border-outline-variant px-6 py-4">
        <div v-if="serverConnectionConfig" class="mb-3 text-center">
          <p class="text-body-small text-on-surface-variant break-all">{{ serverConnectionConfig.address }}</p>
          <p class="text-body-small text-on-surface-variant">v{{ serverSettings.version }}</p>
        </div>
        <div class="flex items-center justify-between">
          <p class="text-body-small text-on-surface-variant">v{{ $config.version }}</p>
          <ui-btn v-if="user" variant="text" color="error" small @click="disconnect">
            {{ $strings.ButtonDisconnect }}
            <span class="material-symbols text-sm ml-1 text-on-surface-variant">cloud_off</span>
          </ui-btn>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import TouchEvent from '@/objects/TouchEvent'

export default {
  data() {
    return {
      touchEvent: null
    }
  },
  watch: {
    $route: {
      handler() {
        this.show = false
      }
    },
    show: {
      handler(newVal) {
        if (newVal) this.registerListener()
        else this.removeListener()
      }
    }
  },
  computed: {
    show: {
      get() {
        return this.$store.state.showSideDrawer
      },
      set(val) {
        this.$store.commit('setShowSideDrawer', val)
      }
    },
    user() {
      return this.$store.state.user.user
    },
    serverConnectionConfig() {
      return this.$store.state.user.serverConnectionConfig
    },
    serverSettings() {
      return this.$store.state.serverSettings || {}
    },
    username() {
      return this.user?.username || ''
    },
    userIsAdminOrUp() {
      return this.$store.getters['user/getIsAdminOrUp']
    },
    navItems() {
      var items = [
        {
          icon: 'home',
          text: this.$strings.ButtonHome,
          to: '/bookshelf'
        }
      ]
      if (!this.serverConnectionConfig) {
        items = [
          {
            icon: 'cloud_off',
            text: this.$strings.ButtonConnectToServer,
            to: '/connect'
          }
        ].concat(items)
      } else {
        items.push({
          icon: 'person',
          text: this.$strings.HeaderAccount,
          to: '/account'
        })
        items.push({
          icon: 'equalizer',
          text: this.$strings.ButtonUserStats,
          to: '/stats'
        })
      }

      if (this.$platform !== 'ios') {
        items.push({
          icon: 'folder',
          iconOutlined: true,
          text: this.$strings.ButtonLocalMedia,
          to: '/localMedia/folders'
        })
      } else {
        items.push({
          icon: 'download',
          iconOutlined: false,
          text: this.$strings.HeaderDownloads,
          to: '/downloads'
        })
      }
      items.push({
        icon: 'settings',
        text: this.$strings.HeaderSettings,
        to: '/settings'
      })

      if (this.$platform !== 'ios') {
        items.push({
          icon: 'bug_report',
          iconOutlined: true,
          text: this.$strings.ButtonLogs,
          to: '/logs'
        })
      }

      if (this.serverConnectionConfig) {
        items.push({
          icon: 'language',
          text: this.$strings.ButtonGoToWebClient,
          action: 'openWebClient'
        })

        items.push({
          icon: 'login',
          text: this.$strings.ButtonSwitchServerUser,
          action: 'logout'
        })
      }

      return items
    },
    currentRoutePath() {
      return this.$route.path
    }
  },
  methods: {
    async clickAction(action) {
      await this.$hapticsImpact()
      if (action === 'logout') {
        await this.logout()
        this.$router.push('/connect')
      } else if (action === 'openWebClient') {
        this.show = false
        let path = `/library/${this.$store.state.libraries.currentLibraryId}`
        await this.$store.dispatch('user/openWebClient', path)
      }
    },
    clickBackground() {
      this.show = false
    },
    async logout() {
      await this.$store.dispatch('user/logout')
    },
    async disconnect() {
      await this.$hapticsImpact()
      await this.logout()

      if (this.$route.name !== 'bookshelf') {
        this.$router.replace('/bookshelf')
      } else {
        location.reload()
      }
    },
    touchstart(e) {
      this.touchEvent = new TouchEvent(e)
    },
    touchend(e) {
      if (!this.touchEvent) return
      this.touchEvent.setEndEvent(e)
      if (this.touchEvent.isSwipeRight()) {
        this.show = false
      }
      this.touchEvent = null
    },
    registerListener() {
      document.addEventListener('touchstart', this.touchstart)
      document.addEventListener('touchend', this.touchend)
    },
    removeListener() {
      document.removeEventListener('touchstart', this.touchstart)
      document.removeEventListener('touchend', this.touchend)
    }
  },
  mounted() {},
  beforeDestroy() {
    this.show = false
  }
}
</script>

<style scoped>
/* Material 3 Navigation Drawer Styles */
.state-layer {
  position: relative;
  overflow: hidden;
}

.state-layer::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: transparent;
  transition: background-color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
  pointer-events: none;
}

.state-layer:hover::before {
  background-color: rgba(var(--md-sys-color-on-surface), var(--md-sys-state-hover-opacity));
}

.state-layer:focus::before {
  background-color: rgba(var(--md-sys-color-on-surface), var(--md-sys-state-focus-opacity));
}

.state-layer:active::before {
  background-color: rgba(var(--md-sys-color-on-surface), var(--md-sys-state-pressed-opacity));
}

/* Active navigation item styling */
.bg-secondary-container .state-layer:hover::before {
  background-color: rgba(var(--md-sys-color-on-secondary-container), var(--md-sys-state-hover-opacity));
}

/* Custom opacity for scrim */
.bg-opacity-32 {
  background-opacity: 0.32;
}

/* Drawer width */
.w-80 {
  width: 20rem;
}

.translate-x-80 {
  transform: translateX(20rem);
}
</style>
