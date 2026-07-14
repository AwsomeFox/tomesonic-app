/**
 * utils/mediaUploader — the streaming XHR media uploader (issue #57).
 *
 * Drives a LOCAL fake XMLHttpRequest (installed on global for this suite only,
 * restored in afterEach) so progress/success/network-error/abort can be fired
 * deterministically. The notifee helper is mocked so we can assert its
 * start/progress/complete/clear lifecycle, and the server target comes from the
 * real storageHelper (in-memory MMKV) via getUploadTarget().
 */
import { storageHelper, secureStorage } from "../../utils/storage";
import { downloadNotifications } from "../../utils/downloadNotifications";
import { uploadMediaFiles, MediaUploadParams } from "../../utils/mediaUploader";

jest.mock("../../utils/downloadNotifications", () => ({
  downloadNotifications: {
    start: jest.fn(),
    progress: jest.fn(),
    complete: jest.fn(),
    clear: jest.fn(),
  },
}));

const notifications = jest.mocked(downloadNotifications);

// Minimal, test-driveable fake XHR: records what the uploader did (method/url/
// headers/body/abort) and lets the test fire success/network-error/progress.
class FakeXHR {
  static instances: FakeXHR[] = [];
  static latest(): FakeXHR {
    return FakeXHR.instances[FakeXHR.instances.length - 1];
  }

  upload: { onprogress: ((e: any) => void) | null } = { onprogress: null };
  status = 0;
  responseText = "";
  timeout = 0;
  method?: string;
  url?: string;
  headers: Record<string, string> = {};
  body: any = null;
  sent = false;
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send(body: any) {
    this.body = body;
    this.sent = true;
  }
  abort() {
    this.aborted = true;
  }

  // --- test drivers ---
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total });
  }
  succeed(status: number, responseText: string) {
    this.status = status;
    this.responseText = responseText;
    this.onload?.();
  }
  networkFail() {
    this.onerror?.();
  }
}

const SERVER = "http://abs.local";
const TOKEN = "tok1";

const params = (): MediaUploadParams => ({
  libraryId: "LIB",
  folderId: "FOL",
  title: "My Book",
  author: "Jane",
  files: [{ uri: "file:///a.m4b", name: "a.m4b", type: "audio/mp4" }],
});

let originalXHR: any;

beforeEach(() => {
  secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
  storageHelper.setServerConfig({ address: SERVER, token: TOKEN });

  originalXHR = (global as any).XMLHttpRequest;
  FakeXHR.instances = [];
  (global as any).XMLHttpRequest = FakeXHR as any;
});

afterEach(() => {
  (global as any).XMLHttpRequest = originalXHR;
  jest.useRealTimers();
});

