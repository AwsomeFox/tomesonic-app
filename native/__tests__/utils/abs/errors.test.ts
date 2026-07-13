/**
 * utils/abs/errors — normalization matrix and the offline idiom.
 *
 * The offline test (`!e?.response`) is deliberately the same idiom
 * ItemDetailScreen uses to decide "queue locally" vs "server rejected" —
 * these tests pin that equivalence.
 */
import {
  AbsError,
  normalizeAbsError,
  isOfflineError,
  isForbiddenError,
  isUnsupportedError,
  absErrorToErrorStateProps,
  absRequest,
} from "../../../utils/abs/errors";

const httpError = (status: number, data?: any) => ({
  message: `Request failed with status code ${status}`,
  response: { status, data },
});

describe("normalizeAbsError", () => {
  it("maps a response-less error to offline (the ItemDetailScreen idiom)", () => {
    const e = normalizeAbsError(new Error("Network Error"));
    expect(e).toBeInstanceOf(AbsError);
    expect(e.kind).toBe("offline");
    expect(e.status).toBeUndefined();
  });

  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [404, "unsupported"],
    [500, "server"],
    [502, "server"],
    [400, "unknown"],
    [409, "unknown"],
  ] as const)("maps HTTP %d to kind %s", (status, kind) => {
    const e = normalizeAbsError(httpError(status));
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
  });

  it("uses the server's plain-text reason body as the message when short", () => {
    const e = normalizeAbsError(httpError(400, "Slug already in use"));
    expect(e.message).toBe("Slug already in use");
  });

  it("ignores a non-string (HTML/object) body and falls back to the kind default", () => {
    const e = normalizeAbsError(httpError(500, { error: "boom" }));
    expect(typeof e.message).toBe("string");
    expect(e.message).not.toContain("boom");
  });

  it("passes an existing AbsError through untouched", () => {
    const original = new AbsError("forbidden", "custom", 403);
    expect(normalizeAbsError(original)).toBe(original);
  });

  it("keeps the original error as cause", () => {
    const raw = httpError(403);
    expect(normalizeAbsError(raw).cause).toBe(raw);
  });

  describe("overrides", () => {
    it("re-kinds a status via a bare kind string", () => {
      const e = normalizeAbsError(httpError(404), { 404: "unknown" });
      expect(e.kind).toBe("unknown");
    });

    it("re-kinds + re-messages via an object override", () => {
      const e = normalizeAbsError(httpError(403), {
        403: { kind: "forbidden", message: "Admins only" },
      });
      expect(e.kind).toBe("forbidden");
      expect(e.message).toBe("Admins only");
    });

    it("does not apply an override for a different status", () => {
      const e = normalizeAbsError(httpError(500), { 404: "unknown" });
      expect(e.kind).toBe("server");
    });
  });
});

describe("classifier helpers", () => {
  it("isOfflineError matches !e?.response on raw errors", () => {
    expect(isOfflineError(new Error("x"))).toBe(true);
    expect(isOfflineError(undefined)).toBe(true);
    expect(isOfflineError(httpError(500))).toBe(false);
  });

  it("isOfflineError reads .kind on AbsError (an offline AbsError has no .response either)", () => {
    expect(isOfflineError(new AbsError("offline", "m"))).toBe(true);
    expect(isOfflineError(new AbsError("forbidden", "m", 403))).toBe(false);
  });

  it("isForbiddenError matches 403 raw and forbidden AbsError", () => {
    expect(isForbiddenError(httpError(403))).toBe(true);
    expect(isForbiddenError(httpError(401))).toBe(false);
    expect(isForbiddenError(new AbsError("forbidden", "m", 403))).toBe(true);
    expect(isForbiddenError(new AbsError("server", "m", 500))).toBe(false);
  });

  it("isUnsupportedError matches 404 raw and unsupported AbsError", () => {
    expect(isUnsupportedError(httpError(404))).toBe(true);
    expect(isUnsupportedError(httpError(403))).toBe(false);
    expect(isUnsupportedError(new AbsError("unsupported", "m", 404))).toBe(true);
  });
});

