// Locks the expanded-player layout arithmetic (utils/playerLayout.ts).
// Two past device-only bugs were pure math drift inside PlayerBottomSheet:
//  1. the absolute Y cascade omitted the book-progress bar's box, crowding the
//     title into the scrubber and clipping the bottom pill;
//  2. the hand-summed content-block height drifted from the cascade it was
//     supposed to mirror, mis-centering the tablet block.
// These tests pin the invariants so CI catches the next drift.
import { computePlayerLayout, PlayerLayoutInput } from "../../utils/playerLayout";

const phone = (over: Partial<PlayerLayoutInput> = {}): PlayerLayoutInput => ({
  screenWidth: 412,
  screenHeight: 915,
  insetTop: 24,
  insetBottom: 24,
  showBookProgress: true,
  ...over,
});

const tablet = (over: Partial<PlayerLayoutInput> = {}): PlayerLayoutInput => ({
  screenWidth: 800,
  screenHeight: 1280,
  insetTop: 24,
  insetBottom: 24,
  showBookProgress: true,
  ...over,
});

// Device matrix used by the invariant sweeps. PORTRAIT-only on purpose: the
// cascade under test is the portrait layout, and the component renders it
// display:none in landscape (landscape swaps to the LS_COVER two-pane layout,
// whose sizing is covered separately below) — landscape rows here would be
// false coverage of math no user ever sees.
const devices: Array<[string, Omit<PlayerLayoutInput, "showBookProgress">]> = [
  ["tiny phone 320x640", { screenWidth: 320, screenHeight: 640, insetTop: 24, insetBottom: 0 }],
  ["small phone 360x640", { screenWidth: 360, screenHeight: 640, insetTop: 24, insetBottom: 0 }],
  ["phone 412x915", { screenWidth: 412, screenHeight: 915, insetTop: 24, insetBottom: 24 }],
  ["tall phone 448x998", { screenWidth: 448, screenHeight: 998, insetTop: 32, insetBottom: 32 }],
  ["foldable inner 673x841", { screenWidth: 673, screenHeight: 841, insetTop: 24, insetBottom: 24 }],
  ["tablet portrait 800x1280", { screenWidth: 800, screenHeight: 1280, insetTop: 24, insetBottom: 24 }],
  ["squat tablet 800x840", { screenWidth: 800, screenHeight: 840, insetTop: 24, insetBottom: 24 }],
];

