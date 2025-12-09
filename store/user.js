import { Browser } from '@capacitor/browser'
import { AbsLogger } from '@/plugins/capacitor'
import { CapacitorHttp } from '@capacitor/core'

// Refresh token verification interval (30 minutes)
// This interval is chosen to balance between detecting token loss early
// and not putting unnecessary load on the system
const TOKEN_VERIFICATION_INTERVAL_MS = 30 * 60 * 1000

export const state = () => ({
  user: null,
  accessToken: null,
  serverConnectionConfig: null,
  usedSsoForLogin: false, // Track if user logged in via SSO
  tokenVerificationIntervalId: null, // Store interval ID for cleanup
  settings: {
    mobileOrderBy: 'addedAt',
    mobileOrderDesc: true,
    mobileFilterBy: 'all',
    playbackRate: 1,
    collapseSeries: false,
    collapseBookSeries: false,
    enableDynamicColors: true
  }
})

export const getters = {
  getIsRoot: (state) => state.user && state.user.type === 'root',
  getIsAdminOrUp: (state) => state.user && (state.user.type === 'admin' || state.user.type === 'root'),
  getToken: (state) => {
    return state.accessToken || null
  },
  getServerConnectionConfigId: (state) => {
    return state.serverConnectionConfig?.id || null
  },
  getServerAddress: (state) => {
    return state.serverConnectionConfig?.address || null
  },
  getServerConfigName: (state) => {
    return state.serverConnectionConfig?.name || null
  },
  getUsedSsoForLogin: (state) => {
    return state.usedSsoForLogin
  },
  getUserMediaProgress:
    (state) =>
    (libraryItemId, episodeId = null) => {
      if (!state.user?.mediaProgress) return null
      return state.user.mediaProgress.find((li) => {
        if (episodeId && li.episodeId !== episodeId) return false
        return li.libraryItemId == libraryItemId
      })
    },
  getUserBookmarksForItem: (state) => (libraryItemId) => {
    if (!state?.user?.bookmarks) return []
    return state.user.bookmarks.filter((bm) => bm.libraryItemId === libraryItemId)
  },
  getUserSetting: (state) => (key) => {
    return state.settings?.[key] || null
  },
  getUserCanUpdate: (state) => {
    return !!state.user?.permissions?.update
  },
  getUserCanDelete: (state) => {
    return !!state.user?.permissions?.delete
  },
  getUserCanDownload: (state) => {
    return !!state.user?.permissions?.download
  },
  getUserCanAccessExplicitContent: (state) => {
    return !!state.user?.permissions?.accessExplicitContent
  }
}

