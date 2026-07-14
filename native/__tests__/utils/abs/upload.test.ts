/**
 * utils/abs/upload — the multipart POST /api/upload contract (field names +
 * numeric file keys are web-client-behavior pins, MEDIUM confidence — see the
 * module header) and the pure getUploadTarget host/token builder.
 */
jest.mock("../../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../../utils/api";
import { storageHelper } from "../../../utils/storage";
import { uploadMedia, getUploadTarget } from "../../../utils/abs/upload";
import { AbsError } from "../../../utils/abs/errors";

const ok = (data: any = {}) => ({ data });

/**
 * The jest env's FormData is the DOM polyfill: string fields round-trip via
 * entries(), but a { uri, name, type } file part is stringified to
 * "[object Object]" (on-device RN FormData keeps the object and streams it — not
 * observable here). So we assert the string fields exactly and the file parts
 * only by their numeric keys.
 */
function keysAndStrings(form: FormData): Record<string, any> {
  return Object.fromEntries((form as any).entries());
}

beforeEach(() => {
  jest.mocked(api.post).mockReset().mockResolvedValue(ok());
  storageHelper.clearServerConfig();
});

describe("uploadMedia", () => {
  it("POSTs multipart /api/upload with library/folder + numeric file keys and no 20s timeout", async () => {
    await uploadMedia({
      libraryId: "LIB",
      folderId: "FOL",
      title: "My Book",
      author: "Jane",
      series: "S1",
      files: [
        { uri: "file:///a.m4b", name: "a.m4b", type: "audio/mp4" },
        { uri: "file:///b.m4b", name: "b.m4b" },
      ],
    });
    const [url, body, config] = jest.mocked(api.post).mock.calls[0];
    expect(url).toBe("/api/upload");
    expect(body).toBeInstanceOf(FormData);
    // A large body must not inherit the shared 20s timeout.
    expect(config).toEqual({
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 0,
    });

    const byKey = keysAndStrings(body as FormData);
    expect(byKey.library).toBe("LIB");
    expect(byKey.folder).toBe("FOL");
    expect(byKey.title).toBe("My Book");
    expect(byKey.author).toBe("Jane");
    expect(byKey.series).toBe("S1");
    // Files appended under numeric string keys "0","1".
    expect("0" in byKey).toBe(true);
    expect("1" in byKey).toBe(true);
  });

  it("omits optional metadata fields when not provided", async () => {
    await uploadMedia({ libraryId: "LIB", folderId: "FOL", files: [{ uri: "file:///a.m4b", name: "a.m4b" }] });
    const byKey = keysAndStrings(jest.mocked(api.post).mock.calls[0][1] as FormData);
    expect("title" in byKey).toBe(false);
    expect("author" in byKey).toBe(false);
    expect("series" in byKey).toBe(false);
  });

  it("throws AbsError when the request never reaches the server (offline)", async () => {
    jest.mocked(api.post).mockRejectedValueOnce(new Error("Network Error")); // no response
    await expect(
      uploadMedia({ libraryId: "LIB", folderId: "FOL", files: [{ uri: "file:///a.m4b", name: "a.m4b" }] })
    ).rejects.toBeInstanceOf(AbsError);
  });
});

describe("getUploadTarget", () => {
  it("returns the /api/upload host + token for the Authorization header", () => {
    storageHelper.setServerConfig({ address: "https://abs.example.com/", token: "tok1" });
    expect(getUploadTarget()).toEqual({ url: "https://abs.example.com/api/upload", token: "tok1" });
  });

  it("returns null without a full session", () => {
    expect(getUploadTarget()).toBeNull();
    storageHelper.setServerConfig({ address: "https://abs.example.com" }); // no token
    expect(getUploadTarget()).toBeNull();
  });
});
