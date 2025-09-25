import { WebPlugin } from '@capacitor/core';

export class AbsToastWeb extends WebPlugin {
  async show(options) {
    console.log('AbsToast web fallback - show:', options.message);
    // Web fallback - do nothing, let vue-toastification handle it
    return Promise.resolve();
  }

  async showSuccess(options) {
    console.log('AbsToast web fallback - showSuccess:', options.message);
    // Web fallback - do nothing, let vue-toastification handle it
    return Promise.resolve();
  }

  async showError(options) {
    console.log('AbsToast web fallback - showError:', options.message);
    // Web fallback - do nothing, let vue-toastification handle it
    return Promise.resolve();
  }

  async showWarning(options) {
    console.log('AbsToast web fallback - showWarning:', options.message);
    // Web fallback - do nothing, let vue-toastification handle it
    return Promise.resolve();
  }

  async showInfo(options) {
    console.log('AbsToast web fallback - showInfo:', options.message);
    // Web fallback - do nothing, let vue-toastification handle it
    return Promise.resolve();
  }
}