describe("absErrorToErrorStateProps", () => {
  it.each([
    ["offline", new AbsError("offline", "Can't reach the server. Check your connection."), "cloud-off", "You're offline"],
    ["forbidden", new AbsError("forbidden", "You don't have permission to do that.", 403), "lock", "Admin access required"],
    ["unsupported", new AbsError("unsupported", "The server doesn't support this (it may need an update).", 404), "info", "Not supported by this server"],
    ["auth", new AbsError("auth", "Your session has expired. Please log in again.", 401), "lock", "Session expired"],
    ["server", new AbsError("server", "The server hit an error handling this request.", 500), "warning", "The server hit an error"],
    ["unknown", new AbsError("unknown", "Something went wrong. Please try again.", 400), "warning", "Couldn't load this"],
  ] as const)("kind %s → canonical icon + title", (_kind, err, icon, title) => {
    const props = absErrorToErrorStateProps(err);
    expect(props.icon).toBe(icon);
    expect(props.title).toBe(title);
    expect(typeof props.message).toBe("string");
    expect(props.message.length).toBeGreaterThan(0);
    expect(props.onRetry).toBeUndefined();
  });

  it("offline uses the shared admin copy, not the error's own message", () => {
    const props = absErrorToErrorStateProps(new AbsError("offline", "raw axios text"));
    expect(props.message).toBe("Server administration needs a connection.");
  });

  it("non-offline kinds surface the (possibly server-provided) error message", () => {
    const props = absErrorToErrorStateProps(new AbsError("server", "Slug already in use", 500));
    expect(props.message).toBe("Slug already in use");
  });

  it("subject feeds the generic unknown title", () => {
    const props = absErrorToErrorStateProps(new AbsError("unknown", "boom", 400), {
      subject: "email settings",
    });
    expect(props.title).toBe("Couldn't load email settings");
  });

  it("normalizes raw (non-AbsError) input first — the four screens pass `any`", () => {
    expect(absErrorToErrorStateProps(new Error("Network Error")).title).toBe("You're offline");
    expect(absErrorToErrorStateProps(httpError(403)).title).toBe("Admin access required");
    expect(absErrorToErrorStateProps(undefined).icon).toBe("cloud-off"); // no response → offline idiom
  });

  it("per-kind overrides replace only the given fields (screen-specific context strings)", () => {
    const props = absErrorToErrorStateProps(new AbsError("forbidden", "generic", 403), {
      overrides: {
        forbidden: { message: "Only server admins can manage backups." },
        offline: { message: "Reconnect to manage server backups." },
      },
    });
    expect(props.title).toBe("Admin access required"); // default kept
    expect(props.icon).toBe("lock"); // default kept
    expect(props.message).toBe("Only server admins can manage backups.");

    const offline = absErrorToErrorStateProps(new AbsError("offline", "x"), {
      overrides: { offline: { message: "Reconnect to manage server backups." } },
    });
    expect(offline.message).toBe("Reconnect to manage server backups.");
  });

  it("passes onRetry through onto the returned props", () => {
    const onRetry = jest.fn();
    const props = absErrorToErrorStateProps(new AbsError("server", "m", 500), { onRetry });
    expect(props.onRetry).toBe(onRetry);
  });
});

describe("absRequest", () => {
  it("unwraps .data on success", async () => {
    await expect(absRequest(() => Promise.resolve({ data: { ok: 1 } }))).resolves.toEqual({
      ok: 1,
    });
  });

  it("rethrows failures as AbsError (never a raw axios error)", async () => {
    const err = await absRequest(() => Promise.reject(httpError(403))).catch((e) => e);
    expect(err).toBeInstanceOf(AbsError);
    expect(err.kind).toBe("forbidden");
  });

  it("applies overrides on failure", async () => {
    const err = await absRequest(() => Promise.reject(httpError(404)), { 404: "unknown" }).catch(
      (e) => e
    );
    expect(err.kind).toBe("unknown");
  });
});
