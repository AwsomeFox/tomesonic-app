import axios from "axios";
import { storageHelper } from "./storage";
import { writeAutoCreds } from "./autoCreds";
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
    // user === null drives the navigator back to the Connect screen. Keep the
    // in-memory server config so the address field can prefill on re-login.
    useUserStore.getState().setUser(null);
  } catch (e) {
    // no-op
  }
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
      if (!serverConfig || !serverConfig.refreshToken) {
        isRefreshing = false;
        processQueue(new Error("No refresh token available"), null);
        // Session is unrecoverable (expired token, no refresh token) — force a
        // logout so the app returns to the Connect screen instead of hanging.
        forceLogout();
        return Promise.reject(error);
      }

      try {
        appLogger.info("Attempting token refresh...", "API");
        const response = await axios.post(
          `${serverConfig.address.replace(/\/$/, "")}/auth/refresh`,
          {},
          {
            headers: {
              "Content-Type": "application/json",
              "x-refresh-token": serverConfig.refreshToken,
            },
          }
        );

        if (response.status === 200 && response.data?.user?.accessToken) {
          const newToken = response.data.user.accessToken;
          const newRefreshToken = response.data.user.refreshToken || serverConfig.refreshToken;
          
          const updatedConfig = {
            ...serverConfig,
            token: newToken,
            refreshToken: newRefreshToken,
          };
          
          storageHelper.setServerConfig(updatedConfig);
          // Keep the Android Auto browse credentials in sync with the refreshed
          // access token, otherwise the car's native browse service keeps using
          // the now-expired token and every ABS fetch 401s (empty categories).
          writeAutoCreds(updatedConfig.address, newToken, undefined, newRefreshToken).catch(() => {});
          appLogger.info("Token refresh succeeded.", "API");
          
          isRefreshing = false;
          processQueue(null, newToken);
          
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return api(originalRequest);
        } else {
          throw new Error("Invalid token refresh response structure");
        }
      } catch (refreshError) {
        appLogger.error(`Token refresh failed: ${refreshError}`, "API");
        isRefreshing = false;
        processQueue(refreshError, null);

        // Log out user and return to Connect screen
        forceLogout();

        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);
