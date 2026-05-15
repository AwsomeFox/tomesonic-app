<template>
  <modals-modal v-model="show" width="90%" height="100%">
    <div class="w-full h-full overflow-hidden absolute top-0 left-0 flex items-center justify-center" data-modal-backdrop>
      <div ref="container" class="w-full overflow-x-hidden overflow-y-auto bg-surface-container-high rounded-3xl border border-outline-variant border-opacity-40 shadow-elevation-4 mt-8" style="max-height: 75%">
        <!-- Material 3 Modal Header -->
        <div class="px-6 pt-5 pb-3">
          <div class="w-full flex items-center">
            <span class="material-symbols text-on-surface mr-3" style="font-size: 24px">cast</span>
            <h2 class="text-headline-small text-on-surface font-medium flex-grow">{{ $strings.HeaderCastDevices }}</h2>
            <ui-icon-btn icon="close" size="md" variant="standard" @click="show = false" />
          </div>
        </div>

        <div class="w-full max-h-96 overflow-y-auto px-4 pb-4">
          <!-- Loading state -->
          <div v-if="loading" class="flex items-center justify-center py-10">
            <ui-loading-indicator />
            <span class="ml-3 text-on-surface-variant">{{ $strings.MessageDiscoveringCastDevices }}</span>
          </div>

          <!-- No devices found -->
          <div v-else-if="!castDevices.length" class="text-center py-10 px-4">
            <span class="material-symbols text-on-surface-variant" style="font-size: 56px">cast</span>
            <p class="text-body-large text-on-surface mt-4 mb-1">{{ $strings.MessageNoCastDevicesFound }}</p>
            <p class="text-body-small text-on-surface-variant mb-5">{{ $strings.MessageEnsureCastDevicesOnNetwork }}</p>
            <ui-btn size="sm" color="primary" @click="refreshDevices">
              <ui-icon icon="refresh" class="mr-1" />
              {{ $strings.ButtonRefresh }}
            </ui-btn>
          </div>

          <!-- Device list -->
          <ul v-else class="flex flex-col gap-2 mt-1">
            <li
              v-for="device in sortedCastDevices"
              :key="device.id"
              class="cast-device-row state-layer flex items-center rounded-2xl px-4 py-3 transition-colors"
              :class="{
                'cast-device-row--connected': device.isConnected,
                'cursor-pointer': !device.isConnected
              }"
              @click="!device.isConnected && connectToDevice(device)"
            >
              <span class="material-symbols mr-4" :class="device.isConnected ? 'text-on-primary-container' : 'text-on-surface-variant'" style="font-size: 24px">{{ device.isConnected ? 'cast_connected' : 'cast' }}</span>
              <div class="flex-1 min-w-0">
                <p class="text-body-large font-medium truncate" :class="device.isConnected ? 'text-on-primary-container' : 'text-on-surface'">{{ device.name }}</p>
                <p v-if="device.description" class="text-body-small truncate" :class="device.isConnected ? 'text-on-primary-container' : 'text-on-surface-variant'">{{ device.description }}</p>
                <p v-if="device.isConnected" class="text-label-small font-medium text-on-primary-container">{{ $strings.LabelConnected }}</p>
              </div>

              <!-- Disconnect button for connected devices -->
              <div v-if="device.isConnected" class="ml-3 flex-shrink-0">
                <ui-btn size="sm" color="error" variant="outlined" @click.stop="disconnectFromDevice(device)" :loading="connectingDeviceId === device.id">
                  {{ $strings.ButtonDisconnect }}
                </ui-btn>
              </div>
            </li>
          </ul>
        </div>

        <!-- Footer: refresh only (close lives in the header) -->
        <div v-if="castDevices.length > 0" class="px-6 py-3 flex items-center justify-end">
          <ui-btn size="sm" variant="text" @click="refreshDevices" :loading="loading">
            <ui-icon icon="refresh" class="mr-1" />
            {{ $strings.ButtonRefresh }}
          </ui-btn>
        </div>
      </div>
    </div>
  </modals-modal>
</template>

<script>
export default {
  name: 'CastDeviceSelectionModal',
  data() {
    return {
      show: false,
      loading: false,
      castDevices: [],
      connectingDeviceId: null
    }
  },
  computed: {
    sortedCastDevices() {
      // Sort devices so connected devices appear first
      return [...this.castDevices].sort((a, b) => {
        // Connected devices first
        if (a.isConnected && !b.isConnected) return -1
        if (!a.isConnected && b.isConnected) return 1
        // Then sort by name alphabetically
        return a.name.localeCompare(b.name)
      })
    }
  },
  methods: {
    init() {
      this.show = true
      this.refreshDevices()
    },
    async refreshDevices() {
      this.loading = true
      try {
        // First trigger active device discovery
        await this.$nativeHttp.refreshCastDevices()

        // Wait a moment for discovery to find devices
        await new Promise((resolve) => setTimeout(resolve, 1000))

        // Then get the updated device list
        const response = await this.$nativeHttp.getCastDevices()
        if (response?.devices) {
          this.castDevices = response.devices
        } else {
          this.castDevices = []
        }
      } catch (error) {
        console.error('Failed to refresh cast devices:', error)
        this.$toast.error(this.$strings.ToastCastDeviceDiscoveryFailed)
        this.castDevices = []
      }
      this.loading = false
    },
    async connectToDevice(device) {
      if (device.isConnected) {
        // Don't attempt to reconnect to already connected device when clicking the main area
        return
      }

      this.connectingDeviceId = device.id
      try {
        await this.$nativeHttp.connectToCastDevice(device.id)
        this.$toast.success(this.$strings.ToastCastDeviceConnected.replace('{0}', device.name))

        // Emit connection event to parent components first
        this.$emit('cast-device-connected', device)

        // Brief delay to prevent modal flashing, then close
        setTimeout(() => {
          this.show = false
        }, 500)
      } catch (error) {
        console.error('Failed to connect to cast device:', error)
        this.$toast.error(this.$strings.ToastCastDeviceConnectionFailed.replace('{0}', device.name))
      }
      this.connectingDeviceId = null
    },
    async disconnectFromDevice(device) {
      try {
        await this.$nativeHttp.disconnectFromCastDevice()
        this.$toast.success(this.$strings.ToastCastDeviceDisconnected.replace('{0}', device.name))

        // Emit disconnection event to parent components
        this.$emit('cast-device-disconnected', device)

        // Refresh device list to update connection states after disconnect
        await this.refreshDevices()
      } catch (error) {
        console.error('Failed to disconnect from cast device:', error)
        this.$toast.error(this.$strings.ToastCastDeviceDisconnectionFailed.replace('{0}', device.name))
      }
    }
  }
}
</script>

<style scoped>
.cast-device-row {
  background: rgb(var(--md-sys-color-surface-container-highest));
  border: 1px solid rgba(var(--md-sys-color-outline-variant), 0.4);
}
.cast-device-row--connected {
  background: rgb(var(--md-sys-color-primary-container));
  border-color: rgba(var(--md-sys-color-primary), 0.6);
}
</style>