export const actions = {
  // When changing libraries make sure sort and filter is still valid
  checkUpdateLibrarySortFilter({ state, dispatch, commit }, mediaType) {
    const settingsUpdate = {}
    if (mediaType == 'podcast') {
      if (state.settings.mobileOrderBy == 'media.metadata.authorName' || state.settings.mobileOrderBy == 'media.metadata.authorNameLF') {
        settingsUpdate.mobileOrderBy = 'media.metadata.author'
      }
      if (state.settings.mobileOrderBy == 'media.duration') {
        settingsUpdate.mobileOrderBy = 'media.numTracks'
      }
      if (state.settings.mobileOrderBy == 'media.metadata.publishedYear') {
        settingsUpdate.mobileOrderBy = 'media.metadata.title'
      }
      const invalidFilters = ['series', 'authors', 'narrators', 'languages', 'progress', 'issues']
      const filterByFirstPart = (state.settings.mobileFilterBy || '').split('.').shift()
      if (invalidFilters.includes(filterByFirstPart)) {
        settingsUpdate.mobileFilterBy = 'all'
      }
    } else {
      if (state.settings.mobileOrderBy == 'media.metadata.author') {
        settingsUpdate.mobileOrderBy = 'media.metadata.authorName'
      }
      if (state.settings.mobileOrderBy == 'media.numTracks') {
        settingsUpdate.mobileOrderBy = 'media.duration'
      }
    }
    if (Object.keys(settingsUpdate).length) {
      dispatch('updateUserSettings', settingsUpdate)
    }
  },
  async updateUserSettings({ state, commit }, payload) {
    if (!payload) return false

    let hasChanges = false
    const existingSettings = { ...state.settings }
    for (const key in existingSettings) {
      if (payload[key] !== undefined && existingSettings[key] !== payload[key]) {
        hasChanges = true
        existingSettings[key] = payload[key]
      }
    }
    if (hasChanges) {
      commit('setSettings', existingSettings)
      await this.$localStore.setUserSettings(existingSettings)
      this.$eventBus.$emit('user-settings', state.settings)
    }
  },
  async loadUserSettings({ state, commit }) {
    const userSettingsFromLocal = await this.$localStore.getUserSettings()

    if (userSettingsFromLocal) {
      const userSettings = { ...state.settings }
      for (const key in userSettings) {
        if (userSettingsFromLocal[key] !== undefined) {
          userSettings[key] = userSettingsFromLocal[key]
        }
      }
      commit('setSettings', userSettings)
      this.$eventBus.$emit('user-settings', state.settings)
    }
  },
  async openWebClient({ getters }, path = null) {
    const serverAddress = getters.getServerAddress
    if (!serverAddress) {
      console.error('openWebClient: No server address')
      return
    }
    try {
      let url = serverAddress.replace(/\/$/, '') // Remove trailing slash
      if (path?.startsWith('/')) url += path

      await Browser.open({ url })
    } catch (error) {
      console.error('Error opening browser', error)
    }
  },
  async logout({ state, commit }, logoutFromServer = false) {
    // Logging out from server deletes the session so the refresh token is no longer valid
    // Currently this is not being used to support switching servers without logging back in (assuming refresh token is still valid)
    // We may want to make this change in the future
    if (state.serverConnectionConfig && logoutFromServer) {
      const refreshToken = await this.$db.getRefreshToken(state.serverConnectionConfig.id)
      const options = {}
      if (refreshToken) {
        // Refresh token is used to delete the session on the server
        options.headers = {
          'x-refresh-token': refreshToken
        }
      }
      // Logout from server
      await this.$nativeHttp.post('/logout', null, options).catch((error) => {
        console.error('Failed to logout', error)
      })
    }

    await this.$db.logout()
    this.$socket.logout()
    this.$localStore.removeLastLibraryId()
    commit('logout')
    commit('libraries/setCurrentLibrary', null, { root: true })
    await AbsLogger.info({ tag: 'user', message: `Logged out from server ${state.serverConnectionConfig?.name || 'Not connected'}` })
  },
  async refreshToken({ getters, commit, state }) {
    const serverConnectionConfigId = getters.getServerConnectionConfigId
    const refreshToken = await this.$db.getRefreshToken(serverConnectionConfigId)
    if (!refreshToken) {
      console.error('[user] No refresh token found for server config:', serverConnectionConfigId)
      await AbsLogger.error({ tag: 'user', message: `No refresh token found for server ${state.serverConnectionConfig?.name || 'Unknown'}` })
      return null
    }

    const serverAddress = getters.getServerAddress
    if (!serverAddress) {
      console.error('[user] No server address available for token refresh')
      return null
    }

    try {
      const response = await CapacitorHttp.post({
        url: `${serverAddress}/auth/refresh`,
        headers: {
          'Content-Type': 'application/json',
          'x-refresh-token': refreshToken
        },
        data: {}
      })

      if (response.status !== 200) {
        console.error('[user] Token refresh request failed:', response.status)
        await AbsLogger.error({ tag: 'user', message: `Token refresh failed with status ${response.status} for server ${state.serverConnectionConfig?.name || 'Unknown'}` })
        return null
      }

      const userResponseData = response.data
      if (!userResponseData.user?.accessToken) {
        console.error('[user] No access token in refresh response')
        await AbsLogger.error({ tag: 'user', message: `No access token in refresh response for server ${state.serverConnectionConfig?.name || 'Unknown'}` })
        return null
      }

      // Update the config with new tokens
      const updatedConfig = {
        ...state.serverConnectionConfig,
        token: userResponseData.user.accessToken,
        // Some servers may not return a new refresh token in the response, so we preserve the existing one to maintain authentication.
        // This is safe because:
        // 1. The refresh token is only used for obtaining new access tokens
        // 2. If the refresh token is compromised, the server can invalidate it
        // 3. Preserving it prevents unnecessary re-authentication when the server doesn't rotate refresh tokens
        refreshToken: userResponseData.user.refreshToken || refreshToken
      }

      // Save updated config to secure storage, persists refresh token in secure storage
      const savedConfig = await this.$db.setServerConnectionConfig(updatedConfig)

      if (!savedConfig) {
        console.error('[user] Failed to save updated server connection config')
        await AbsLogger.error({ tag: 'user', message: `Failed to save updated tokens for server ${state.serverConnectionConfig?.name || 'Unknown'}` })
        return null
      }

      // Verify the refresh token was actually saved
      const verifyToken = await this.$db.getRefreshToken(serverConnectionConfigId)
      if (!verifyToken) {
        console.error('[user] Refresh token verification failed after save')
        await AbsLogger.error({ tag: 'user', message: `Refresh token verification failed after save for server ${state.serverConnectionConfig?.name || 'Unknown'}` })
      }

      // Update the store
      commit('setAccessToken', userResponseData.user.accessToken)

      // Re-authenticate socket if necessary
      if (this.$socket?.connected && !this.$socket.isAuthenticated) {
        this.$socket.sendAuthenticate()
      } else if (!this.$socket) {
        console.warn('[user] Socket not available, cannot re-authenticate')
      }

      commit('setServerConnectionConfig', savedConfig)

      await AbsLogger.info({ tag: 'user', message: `Successfully refreshed tokens for server ${state.serverConnectionConfig?.name || 'Unknown'}` })
      return userResponseData.user.accessToken
    } catch (error) {
      console.error('[user] Token refresh error:', error)
      await AbsLogger.error({ tag: 'user', message: `Token refresh error for server ${state.serverConnectionConfig?.name || 'Unknown'}: ${error.message || error}` })
      return null
    }
  },
  async verifyRefreshToken({ getters, state }) {
    // Verify that refresh token exists in secure storage
    const serverConnectionConfigId = getters.getServerConnectionConfigId
    if (!serverConnectionConfigId) {
      console.warn('[user] No server connection config ID to verify refresh token')
      return false
    }

    const refreshToken = await this.$db.getRefreshToken(serverConnectionConfigId)
    if (!refreshToken) {
      console.error('[user] Refresh token missing from secure storage for server:', serverConnectionConfigId)
      await AbsLogger.error({ tag: 'user', message: `Refresh token missing from secure storage for server ${state.serverConnectionConfig?.name || 'Unknown'}` })
      return false
    }

    console.log('[user] Refresh token verified successfully')
    return true
  },
  async startTokenVerification({ dispatch, state, commit }) {
    // Clear any existing interval first
    if (state.tokenVerificationIntervalId) {
      clearInterval(state.tokenVerificationIntervalId)
      commit('setTokenVerificationIntervalId', null)
    }

    const verifyPeriodically = async () => {
      if (!state.user || !state.serverConnectionConfig) {
        // User not logged in, skip verification
        return
      }

      const hasRefreshToken = await dispatch('verifyRefreshToken')
      if (!hasRefreshToken && state.user) {
        // Refresh token is missing, but user is still logged in
        // This shouldn't happen in normal circumstances
        console.error('[user] Refresh token missing during periodic verification')
        await AbsLogger.error({ tag: 'user', message: `Periodic verification detected missing refresh token for server ${state.serverConnectionConfig?.name || 'Unknown'}` })
        
        // We could potentially trigger a re-login flow here, but for now just log it
        // The next API call that requires refresh will trigger the re-login flow
      }
    }

    // Run immediately
    await verifyPeriodically()

    // Then run periodically
    if (typeof window !== 'undefined') {
      const intervalId = setInterval(verifyPeriodically, TOKEN_VERIFICATION_INTERVAL_MS)
      commit('setTokenVerificationIntervalId', intervalId)
    }
  }
}


