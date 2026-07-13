import {
  secondsToTimestamp,
  formatBytes,
  formatListeningTime,
  formatSize,
  remainingPretty,
} from "../../utils/format";

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

describe("formatListeningTime", () => {
  // Behavior matches the copies moved verbatim from AdminSessionsScreen /
  // AdminUserDetailScreen — those screens adopt this in a later pass.
  it("shows whole seconds under a minute (rounding)", () => {
    expect(formatListeningTime(0)).toBe("0s");
    expect(formatListeningTime(45)).toBe("45s");
    expect(formatListeningTime(59.4)).toBe("59s");
  });

  it("rounds 59.5s up into the minute bucket", () => {
    expect(formatListeningTime(59.5)).toBe("1m");
  });

  it("shows whole minutes under an hour (seconds dropped)", () => {
    expect(formatListeningTime(60)).toBe("1m");
    expect(formatListeningTime(119)).toBe("1m");
    expect(formatListeningTime(59 * 60 + 59)).toBe("59m");
  });

  it("shows hours + remainder minutes from an hour up", () => {
    expect(formatListeningTime(3600)).toBe("1h 0m");
    expect(formatListeningTime(3600 * 2 + 60 * 5)).toBe("2h 5m");
    expect(formatListeningTime(100 * 3600 + 30 * 60)).toBe("100h 30m");
  });

  it("clamps null/undefined/negative/NaN to 0s", () => {
    expect(formatListeningTime(null)).toBe("0s");
    expect(formatListeningTime(undefined)).toBe("0s");
    expect(formatListeningTime(-30)).toBe("0s");
    expect(formatListeningTime(NaN)).toBe("0s");
  });
});

describe("formatSize", () => {
  it("floors zero/negative/falsy/non-finite at '0 B'", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(-5)).toBe("0 B");
    expect(formatSize(NaN)).toBe("0 B");
    expect(formatSize(undefined as any)).toBe("0 B");
    expect(formatSize(Infinity)).toBe("0 B");
  });

  it("walks the full ladder B → KB → MB → GB → TB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024)).toBe("1 MB");
    expect(formatSize(5.25 * 1024 * 1024)).toBe("5.3 MB");
    expect(formatSize(1024 ** 3)).toBe("1 GB");
    expect(formatSize(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatSize(1024 ** 4)).toBe("1 TB");
  });

  it("uses one decimal below 100, whole numbers from 100 up", () => {
    expect(formatSize(99.94 * 1024)).toBe("99.9 KB");
    expect(formatSize(100 * 1024)).toBe("100 KB");
    expect(formatSize(250.6 * 1024 * 1024)).toBe("251 MB");
  });

  it("caps at TB (no overflow past the ladder)", () => {
    expect(formatSize(2048 * 1024 ** 4)).toBe("2048 TB");
  });

  it("is distinct from formatBytes (different display contracts, both kept)", () => {
    // formatBytes is MB/GB-only with an MB floor; formatSize is the full ladder.
    expect(formatBytes(512)).toBe("0.0 MB");
    expect(formatSize(512)).toBe("512 B");
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
