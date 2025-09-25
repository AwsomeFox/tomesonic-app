import Vue from "vue"
import Toast from "vue-toastification"
import "vue-toastification/dist/index.css"
import { Capacitor } from '@capacitor/core'
import AbsToast from '~/plugins/capacitor/AbsToast'

const options = {
  hideProgressBar: true,
  position: 'bottom-center'
}

// Initialize vue-toastification
Vue.use(Toast, options)

// Custom toast wrapper that uses native toasts on Android
const toastWrapper = {
  success: async (message, options = {}) => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      await AbsToast.showSuccess({
        message,
        duration: options.timeout > 3000 ? 'long' : 'short'
      })
    } else {
      Vue.prototype.$toast.success(message, options)
    }
  },

  error: async (message, options = {}) => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      await AbsToast.showError({
        message,
        duration: options.timeout > 3000 ? 'long' : 'short'
      })
    } else {
      Vue.prototype.$toast.error(message, options)
    }
  },

  warning: async (message, options = {}) => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      await AbsToast.showWarning({
        message,
        duration: options.timeout > 3000 ? 'long' : 'short'
      })
    } else {
      Vue.prototype.$toast.warning(message, options)
    }
  },

  info: async (message, options = {}) => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      await AbsToast.showInfo({
        message,
        duration: options.timeout > 3000 ? 'long' : 'short'
      })
    } else {
      Vue.prototype.$toast.info(message, options)
    }
  },

  show: async (message, options = {}) => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      await AbsToast.show({
        message,
        duration: options.timeout > 3000 ? 'long' : 'short',
        position: 'bottom'
      })
    } else {
      Vue.prototype.$toast(message, options)
    }
  }
}

// Override the default $toast with our wrapper
Vue.prototype.$toast = toastWrapper