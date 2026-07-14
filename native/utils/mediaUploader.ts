/**
 * Streaming device → server media uploader (issue #57).
 *
 * The MIRROR of utils/downloader.ts's downloadFileByUrl, but for the opposite
 * direction: a single, handle-based, cancellable streaming operation that
 * reports progress through the shared notifee helper (downloadNotifications).
 *
 * WHY A BARE XMLHttpRequest (not axios): only XHR exposes xhr.upload.onprogress,
 * so a multi-hundred-MB upload can drive a real progress bar. Axios (utils/abs/
 * upload.uploadMedia) is the contract-pinned small-file fallback; the heavy
 * lifting lives here. The URL + bearer token come from getUploadTarget() — the
 * pure host/token builder — so the shared axios instance's 20s timeout and
 * 401-refresh interceptor never see the big body.
 *
 * Content-Type is deliberately NOT set: RN/the browser stamps the multipart
 * boundary onto the FormData body itself, and setting it by hand drops the
 * boundary and corrupts the request.
 */
import { getUploadTarget } from "./abs/upload";
import { downloadNotifications } from "./downloadNotifications";

// POST /api/upload is NOT resumable (no Range/offset support): a network drop
// mid-stream can only be recovered by re-sending the WHOLE body. We therefore
// retry at most ONCE, after a short backoff, and only for a true network
// failure (onerror/ontimeout with no HTTP status) — never for a non-2xx status,
// which is a real server rejection the retry would just reproduce.
const RETRY_DELAY_MS = 1500;

export interface MediaUploadHandle {
  /** Resolves with the server's parsed JSON response on 2xx; rejects with an Error on failure/cancel. */
  promise: Promise<any>;
  /** Aborts the in-flight upload; promise rejects with a cancellation Error. */
  cancel: () => void;
}

export interface MediaUploadParams {
  libraryId: string;
  folderId: string;
  title?: string;
  author?: string;
  series?: string;
  files: { uri: string; name: string; type?: string }[];
}

export interface MediaUploadOptions {
  onProgress?: (sent: number, total: number) => void; // bytes
  /** notifee notification id + title for the progress notification (optional). */
  notifyId?: string;
  notifyTitle?: string;
}

/** Human-readable message for a non-2xx upload response (mirrors downloader's describeHttpFailure). */
function describeUploadFailure(status: number): string {
  if (status === 401) return "Your session has expired — please sign in again.";
  if (status === 403) return "You don't have permission to upload to this server.";
  if (status === 413) return "That file is too large for the server to accept.";
  if (status >= 500) return `The server had a problem (error ${status}). Please try again.`;
  return `Upload failed (status ${status}).`;
}

export function uploadMediaFiles(
  params: MediaUploadParams,
  opts: MediaUploadOptions = {}
): MediaUploadHandle {
  const { onProgress, notifyId, notifyTitle } = opts;

  let cancelled = false;
  let retried = false;
  let xhr: XMLHttpRequest | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  let resolvePromise!: (value: any) => void;
  let rejectPromise!: (reason: Error) => void;
  const promise = new Promise<any>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const target = getUploadTarget();
  if (!target) {
    // No usable session — reject immediately (nothing to clean up; no
    // notification was ever started).
    rejectPromise(new Error("Not signed in to a server."));
    return { promise, cancel: () => {} };
  }

  const clearNotif = () => {
    if (notifyId) downloadNotifications.clear(notifyId);
  };

  // Build the multipart body exactly like utils/abs/upload.uploadMedia: string
  // fields library/folder/title?/author?/series?, then files under numeric
  // string keys "0","1",... with type defaulting to application/octet-stream.
  const buildForm = (): FormData => {
    const form = new FormData();
    form.append("library", params.libraryId);
    form.append("folder", params.folderId);
    if (params.title) form.append("title", params.title);
    if (params.author) form.append("author", params.author);
    if (params.series) form.append("series", params.series);
    params.files.forEach((f, i) => {
      form.append(String(i), {
        uri: f.uri,
        name: f.name,
        type: f.type || "application/octet-stream",
      } as any);
    });
    return form;
  };

  const finishOk = (data: any) => {
    if (notifyId) downloadNotifications.complete(notifyId, notifyTitle || "");
    resolvePromise(data);
  };

  const finishErr = (err: Error) => {
    clearNotif();
    rejectPromise(err);
  };

  const send = () => {
    const req = new XMLHttpRequest();
    xhr = req;
    req.open("POST", target.url);
    req.setRequestHeader("Authorization", `Bearer ${target.token}`);
    // Do NOT set Content-Type — RN/the browser sets the multipart boundary.
    // No timeout: rely on cancel() + network-error handling so a large file
    // isn't killed mid-stream.
    req.timeout = 0;

    if (req.upload) {
      req.upload.onprogress = (e: ProgressEvent) => {
        // A late event after cancel must not touch UI/notifications.
        if (cancelled) return;
        const total = e.total || 0;
        onProgress?.(e.loaded, total);
        if (notifyId && total > 0) {
          downloadNotifications.progress(notifyId, notifyTitle || "", e.loaded / total);
        }
      };
    }

    req.onload = () => {
      if (cancelled) return;
      const status = req.status;
      if (status >= 200 && status < 300) {
        let data: any = {};
        try {
          data = JSON.parse(req.responseText || "{}");
        } catch {
          // A 2xx with an unparseable/empty body is still a success.
          data = {};
        }
        finishOk(data);
        return;
      }
      // A non-2xx HTTP status is a real server rejection — NEVER retried.
      finishErr(new Error(describeUploadFailure(status)));
    };

    // Network failure (no HTTP status): retry ONCE after a short delay by
    // re-issuing the whole request (/api/upload is not resumable — the retry
    // re-sends the entire body). A second network failure is fatal.
    const onNetworkFail = () => {
      if (cancelled) return;
      if (!retried) {
        retried = true;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!cancelled) send();
        }, RETRY_DELAY_MS);
        return;
      }
      finishErr(new Error("Upload failed — the network connection was lost."));
    };
    req.onerror = onNetworkFail;
    req.ontimeout = onNetworkFail;

    req.send(buildForm());
  };

  if (notifyId) downloadNotifications.start(notifyId, notifyTitle || "");
  send();

  return {
    promise,
    cancel: () => {
      if (cancelled) return;
      // Mark cancelled FIRST so a resulting onerror/onabort doesn't fire the
      // retry, then abort the in-flight request and drop any pending retry.
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        xhr?.abort();
      } catch {}
      clearNotif();
      rejectPromise(new Error("Upload cancelled"));
    },
  };
}
