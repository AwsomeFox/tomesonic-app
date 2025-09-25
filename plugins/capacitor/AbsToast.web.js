import { WebPlugin } from '@capacitor/core'
import { AbsLogger } from './AbsLogger'

export class AbsToastWeb extends WebPlugin {
  constructor() {
    super()
    // Get access to the original toast instance when available
    this.originalToast = null

    // Set up the toast reference when Vue is available
    if (typeof window !== 'undefined' && window.Vue) {
      this.originalToast = window.Vue.prototype.$toast
    }
  }

  _getToastInstance() {
    // Try to get the toast instance from Vue prototype
    if (!this.originalToast && typeof window !== 'undefined' && window.Vue) {
      this.originalToast = window.Vue.prototype.$toast
    }
    return this.originalToast
  }

  async show(options) {
    const toast = this._getToastInstance()
    if (toast && typeof toast === 'function') {
      const toastOptions = {
        timeout: options.duration === 'long' ? 5000 : 3000,
        position: options.position === 'top' ? 'top-center' : 'bottom-center'
      }
      toast(options.message, toastOptions)
    } else {
      // Silently fail - toast instance not available, likely in a test environment
      // Only log in development to avoid production noise
      if (process.env.NODE_ENV === 'development') {
        AbsLogger.info({ tag: 'AbsToast', message: `Web fallback - show: ${options.message}` })
      }
    }
    return Promise.resolve()
  }

  async showSuccess(options) {
    const toast = this._getToastInstance()
    if (toast && toast.success) {
      const toastOptions = {
        timeout: options.duration === 'long' ? 5000 : 3000
      }
      toast.success(options.message, toastOptions)
    } else {
      // Silently fail - toast instance not available, likely in a test environment
      if (process.env.NODE_ENV === 'development') {
        AbsLogger.info({ tag: 'AbsToast', message: `Web fallback - showSuccess: ${options.message}` })
      }
    }
    return Promise.resolve()
  }

  async showError(options) {
    const toast = this._getToastInstance()
    if (toast && toast.error) {
      const toastOptions = {
        timeout: options.duration === 'long' ? 5000 : 3000
      }
      toast.error(options.message, toastOptions)
    } else {
      // Silently fail - toast instance not available, likely in a test environment
      if (process.env.NODE_ENV === 'development') {
        AbsLogger.info({ tag: 'AbsToast', message: `Web fallback - showError: ${options.message}` })
      }
    }
    return Promise.resolve()
  }

  async showWarning(options) {
    const toast = this._getToastInstance()
    if (toast && toast.warning) {
      const toastOptions = {
        timeout: options.duration === 'long' ? 5000 : 3000
      }
      toast.warning(options.message, toastOptions)
    } else {
      // Silently fail - toast instance not available, likely in a test environment
      if (process.env.NODE_ENV === 'development') {
        AbsLogger.info({ tag: 'AbsToast', message: `Web fallback - showWarning: ${options.message}` })
      }
    }
    return Promise.resolve()
  }

  async showInfo(options) {
    const toast = this._getToastInstance()
    if (toast && toast.info) {
      const toastOptions = {
        timeout: options.duration === 'long' ? 5000 : 3000
      }
      toast.info(options.message, toastOptions)
    } else {
      // Silently fail - toast instance not available, likely in a test environment
      if (process.env.NODE_ENV === 'development') {
        AbsLogger.info({ tag: 'AbsToast', message: `Web fallback - showInfo: ${options.message}` })
      }
    }
    return Promise.resolve()
  }
}
