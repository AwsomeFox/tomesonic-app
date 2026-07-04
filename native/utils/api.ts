import axios from "axios";
import { storageHelper } from "./storage";
import { writeAutoCreds, readAutoCreds } from "./autoCreds";
import { appLogger } from "./logger";

export const api = axios.create({
  headers: {
    "Content-Type": "application/json",
  },
  // Fail fast when the server is unreachable (offline / asleep NAS) instead of
  // hanging a screen on a request that will never resolve.
  timeout: 20000,
});

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: any) => void;
}> = [];

// Clears the stored session and resets the user store so the navigator swaps
// back to the Connect screen. Uses a lazy require to avoid a circular import
// (useUserStore imports this module).
const forceLogout = () => {
  try {
    storageHelper.clearServerConfig();
    const { useUserStore } = require("../store/useUserStore");
    const prevConfig = useUserStore.getState().serverConnectionConfig;
    // user === null drives the navigator back to the Connect screen. Keep only
    // the non-secret fields of the in-memory server config so the address can
    // prefill on re-login — the (dead) tokens must not stay reachable in state.
    useUserStore.setState({
      user: null,
      serverConnectionConfig: prevConfig
        ? { address: prevConfig.address, username: prevConfig.username, name: prevConfig.name }
        : null,
    });
  } catch (e) {
    // no-op
  }
};

// Applies a refreshed token pair everywhere the app reads credentials from:
// 1. the secure store — the request interceptor reads it per-request;
// 2. the user store — every screen/component builds cover/stream `?token=`
//    URLs from serverConnectionConfig state, so without this ALL images and
//    any new track URLs keep 401ing with the stale token until app restart;
// 3. the Android Auto creds mirror — the native browse service reads it.
// Lazy require for the same circular-import reason as forceLogout.
const applyRefreshedConfig = (config: any) => {
  storageHelper.setServerConfig(config);
  try {
    const { useUserStore } = require("../store/useUserStore");
    useUserStore.setState({ serverConnectionConfig: config });
  } catch (e) {
    // no-op
  }
  writeAutoCreds(config.address, config.token, undefined, config.refreshToken).catch(() => {});
};

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else {
      resolve(token!);
    }
  });
  failedQueue = [];
};

// Request Interceptor to dynamically set baseURL and inject Authorization token
api.interceptors.request.use(
  async (config) => {
    const configData = storageHelper.getServerConfig();
    
    // Set dynamically
    if (configData?.address) {
      config.baseURL = configData.address.replace(/\/$/, "");
    }
    
    if (configData?.token) {
      config.headers.Authorization = `Bearer ${configData.token}`;
    }
    
    appLogger.info(`Request ${config.method?.toUpperCase()} ${config.url}`, "API");
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response Interceptor to handle Token Refreshing on 401
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const status = error.response ? error.response.status : null;

    if (status === 401 && !originalRequest._retry) {
      // Avoid infinite loop on auth endpoints
      if (
        originalRequest.url?.endsWith("/auth/refresh") ||
        originalRequest.url?.endsWith("/login")
      ) {
        return Promise.reject(error);
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return api(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const serverConfig = storageHelper.getServerConfig();
      if (!serverConfig?.address) {
        isRefreshing = false;
        processQueue(new Error("No server configured"), null);
        forceLogout();
        return Promise.reject(error);
      }

      // The native Android Auto service refreshes the token itself while JS is
      // backgrounded, and ABS ROTATES refresh tokens on every /auth/refresh
      // (the previous one only survives a ~60s grace window) — so after a
      // drive, auto_creds.json can hold the ONLY valid refresh token. Both
      // sides write that file on refresh, so it is always at least as new as
      // the secure store: try its refresh token first, then fall back to the
      // stored one (covers a failed/partial file write).
      const host = serverConfig.address.replace(/\/$/, "");
      const fileCreds = await readAutoCreds();
      const refreshCandidates: string[] = [];
      if (fileCreds && fileCreds.server === host && fileCreds.refreshToken) {
        refreshCandidates.push(fileCreds.refreshToken);
      }
      if (serverConfig.refreshToken && !refreshCandidates.includes(serverConfig.refreshToken)) {
        refreshCandidates.push(serverConfig.refreshToken);
      }

      if (!refreshCandidates.length) {
        isRefreshing = false;
        processQueue(new Error("No refresh token available"), null);
        // Session is unrecoverable (expired token, no refresh token) — force a
        // logout so the app returns to the Connect screen instead of hanging.
        forceLogout();
        return Promise.reject(error);
      }

      try {
        appLogger.info("Attempting token refresh...", "API");
        let response: any = null;
        let lastRefreshError: any = null;
        for (const refreshToken of refreshCandidates) {
          try {
            response = await axios.post(
              `${host}/auth/refresh`,
              {},
              {
                headers: {
                  "Content-Type": "application/json",
                  "x-refresh-token": refreshToken,
                },
                // This is a raw axios call, so the `api` instance's timeout
                // doesn't apply. Without one, a hung server would leave
                // isRefreshing stuck true and every later 401 queueing forever.
                timeout: 20000,
              }
            );
            break;
          } catch (err) {
            lastRefreshError = err;
            response = null;
          }
        }
        if (!response) {
          throw lastRefreshError || new Error("Token refresh failed");
        }

        if (response.status === 200 && response.data?.user?.accessToken) {
          const newToken = response.data.user.accessToken;
          const newRefreshToken = response.data.user.refreshToken || serverConfig.refreshToken;

          const updatedConfig = {
            ...serverConfig,
            token: newToken,
            refreshToken: newRefreshToken,
          };

          // Persist + push into the user store (cover/stream URL builders) +
          // mirror to the Android Auto creds file, otherwise the car's native
          // browse service keeps using the now-expired token and every ABS
          // fetch 401s (empty categories).
          applyRefreshedConfig(updatedConfig);
          appLogger.info("Token refresh succeeded.", "API");

          isRefreshing = false;
          processQueue(null, newToken);

          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return api(originalRequest);
        } else {
          throw new Error("Invalid token refresh response structure");
        }
      } catch (refreshError: any) {
        appLogger.error(`Token refresh failed: ${refreshError}`, "API");
        isRefreshing = false;
        processQueue(refreshError, null);

        // Only a DEFINITIVE auth rejection (401/403 from /auth/refresh) means
        // the session is dead. A network error / timeout / 5xx just means the
        // server is unreachable right now — logging out would strand the user
        // (and break offline download retries) over a blip; the next 401
        // simply retries the refresh.
        const refreshStatus = refreshError?.response?.status;
        if (refreshStatus === 401 || refreshStatus === 403) {
          forceLogout();
        }

        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);