export const mutations = {
  logout(state) {
    state.user = null
    state.accessToken = null
    state.serverConnectionConfig = null
    state.usedSsoForLogin = false
    // Clear token verification interval on logout
    if (state.tokenVerificationIntervalId) {
      clearInterval(state.tokenVerificationIntervalId)
      state.tokenVerificationIntervalId = null
    }
  },
  setUser(state, user) {
    state.user = user
  },
  setAccessToken(state, accessToken) {
    state.accessToken = accessToken
  },
  setUsedSsoForLogin(state, usedSso) {
    state.usedSsoForLogin = usedSso
  },
  setTokenVerificationIntervalId(state, intervalId) {
    state.tokenVerificationIntervalId = intervalId
  },
  removeMediaProgress(state, id) {
    if (!state.user) return
    state.user.mediaProgress = state.user.mediaProgress.filter((mp) => mp.id != id)
  },
  updateUserMediaProgress(state, data) {
    if (!data || !state.user) return
    const mediaProgressIndex = state.user.mediaProgress.findIndex((mp) => mp.id === data.id)
    if (mediaProgressIndex >= 0) {
      state.user.mediaProgress.splice(mediaProgressIndex, 1, data)
    } else {
      state.user.mediaProgress.push(data)
    }
  },
  setServerConnectionConfig(state, serverConnectionConfig) {
    state.serverConnectionConfig = serverConnectionConfig
  },
  setSettings(state, settings) {
    if (!settings) return
    state.settings = settings
  },
  updateBookmark(state, bookmark) {
    if (!state.user?.bookmarks) return
    state.user.bookmarks = state.user.bookmarks.map((bm) => {
      if (bm.libraryItemId === bookmark.libraryItemId && bm.time === bookmark.time) {
        return bookmark
      }
      return bm
    })
  },
  deleteBookmark(state, { libraryItemId, time }) {
    if (!state.user?.bookmarks) return
    state.user.bookmarks = state.user.bookmarks.filter((bm) => {
      if (bm.libraryItemId === libraryItemId && bm.time === time) return false
      return true
    })
  }
}
