/**
 * utils/serverLiveness — waitForServerUp: RAW-axios /ping polling (never the
 * api singleton — its auth header + 401-refresh interceptor would forceLogout
 * mid-restore) with 1.5x exponential backoff + jitter, an absolute deadline,
 * and cooperative cancellation.
 */
jest.mock("axios", () => ({ get: jest.fn() }));

import axios from "axios";
import { waitForServerUp } from "../../utils/serverLiveness";

const axiosGet = axios.get as jest.Mock;

const UP = { data: { success: true } };
const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

beforeEach(() => {
  jest.useFakeTimers();
  axiosGet.mockReset();
  // Deterministic jitter: Math.random() * 1000 → 500ms on every delay.
  jest.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("waitForServerUp", () => {
  it("probes the literal <address>/ping (trailing slash stripped) with the 5s probe timeout", async () => {
    axiosGet.mockResolvedValue(UP);

    const result = await waitForServerUp("https://abs.example.com/", {
      deadlineAt: Date.now() + 60_000,
      isCancelled: () => false,
    });

    expect(result).toBe("up");
    expect(axiosGet).toHaveBeenCalledWith("https://abs.example.com/ping", { timeout: 5000 });
  });

  it("resolves 'up' from the very first probe without ever sleeping", async () => {
    axiosGet.mockResolvedValue(UP);

    const result = await waitForServerUp("https://abs.example.com", {
      deadlineAt: Date.now() + 60_000,
      isCancelled: () => false,
    });

    expect(result).toBe("up");
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("retries failed probes with 1.5x backoff + jitter until the ping answers", async () => {
    axiosGet
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(UP);

    const promise = waitForServerUp("https://abs.example.com", {
      deadlineAt: Date.now() + 60_000,
      isCancelled: () => false,
    });

    // First probe fires immediately (no leading delay).
    await jest.advanceTimersByTimeAsync(0);
    expect(axiosGet).toHaveBeenCalledTimes(1);

    // First retry after 3000 * 1.5^0 + 500 jitter = 3500ms — not a tick sooner.
    await jest.advanceTimersByTimeAsync(3499);
    expect(axiosGet).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(axiosGet).toHaveBeenCalledTimes(2);

    // Second retry after 3000 * 1.5^1 + 500 = 5000ms.
    await jest.advanceTimersByTimeAsync(4999);
    expect(axiosGet).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(axiosGet).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toBe("up");
  });

  it("caps the growing delay at maxIntervalMs", async () => {
    axiosGet.mockRejectedValue(refused());
    let cancelled = false;

    const promise = waitForServerUp("https://abs.example.com", {
      baseIntervalMs: 1000,
      maxIntervalMs: 2000,
      jitterMs: 0,
      deadlineAt: Date.now() + 60_000,
      isCancelled: () => cancelled,
    });

    await jest.advanceTimersByTimeAsync(0); // probe 1
    await jest.advanceTimersByTimeAsync(1000); // 1000 * 1.5^0 → probe 2
    await jest.advanceTimersByTimeAsync(1500); // 1000 * 1.5^1 → probe 3
    expect(axiosGet).toHaveBeenCalledTimes(3);

    // 1000 * 1.5^2 = 2250 would be next, but the cap holds it at 2000.
    await jest.advanceTimersByTimeAsync(1999);
    expect(axiosGet).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(axiosGet).toHaveBeenCalledTimes(4);

    cancelled = true;
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe("cancelled");
  });

  it("a 2xx WITHOUT { success: true } (proxy error page) does not count as up", async () => {
    axiosGet
      .mockResolvedValueOnce({ data: "<html>502 Bad Gateway</html>" })
      .mockResolvedValueOnce(UP);

    const promise = waitForServerUp("https://abs.example.com", {
      deadlineAt: Date.now() + 60_000,
      isCancelled: () => false,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(axiosGet).toHaveBeenCalledTimes(1);

    // The bogus 200 is treated exactly like a failed probe: keep polling.
    await jest.advanceTimersByTimeAsync(3500);
    await expect(promise).resolves.toBe("up");
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });

  it("returns 'timeout' once the absolute deadline passes", async () => {
    axiosGet.mockRejectedValue(refused());

    const promise = waitForServerUp("https://abs.example.com", {
      deadlineAt: Date.now() + 8000,
      isCancelled: () => false,
    });

    await jest.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toBe("timeout");
    // Probes at t=0 and t=3500; the next wake-up (t=8500) is past the
    // deadline, so no third probe fires.
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });

  it("returns 'timeout' immediately when called with an already-passed deadline", async () => {
    const result = await waitForServerUp("https://abs.example.com", {
      deadlineAt: Date.now() - 1,
      isCancelled: () => false,
    });
    expect(result).toBe("timeout");
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it("returns 'cancelled' and stops probing the moment isCancelled flips", async () => {
    axiosGet.mockRejectedValue(refused());
    let cancelled = false;

    const promise = waitForServerUp("https://abs.example.com", {
      deadlineAt: Date.now() + 60_000,
      isCancelled: () => cancelled,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(axiosGet).toHaveBeenCalledTimes(1);

    cancelled = true;
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toBe("cancelled");
    // No further network traffic after cancellation.
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it("returns 'cancelled' before the first probe when already cancelled", async () => {
    const result = await waitForServerUp("https://abs.example.com", {
      deadlineAt: Date.now() + 60_000,
      isCancelled: () => true,
    });
    expect(result).toBe("cancelled");
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it("strips ALL trailing slashes from the address, not just one", async () => {
    axiosGet.mockResolvedValue(UP);

    const result = await waitForServerUp("https://abs.example.com///", {
      deadlineAt: Date.now() + 60_000,
      isCancelled: () => false,
    });

    expect(result).toBe("up");
    expect(axiosGet).toHaveBeenCalledWith("https://abs.example.com/ping", { timeout: 5000 });
  });

  describe("initialDelayMs (re-entry throttle)", () => {
    it("sleeps the full initial delay BEFORE the first probe", async () => {
      axiosGet.mockResolvedValue(UP);

      const promise = waitForServerUp("https://abs.example.com", {
        initialDelayMs: 3000,
        deadlineAt: Date.now() + 60_000,
        isCancelled: () => false,
      });

      // No leading probe — the whole point is that a verify→reconnect
      // re-entry can never ping immediately.
      await jest.advanceTimersByTimeAsync(2999);
      expect(axiosGet).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(axiosGet).toHaveBeenCalledTimes(1);
      await expect(promise).resolves.toBe("up");
    });

    it("cancellation during the initial delay stops before ANY probe fires", async () => {
      axiosGet.mockResolvedValue(UP);
      let cancelled = false;

      const promise = waitForServerUp("https://abs.example.com", {
        initialDelayMs: 3000,
        deadlineAt: Date.now() + 60_000,
        isCancelled: () => cancelled,
      });

      await jest.advanceTimersByTimeAsync(1000);
      cancelled = true;
      await jest.advanceTimersByTimeAsync(60_000);

      await expect(promise).resolves.toBe("cancelled");
      expect(axiosGet).not.toHaveBeenCalled();
    });

    it("an initial delay longer than the deadline is clamped and resolves 'timeout' with no probe", async () => {
      axiosGet.mockResolvedValue(UP);

      const promise = waitForServerUp("https://abs.example.com", {
        initialDelayMs: 10_000,
        deadlineAt: Date.now() + 2000,
        isCancelled: () => false,
      });
      let settled: string | null = null;
      promise.then((r) => {
        settled = r;
      });

      await jest.advanceTimersByTimeAsync(1999);
      expect(settled).toBeNull();
      // Clamped to the remaining 2000ms — NOT the full 10s delay.
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toBe("timeout");
      expect(axiosGet).not.toHaveBeenCalled();
    });
  });

  it("clamps each retry sleep to the remaining deadline (no overshoot past deadlineAt)", async () => {
    axiosGet.mockRejectedValue(refused());

    const promise = waitForServerUp("https://abs.example.com", {
      baseIntervalMs: 10_000,
      jitterMs: 0,
      deadlineAt: Date.now() + 4000,
      isCancelled: () => false,
    });
    let settled: string | null = null;
    promise.then((r) => {
      settled = r;
    });

    // Probe 1 at t=0 fails; the 10s retry sleep is clamped to the 4s left.
    await jest.advanceTimersByTimeAsync(3999);
    expect(settled).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    // Wakes AT the deadline and resolves — an unclamped sleep would still be
    // pending for another 6 seconds here.
    expect(settled).toBe("timeout");
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });
});