describe("uploadMediaFiles — request shape", () => {
  it("POSTs to the upload target with a Bearer header and no Content-Type", async () => {
    const handle = uploadMediaFiles(params());
    const xhr = FakeXHR.latest();
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("http://abs.local/api/upload");
    expect(xhr.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // The multipart boundary is set by RN on the body — never a manual header.
    expect("Content-Type" in xhr.headers).toBe(false);
    expect(xhr.timeout).toBe(0);
    expect(xhr.sent).toBe(true);

    xhr.succeed(200, "{}");
    await handle.promise;
  });
});

describe("uploadMediaFiles — progress + success", () => {
  it("fires onProgress + notifee progress as a fraction, then resolves parsed JSON and completes the notification", async () => {
    const onProgress = jest.fn();
    const handle = uploadMediaFiles(params(), {
      onProgress,
      notifyId: "up1",
      notifyTitle: "My Upload",
    });
    expect(notifications.start).toHaveBeenCalledWith("up1", "My Upload");

    FakeXHR.latest().emitProgress(50, 100);
    expect(onProgress).toHaveBeenCalledWith(50, 100);
    expect(notifications.progress).toHaveBeenCalledWith("up1", "My Upload", 0.5);

    FakeXHR.latest().succeed(200, JSON.stringify({ libraryItemId: "new1" }));
    await expect(handle.promise).resolves.toEqual({ libraryItemId: "new1" });

    expect(notifications.complete).toHaveBeenCalledWith("up1", "My Upload");
    expect(notifications.clear).not.toHaveBeenCalled();
  });

  it("resolves {} when a 2xx body isn't valid JSON (parse guard)", async () => {
    const handle = uploadMediaFiles(params());
    FakeXHR.latest().succeed(201, "not-json");
    await expect(handle.promise).resolves.toEqual({});
  });
});

describe("uploadMediaFiles — server rejections (non-2xx, never retried)", () => {
  it("maps a 401 to a friendly message and clears the notification", async () => {
    const handle = uploadMediaFiles(params(), { notifyId: "up1", notifyTitle: "T" });
    FakeXHR.latest().succeed(401, "");
    await expect(handle.promise).rejects.toThrow(/session has expired/i);
    expect(notifications.clear).toHaveBeenCalledWith("up1");
    expect(notifications.complete).not.toHaveBeenCalled();
  });

  it("maps a 413 to a too-large message", async () => {
    const handle = uploadMediaFiles(params());
    FakeXHR.latest().succeed(413, "");
    await expect(handle.promise).rejects.toThrow(/too large/i);
  });

  it("does NOT retry on a non-2xx status (a real server rejection)", async () => {
    const handle = uploadMediaFiles(params());
    FakeXHR.latest().succeed(500, "");
    await expect(handle.promise).rejects.toThrow(/server had a problem/i);
    // Only the single original attempt — no retry XHR was created.
    expect(FakeXHR.instances.length).toBe(1);
  });
});

describe("uploadMediaFiles — no session", () => {
  it("rejects immediately when getUploadTarget() is null and never opens a request", async () => {
    storageHelper.clearServerConfig();
    const handle = uploadMediaFiles(params());
    await expect(handle.promise).rejects.toThrow("Not signed in to a server.");
    expect(FakeXHR.instances.length).toBe(0);
    expect(notifications.start).not.toHaveBeenCalled();
  });
});

describe("uploadMediaFiles — network-error retry (exactly once)", () => {
  it("re-sends the whole request once after a short delay, then succeeds", async () => {
    jest.useFakeTimers();
    const handle = uploadMediaFiles(params());

    FakeXHR.latest().networkFail(); // first attempt drops
    expect(FakeXHR.instances.length).toBe(1); // retry is scheduled, not yet sent

    jest.advanceTimersByTime(1500);
    expect(FakeXHR.instances.length).toBe(2); // whole request re-issued

    FakeXHR.latest().succeed(200, JSON.stringify({ ok: true }));
    await expect(handle.promise).resolves.toEqual({ ok: true });
  });

  it("rejects after a SECOND network failure and never makes a third attempt", async () => {
    jest.useFakeTimers();
    const handle = uploadMediaFiles(params(), { notifyId: "up1", notifyTitle: "T" });
    const rejection = expect(handle.promise).rejects.toThrow(/network connection was lost/i);

    FakeXHR.latest().networkFail(); // first drop -> schedule retry
    jest.advanceTimersByTime(1500);
    expect(FakeXHR.instances.length).toBe(2);

    FakeXHR.latest().networkFail(); // retry also drops -> fatal
    await rejection;

    // No further retry is ever scheduled.
    jest.advanceTimersByTime(5000);
    expect(FakeXHR.instances.length).toBe(2);
    expect(notifications.clear).toHaveBeenCalledWith("up1");
  });
});

describe("uploadMediaFiles — cancel", () => {
  it("aborts the in-flight request, rejects 'Upload cancelled' and clears the notification", async () => {
    const handle = uploadMediaFiles(params(), { notifyId: "up1", notifyTitle: "T" });
    const xhr = FakeXHR.latest();

    handle.cancel();
    expect(xhr.aborted).toBe(true);
    await expect(handle.promise).rejects.toThrow("Upload cancelled");
    expect(notifications.clear).toHaveBeenCalledWith("up1");
    expect(notifications.complete).not.toHaveBeenCalled();
  });

  it("cancelling during the retry backoff drops the pending retry (no new request)", async () => {
    jest.useFakeTimers();
    const handle = uploadMediaFiles(params());
    const rejection = expect(handle.promise).rejects.toThrow("Upload cancelled");

    FakeXHR.latest().networkFail(); // schedules a retry
    handle.cancel(); // must clear the pending retry timer

    jest.advanceTimersByTime(5000);
    expect(FakeXHR.instances.length).toBe(1); // retry never fired
    await rejection;
  });
});