describe("computePlayerLayout", () => {
  describe("book-progress toggle (the bug that clipped the pill)", () => {
    it.each(devices)(
      "%s: CHAPTER_PROGRESS_Y with the book bar ON exceeds OFF by exactly the book-bar box + gap delta",
      (_name, dims) => {
        // Compare on a phone-style fixed anchor: on tablets extraTop shifts the
        // whole cascade too, so measure relative to BOOK_PROGRESS_Y (the numeric
        // row top), which pins the same anchor in both modes.
        const on = computePlayerLayout({ ...dims, showBookProgress: true });
        const off = computePlayerLayout({ ...dims, showBookProgress: false });
        const onDelta = on.CHAPTER_PROGRESS_Y - on.BOOK_PROGRESS_Y;
        const offDelta = off.CHAPTER_PROGRESS_Y - off.BOOK_PROGRESS_Y;
        expect(onDelta - offDelta).toBe(
          on.BOOK_BAR_BOX - off.BOOK_BAR_BOX + (on.NUMERIC_TO_SCRUBBER - off.NUMERIC_TO_SCRUBBER)
        );
        // And the raw numbers: ON inserts the 8+12 book-bar box and widens the
        // scrubber gap from 8 to 12 — 24dp total.
        expect(on.BOOK_BAR_BOX).toBe(on.BOOK_BAR_GAP + on.BOOK_BAR_H);
        expect(on.BOOK_BAR_BOX).toBe(20);
        expect(off.BOOK_BAR_BOX).toBe(0);
        expect(onDelta - offDelta).toBe(24);
      }
    );

    it("on phones (no extraTop) the absolute CHAPTER_PROGRESS_Y itself shifts by the same 24dp", () => {
      const on = computePlayerLayout(phone({ showBookProgress: true }));
      const off = computePlayerLayout(phone({ showBookProgress: false }));
      expect(on.extraTop).toBe(0);
      expect(off.extraTop).toBe(0);
      expect(on.CHAPTER_PROGRESS_Y - off.CHAPTER_PROGRESS_Y).toBe(24);
    });
  });

  describe("title never crowds the scrubber", () => {
    const MIN_GAP = 12; // the cascade uses 20; anything under 12 is a regression
    it.each(devices)("%s: title top >= scrubber bottom + min gap, both modes", (_name, dims) => {
      for (const showBookProgress of [true, false]) {
        const l = computePlayerLayout({ ...dims, showBookProgress });
        const scrubberBottom = l.CHAPTER_PROGRESS_Y + l.SCRUBBER_H;
        expect(l.TITLE_Y_EXP).toBeGreaterThanOrEqual(scrubberBottom + MIN_GAP);
        // Exact current value, so any drift is a conscious change:
        expect(l.TITLE_Y_EXP - scrubberBottom).toBe(l.SCRUBBER_TO_TITLE);
      }
    });
  });

  describe("cascade / block-height consistency (no hand-summed drift)", () => {
    it.each(devices)(
      "%s: contentBottomY - COVER_Y_EXP === CONTENT_BLOCK_H, both modes",
      (_name, dims) => {
        for (const showBookProgress of [true, false]) {
          const l = computePlayerLayout({ ...dims, showBookProgress });
          // The absolute cascade (cover top → pill bottom) and the hand-summed
          // centering height must be the SAME number — this is precisely the
          // identity that broke when BOOK_BAR_BOX was omitted from one of them.
          expect(l.contentBottomY - l.COVER_Y_EXP).toBe(l.CONTENT_BLOCK_H);
        }
      }
    );

    it.each(devices)("%s: each cascade step equals its declared flow delta", (_name, dims) => {
      for (const showBookProgress of [true, false]) {
        const l = computePlayerLayout({ ...dims, showBookProgress });
        // Source label (20 high, 8 gap) → cover
        expect(l.COVER_Y_EXP - l.SOURCE_LABEL_Y).toBe(20 + 8);
        // Cover → numeric row: mirrors the component's numeric placeholder
        // marginTop expression (BOOK_PROGRESS_Y - COVER_Y_EXP - COVER_SIZE_EXP).
        expect(l.BOOK_PROGRESS_Y - l.COVER_Y_EXP - l.COVER_SIZE_EXP).toBe(l.COVER_TO_NUMERIC);
        // Numeric row → scrubber: mirrors the scrubber marginTop ternary
        // (12 when the book bar is shown, CHAPTER_PROGRESS_Y - BOOK_PROGRESS_Y - 28 otherwise).
        expect(l.CHAPTER_PROGRESS_Y - l.BOOK_PROGRESS_Y - l.NUMERIC_H).toBe(
          l.BOOK_BAR_BOX + l.NUMERIC_TO_SCRUBBER
        );
        expect(l.CHAPTER_PROGRESS_Y - l.BOOK_PROGRESS_Y - l.NUMERIC_H).toBe(
          showBookProgress ? 8 + 12 + 12 : 8
        );
        // Scrubber → title placeholder (TITLE_Y_EXP - CHAPTER_PROGRESS_Y - 36).
        expect(l.TITLE_Y_EXP - l.CHAPTER_PROGRESS_Y - l.SCRUBBER_H).toBe(l.SCRUBBER_TO_TITLE);
        // Title → transport placeholder (TRANSPORT_Y_EXP - TITLE_Y_EXP - 64).
        expect(l.TRANSPORT_Y_EXP - l.TITLE_Y_EXP - l.TITLE_H).toBe(l.TITLE_TO_TRANSPORT);
        // Transport → pill bottom.
        expect(l.contentBottomY - l.TRANSPORT_Y_EXP).toBe(
          l.TRANSPORT_H + l.TRANSPORT_TO_PILL + l.PILL_H
        );
      }
    });
  });

  describe("short-viewport overflow (scroll re-enable)", () => {
    it("overflows on a short 360x640 phone", () => {
      const l = computePlayerLayout({
        screenWidth: 360,
        screenHeight: 640,
        insetTop: 24,
        insetBottom: 0,
        showBookProgress: true,
      });
      expect(l.contentOverflows).toBe(true);
    });

    it("does not overflow on a tall 412x915 phone", () => {
      const l = computePlayerLayout(phone());
      expect(l.contentOverflows).toBe(false);
    });

    it("does not overflow on a very tall 1080x2400 viewport", () => {
      const l = computePlayerLayout({
        screenWidth: 1080,
        screenHeight: 2400,
        insetTop: 24,
        insetBottom: 24,
        showBookProgress: true,
      });
      expect(l.contentOverflows).toBe(false);
    });

    it("flips exactly at the fit boundary as the viewport shrinks", () => {
      // 412-wide phone, insets 24/0: the cover caps at 320 for both heights,
      // so the block bottom (+8 slack) sits at a fixed 816dp — one dp of
      // screen height across that line must flip the flag.
      const at = (screenHeight: number) =>
        computePlayerLayout({ screenWidth: 412, screenHeight, insetTop: 24, insetBottom: 0, showBookProgress: true });
      expect(at(816).contentOverflows).toBe(false); // exactly fits (strict >)
      expect(at(815).contentOverflows).toBe(true); // one dp short
    });

    it("bottom-inset flip: the same phone overflows with 3-button nav (48) but not gesture nav (0)", () => {
      const dims = { screenWidth: 412, screenHeight: 820, insetTop: 24, showBookProgress: true };
      expect(computePlayerLayout({ ...dims, insetBottom: 0 }).contentOverflows).toBe(false);
      expect(computePlayerLayout({ ...dims, insetBottom: 48 }).contentOverflows).toBe(true);
    });

    it("hiding the book bar frees exactly 24dp of cascade height", () => {
      const on = computePlayerLayout(phone({ showBookProgress: true }));
      const off = computePlayerLayout(phone({ showBookProgress: false }));
      expect(on.CONTENT_BLOCK_H - off.CONTENT_BLOCK_H).toBe(24);
      expect(on.contentBottomY - off.contentBottomY).toBe(24);
    });
  });

  describe("tablet vertical centering", () => {
    it("extraTop = max(0, (availH - CONTENT_BLOCK_H) / 2) on tablets", () => {
      const l = computePlayerLayout(tablet());
      expect(l.isTablet).toBe(true);
      const expectedAvail = 1280 - (24 + 8 + 56) - 24 - 20;
      expect(l.availH).toBe(expectedAvail);
      expect(l.extraTop).toBe(Math.max(0, (expectedAvail - l.CONTENT_BLOCK_H) / 2));
      expect(l.extraTop).toBeGreaterThan(0);
      // The centering must feed the cascade: the source label shifts by extraTop.
      const base = computePlayerLayout(tablet());
      expect(base.SOURCE_LABEL_Y).toBe(base.TOP_BAR_Y + 56 + 12 + base.extraTop);
    });

    it("extraTop is clamped to 0 when the block does not fit (squat 800x840 tablet portrait)", () => {
      const l = computePlayerLayout({
        screenWidth: 800,
        screenHeight: 840,
        insetTop: 24,
        insetBottom: 24,
        showBookProgress: true,
      });
      expect(l.isTablet).toBe(true);
      expect(l.availH).toBeLessThan(l.CONTENT_BLOCK_H);
      expect(l.extraTop).toBe(0);
    });

    it("phones never get extraTop", () => {
      for (const showBookProgress of [true, false]) {
        expect(computePlayerLayout(phone({ showBookProgress })).extraTop).toBe(0);
      }
    });

    it("centering is book-bar-aware: toggling the bar changes tablet extraTop by half the freed height", () => {
      const on = computePlayerLayout(tablet({ showBookProgress: true }));
      const off = computePlayerLayout(tablet({ showBookProgress: false }));
      expect(off.extraTop - on.extraTop).toBe(12); // 24dp freed, half above
    });
  });

  describe("column and cover sizing", () => {
    it("phone: PW == screenWidth, PX == 0; tablet: column capped at 480 and centered", () => {
      const p = computePlayerLayout(phone());
      expect(p.PW).toBe(412);
      expect(p.PX).toBe(0);
      const t = computePlayerLayout(tablet());
      expect(t.PW).toBe(480);
      expect(t.PX).toBe((800 - 480) / 2);
    });

    it("cover cap: 320 on phones, 420 on tablets, height- and column-limited", () => {
      const p = computePlayerLayout(phone());
      expect(p.COVER_SIZE_EXP).toBe(Math.min(412 - 80, Math.round(915 * 0.42), 320));
      const t = computePlayerLayout(tablet());
      expect(t.COVER_SIZE_EXP).toBe(Math.min(480 - 80, Math.round(1280 * 0.42), 420));
      const small = computePlayerLayout(phone({ screenWidth: 360, screenHeight: 640, insetBottom: 0 }));
      expect(small.COVER_SIZE_EXP).toBe(Math.round(640 * 0.42)); // height-limited
    });
  });

  describe("LS_COVER (landscape two-pane cover sizing)", () => {
    // The only landscape output. Budget: the 56dp top bar + 32dp margins out
    // of the (short) height, capped at 42% of the width so the right pane
    // keeps room for the controls.
    it("phone landscape 915x412: height-limited to the top-bar budget", () => {
      const l = computePlayerLayout({
        screenWidth: 915,
        screenHeight: 412,
        insetTop: 0,
        insetBottom: 24,
        showBookProgress: true,
      });
      const heightBudget = 412 - 0 - 24 - 56 - 32;
      expect(l.LS_COVER).toBe(heightBudget); // 300 — the height term won
      expect(l.LS_COVER).toBeLessThanOrEqual(heightBudget);
      expect(l.LS_COVER).toBeLessThanOrEqual(Math.round(915 * 0.42));
    });

    it("tablet landscape 1280x800: width-capped at 42% of the width", () => {
      const l = computePlayerLayout({
        screenWidth: 1280,
        screenHeight: 800,
        insetTop: 24,
        insetBottom: 24,
        showBookProgress: true,
      });
      expect(l.LS_COVER).toBe(Math.round(1280 * 0.42)); // 538 — the width cap won
      expect(l.LS_COVER).toBeLessThanOrEqual(800 - 24 - 24 - 56 - 32);
    });

    it("never exceeds the height budget that keeps it clear of the collapse button", () => {
      // The regression LS_COVER's 56+32 budget fixed: a vertically-centered
      // cover creeping up under the top bar. Sweep landscape-ish dims.
      const landscapes = [
        { screenWidth: 800, screenHeight: 400, insetTop: 0, insetBottom: 0 },
        { screenWidth: 915, screenHeight: 412, insetTop: 0, insetBottom: 24 },
        { screenWidth: 998, screenHeight: 448, insetTop: 32, insetBottom: 32 },
        { screenWidth: 1280, screenHeight: 800, insetTop: 24, insetBottom: 24 },
      ];
      for (const dims of landscapes) {
        const l = computePlayerLayout({ ...dims, showBookProgress: true });
        expect(l.LS_COVER).toBeLessThanOrEqual(
          dims.screenHeight - dims.insetTop - dims.insetBottom - 56 - 32
        );
      }
    });
  });
});
