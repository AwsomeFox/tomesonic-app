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
