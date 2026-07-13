/**
 * utils/abs/me — exact method+path+payload triples (verified against the
 * ABS v2.35.1 ApiRouter/MeController/PlaylistController), the verified
 * continue-listening hide mechanism, the e-reader-device store refresh, and
 * the throw-AbsError contract.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));

import { api } from "../../../utils/api";
import { useUserStore } from "../../../store/useUserStore";
import {
  hideFromContinueListening,
  batchUpdateProgress,
  getMyItemListeningSessions,
  createPlaylistFromCollection,
  updateMyEreaderDevices,
} from "../../../utils/abs/me";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });
const initialState = useUserStore.getState();

beforeEach(() => {
  jest.mocked(api.get).mockReset().mockResolvedValue(ok());
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
  jest.mocked(api.patch).mockReset().mockResolvedValue(ok());
  useUserStore.setState(initialState, true);
});

it("hideFromContinueListening → the VERIFIED GET remove-from-continue-listening route, keyed by PROGRESS id", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ id: "u1", mediaProgress: [] }));
  await expect(hideFromContinueListening("prog-123")).resolves.toEqual({
    id: "u1",
    mediaProgress: [],
  });
  expect(api.get).toHaveBeenCalledWith(
    "/api/me/progress/prog-123/remove-from-continue-listening"
  );
  // NOT a PATCH of hideFromContinueListening onto the progress row.
  expect(api.patch).not.toHaveBeenCalled();
});

it("batchUpdateProgress → PATCH /api/me/progress/batch/update with a BARE ARRAY body", async () => {
  const payloads = [
    { libraryItemId: "li1", isFinished: true },
    { libraryItemId: "li2", episodeId: "ep1", currentTime: 42 },
  ];
  await batchUpdateProgress(payloads);
  expect(api.patch).toHaveBeenCalledWith("/api/me/progress/batch/update", payloads);
});

it("getMyItemListeningSessions → GET /api/me/item/listening-sessions/:libraryItemId (episode variant appends /:episodeId)", async () => {
  jest.mocked(api.get).mockResolvedValue(ok({ sessions: [] }));
  await getMyItemListeningSessions("li1");
  expect(api.get).toHaveBeenCalledWith("/api/me/item/listening-sessions/li1");

  await getMyItemListeningSessions("li1", "ep2");
  expect(api.get).toHaveBeenCalledWith("/api/me/item/listening-sessions/li1/ep2");
});

it("createPlaylistFromCollection → POST /api/playlists/collection/:collectionId", async () => {
  jest.mocked(api.post).mockResolvedValue(ok({ id: "pl1", name: "From Collection" }));
  await expect(createPlaylistFromCollection("col1")).resolves.toEqual({
    id: "pl1",
    name: "From Collection",
  });
  expect(api.post).toHaveBeenCalledWith("/api/playlists/collection/col1");
});

describe("updateMyEreaderDevices", () => {
  const myDevice = {
    name: "My Kindle",
    email: "me@kindle.com",
    availabilityOption: "specificUsers" as const,
    users: ["u1"],
  };

  it("POSTs /api/me/ereader-devices then refreshes the store via /api/authorize", async () => {
    useUserStore.setState({ serverConnectionConfig: { token: "tok" }, ereaderDevices: [] });
    jest.mocked(api.post).mockImplementation(((url: string) => {
      if (url === "/api/me/ereader-devices") return Promise.resolve(ok({ ereaderDevices: [myDevice] }));
      if (url === "/api/authorize") return Promise.resolve(ok({ ereaderDevices: [myDevice] }));
      return Promise.reject(new Error(`unexpected POST ${url}`));
    }) as any);

    await updateMyEreaderDevices([myDevice]);

    expect(api.post).toHaveBeenCalledWith("/api/me/ereader-devices", {
      ereaderDevices: [myDevice],
    });
    // The store refresh goes through loadEReaderDevices' source of truth.
    expect(api.post).toHaveBeenCalledWith("/api/authorize");
    expect(useUserStore.getState().ereaderDevices).toEqual([myDevice]);
  });

  it("still resolves when the follow-up refresh fails (the update itself landed)", async () => {
    useUserStore.setState({ serverConnectionConfig: { token: "tok" } });
    jest.mocked(api.post).mockImplementation(((url: string) => {
      if (url === "/api/me/ereader-devices") return Promise.resolve(ok({}));
      return Promise.reject(new Error("offline"));
    }) as any);
    await expect(updateMyEreaderDevices([myDevice])).resolves.toBeUndefined();
  });

  it("throws AbsError when the update itself is rejected (and does NOT refresh)", async () => {
    jest.mocked(api.post).mockRejectedValue({
      response: { status: 400, data: "Invalid payload. ereaderDevices array required" },
    });
    const err = await updateMyEreaderDevices([myDevice]).catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.message).toBe("Invalid payload. ereaderDevices array required");
    expect(api.post).toHaveBeenCalledTimes(1); // no /api/authorize follow-up
  });
});

describe("error normalization", () => {
  it("offline → offline AbsError", async () => {
    jest.mocked(api.patch).mockRejectedValue(new Error("Network Error"));
    await expect(batchUpdateProgress([{ libraryItemId: "x" }])).rejects.toMatchObject({
      kind: "offline",
    });
  });

  it("missing progress row (404) → unsupported kind by default", async () => {
    jest.mocked(api.get).mockRejectedValue({ response: { status: 404 } });
    await expect(hideFromContinueListening("nope")).rejects.toMatchObject({
      kind: "unsupported",
    });
  });
});
