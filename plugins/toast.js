import Vue from 'vue'
import Toast from 'vue-toastification'
import 'vue-toastification/dist/index.css'
import { Capacitor } from '@capacitor/core'
import { AbsLogger } from '~/plugins/capacitor'

// Dynamically import AbsToast to handle cases where it might not be available
let AbsToast = null
try {
  AbsToast = require('~/plugins/capacitor/AbsToast').default
} catch (error) {
  // Only log in development mode to avoid production console noise
  if (process.env.NODE_ENV === 'development') {
    AbsLogger.info({ tag: 'Toast', message: `AbsToast plugin not available: ${error.message}` })
  }
}

const options = {
  hideProgressBar: true,
  position: 'bottom-center'
}

// Initialize vue-toastification
Vue.use(Toast, options)

// Store reference to original toast instance to avoid circular dependency
const originalToast = Vue.prototype.$toast

// Helper function to convert vue-toastification timeout to native duration
const getDurationFromTimeout = (timeout) => {
  // Check if timeout exists and is a number before comparison
  if (timeout && typeof timeout === 'number' && timeout > 3000) {
    return 'long'
  }
  return 'short'
}

// Helper function to convert vue-toastification position to native position
const getPositionFromOptions = (options) => {
  const position = options?.position || 'bottom-center'
  if (position.includes('top')) return 'top'
  if (position.includes('center') && !position.includes('bottom')) return 'center'
  return 'bottom'
}

// Helper function to check if we should use native Android toasts
const shouldUseNativeToast = () => {
  return AbsToast && Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

// Unified helper function to handle native toast execution with fallback
const executeToast = async (nativeToastFn, fallbackToastFn, message, options = {}) => {
  if (shouldUseNativeToast() && nativeToastFn) {
    try {
      await nativeToastFn({
        message: String(message),
        duration: getDurationFromTimeout(options.timeout),
        ...(options.position && { position: getPositionFromOptions(options) })
      })
    } catch (error) {
      // Log error using proper logging system instead of console
      AbsLogger.error({ tag: 'Toast', message: `Failed to show native toast: ${error.message}` })
      fallbackToastFn(message, options)
    }
  } else {
    fallbackToastFn(message, options)
  }
}

// Custom toast wrapper that uses native toasts on Android
const toastWrapper = {
  success: async (message, options = {}) => {
    await executeToast(AbsToast?.showSuccess, originalToast.success.bind(originalToast), message, options)
  },

  error: async (message, options = {}) => {
    await executeToast(AbsToast?.showError, originalToast.error.bind(originalToast), message, options)
  },

  warning: async (message, options = {}) => {
    await executeToast(AbsToast?.showWarning, originalToast.warning.bind(originalToast), message, options)
  },

  info: async (message, options = {}) => {
    await executeToast(AbsToast?.showInfo, originalToast.info.bind(originalToast), message, options)
  },

  show: async (message, options = {}) => {
    await executeToast(AbsToast?.show, originalToast.bind(originalToast), message, { ...options, position: options.position || 'bottom' })
  },

  // Preserve other toast methods that might be used
  clear: originalToast.clear?.bind(originalToast),
  dismiss: originalToast.dismiss?.bind(originalToast)
}

// Override the default $toast with our wrapper
Vue.prototype.$toast = toastWrapper
