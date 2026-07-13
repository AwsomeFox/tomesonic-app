import {
  formatBytes,
  formatListeningTime,
  formatSize,
  formatDateTime,
} from "../../utils/format";

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

describe("formatDateTime", () => {
  // A fixed epoch-ms instant. Assert against the same toLocaleDateString the
  // helper uses so the expectations don't hinge on the CI box's timezone.
  const ts = Date.UTC(2024, 2, 5, 12, 0, 0); // 2024-03-05
  const opts = { month: "short", day: "numeric", year: "numeric" } as const;

  it("reproduces AdminSessionsScreen.formatWhen (en-US locale, 'Unknown' fallback)", () => {
    const expected = new Date(ts).toLocaleDateString("en-US", opts);
    expect(formatDateTime(ts, { locale: "en-US", fallback: "Unknown" })).toBe(expected);
    expect(formatDateTime(0, { locale: "en-US", fallback: "Unknown" })).toBe("Unknown");
    expect(formatDateTime(null as any, { locale: "en-US", fallback: "Unknown" })).toBe("Unknown");
    expect(formatDateTime(undefined, { locale: "en-US", fallback: "Unknown" })).toBe("Unknown");
    expect(formatDateTime("not-a-date", { locale: "en-US", fallback: "Unknown" })).toBe("Unknown");
  });

  it("reproduces ItemHistoryScreen.formatDate (device-default locale, '' fallback)", () => {
    const expected = new Date(ts).toLocaleDateString(undefined, opts);
    expect(formatDateTime(ts)).toBe(expected);
    expect(formatDateTime(0)).toBe("");
    expect(formatDateTime(null as any)).toBe("");
    expect(formatDateTime(undefined)).toBe("");
    expect(formatDateTime("not-a-date")).toBe("");
  });

  it("accepts date strings", () => {
    const expected = new Date("2024-03-05T12:00:00Z").toLocaleDateString("en-US", opts);
    expect(formatDateTime("2024-03-05T12:00:00Z", { locale: "en-US" })).toBe(expected);
  });
});
