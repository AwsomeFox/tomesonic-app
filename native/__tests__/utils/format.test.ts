import { secondsToTimestamp, formatBytes, remainingPretty } from "../../utils/format";

describe("secondsToTimestamp", () => {
  it("formats M:SS when under an hour", () => {
    expect(secondsToTimestamp(0)).toBe("0:00");
    expect(secondsToTimestamp(5)).toBe("0:05");
    expect(secondsToTimestamp(59)).toBe("0:59");
    expect(secondsToTimestamp(60)).toBe("1:00");
    expect(secondsToTimestamp(61.9)).toBe("1:01");
    expect(secondsToTimestamp(3599)).toBe("59:59");
  });

  it("formats H:MM:SS when an hour or more", () => {
    expect(secondsToTimestamp(3600)).toBe("1:00:00");
    expect(secondsToTimestamp(3661)).toBe("1:01:01");
    expect(secondsToTimestamp(7325)).toBe("2:02:05");
    expect(secondsToTimestamp(36000 + 600 + 6)).toBe("10:10:06");
  });

  it("clamps negatives / falsy to 0:00", () => {
    expect(secondsToTimestamp(-5)).toBe("0:00");
    expect(secondsToTimestamp(NaN as any)).toBe("0:00");
    expect(secondsToTimestamp(undefined as any)).toBe("0:00");
  });

  it("handles huge values", () => {
    expect(secondsToTimestamp(360000)).toBe("100:00:00");
  });
});

describe("formatBytes", () => {
  it("returns 0 MB for zero, negative or falsy input", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(-100)).toBe("0 MB");
    expect(formatBytes(undefined as any)).toBe("0 MB");
    expect(formatBytes(NaN as any)).toBe("0 MB");
  });

  it("uses one decimal below 10 MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5.25 * 1024 * 1024)).toBe("5.3 MB");
  });

  it("uses no decimals from 10 MB up to 1 GB", () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MB");
    expect(formatBytes(1023 * 1024 * 1024)).toBe("1023 MB");
  });

  it("switches to GB at 1024 MB with two decimals", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1024.00 GB");
  });

  it("promotes a value that rounds up to 1024 MB into GB (no '1024 MB')", () => {
    // mb in [1023.5, 1024) would render "1024 MB" with the old raw `mb >= 1024`
    // check — it must show GB instead.
    expect(formatBytes(1023.5 * 1024 * 1024)).toBe("1.00 GB");
    expect(formatBytes(1023.9 * 1024 * 1024)).toBe("1.00 GB");
    // Just below the rounding boundary stays MB.
    expect(formatBytes(1023.4 * 1024 * 1024)).toBe("1023 MB");
  });
});

describe("remainingPretty", () => {
  it("returns empty string for <= 0 / falsy", () => {
    expect(remainingPretty(0)).toBe("");
    expect(remainingPretty(-10)).toBe("");
    expect(remainingPretty(NaN as any)).toBe("");
    expect(remainingPretty(undefined as any)).toBe("");
  });

  it("formats seconds only under a minute", () => {
    expect(remainingPretty(59)).toBe("59 sec remaining");
    expect(remainingPretty(1.7)).toBe("1 sec remaining");
  });

  it("formats minutes under an hour", () => {
    expect(remainingPretty(60)).toBe("1 min remaining");
    expect(remainingPretty(59 * 60 + 59)).toBe("59 min remaining");
  });

  it("formats hours and minutes", () => {
    expect(remainingPretty(3600)).toBe("1 hr 0 min remaining");
    expect(remainingPretty(3600 * 2 + 60 * 5 + 30)).toBe("2 hr 5 min remaining");
    expect(remainingPretty(100 * 3600)).toBe("100 hr 0 min remaining");
  });
});
