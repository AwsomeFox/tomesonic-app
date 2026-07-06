import { create } from "zustand";
import {
  exchangeLoginToken,
  readRmabConfig,
  writeRmabConfig,
  getMe,
  createRequest,
  RmabBook,
} from "../utils/rmab";

/**
 * ReadMeABook connection state. `configured` gates EVERY RMAB feature in the
 * UI — nothing request-related renders unless the user has connected a server
 * in Settings.
 */
interface RmabState {
  configured: boolean;
  serverUrl: string | null;
  username: string | null;
  connecting: boolean;
  connectError: string | null;
  // asin -> local request status ("pending" right after a request here, or
  // whatever the server reported). Lets every screen flip its button to
  // "Requested" without refetching.
  requestedAsins: Record<string, string>;

  initialize: () => void;
  connect: (url: string, loginToken: string) => Promise<boolean>;
  disconnect: () => void;
  requestBook: (book: RmabBook) => Promise<{ ok: boolean; message?: string }>;
  noteRequestStatus: (asin: string, status: string) => void;
}

export const useRmabStore = create<RmabState>((set, get) => ({
  configured: false,
  serverUrl: null,
  username: null,
  connecting: false,
  connectError: null,
  requestedAsins: {},

  initialize: () => {
    const cfg = readRmabConfig();
    if (cfg) {
      set({
        configured: true,
        serverUrl: cfg.url,
        username: cfg.user?.username || null,
      });
    }
  },

  connect: async (url, loginToken) => {
    set({ connecting: true, connectError: null });
    try {
      const cfg = await exchangeLoginToken(url, loginToken);
      writeRmabConfig(cfg);
      // Round-trip an authed call so a pasted token that exchanged but can't
      // authenticate (clock skew, revoked session) fails HERE, not later.
      await getMe();
      set({
        configured: true,
        serverUrl: cfg.url,
        username: cfg.user?.username || null,
        connecting: false,
      });
      return true;
    } catch (e: any) {
      writeRmabConfig(null);
      const status = e?.response?.status;
      set({
        connecting: false,
        configured: false,
        connectError:
          status === 401 || status === 400
            ? "Invalid login token"
            : "Could not reach the server",
      });
      return false;
    }
  },

  disconnect: () => {
    writeRmabConfig(null);
    set({
      configured: false,
      serverUrl: null,
      username: null,
      connectError: null,
      requestedAsins: {},
    });
  },

  requestBook: async (book) => {
    try {
      await createRequest(book);
      get().noteRequestStatus(book.asin, "pending");
      return { ok: true };
    } catch (e: any) {
      const err = e?.response?.data?.error;
      // 409s carry a meaningful state: the book exists / is already requested.
      if (err === "AlreadyAvailable") return { ok: false, message: "Already in the library" };
      if (err === "DuplicateRequest" || err === "BeingProcessed") {
        get().noteRequestStatus(book.asin, "pending");
        return { ok: false, message: "Already requested" };
      }
      return { ok: false, message: "Request failed" };
    }
  },

  noteRequestStatus: (asin, status) =>
    set({ requestedAsins: { ...get().requestedAsins, [asin]: status } }),
}));
