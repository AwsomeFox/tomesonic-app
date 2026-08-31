// Locks the expanded-player layout arithmetic (utils/playerLayout.ts).
// Two past device-only bugs were pure math drift inside PlayerBottomSheet:
//  1. the absolute Y cascade omitted the book-progress bar's box, crowding the
//     title into the scrubber and clipping the bottom pill;
//  2. the hand-summed content-block height drifted from the cascade it was
//     supposed to mirror, mis-centering the tablet block.
// These tests pin the invariants so CI catches the next drift.
import {
  computePlayerLayout,
  MIN_ADAPTIVE_COVER,
  MIN_COMPACT_COVER,
  PEEK_HANDLE_H,
  PlayerLayoutInput,
} from "../../utils/playerLayout";

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
      "%s: CHAPTER_PROGRESS_Y with the book bar ON exceeds OFF by exactly the book-row box",
      (_name, dims) => {
        // Compare on a phone-style fixed anchor: on tablets extraTop shifts the
        // whole cascade too, so measure relative to BOOK_PROGRESS_Y (the bar
        // block top), which pins the same anchor in both modes.
        const on = computePlayerLayout({ ...dims, showBookProgress: true });
        const off = computePlayerLayout({ ...dims, showBookProgress: false });
        const onDelta = on.CHAPTER_PROGRESS_Y - on.BOOK_PROGRESS_Y;
        const offDelta = off.CHAPTER_PROGRESS_Y - off.BOOK_PROGRESS_Y;
        expect(onDelta - offDelta).toBe(on.BOOK_BAR_BOX - off.BOOK_BAR_BOX);
        // And the raw numbers: ON inserts the 20dp book row (wave + inline
        // labels) plus the gap to the scrubber — 32dp at the design rhythm,
        // 28dp when the compact pass tightened BARS_GAP to 8.
        expect(on.BOOK_BAR_BOX).toBe(on.BOOK_ROW_H + on.BARS_GAP);
        expect(on.BOOK_BAR_BOX).toBe(on.compact ? 28 : 32);
        expect(off.BOOK_BAR_BOX).toBe(0);
        expect(onDelta - offDelta).toBe(on.BOOK_BAR_BOX);
        // The scrubber's marginTop reconciles both modes: under the book row
        // it's BARS_GAP; directly under the cover it's COVER_TO_BARS.
        expect(on.SCRUBBER_TOP_GAP).toBe(on.BARS_GAP);
        expect(off.SCRUBBER_TOP_GAP).toBe(off.COVER_TO_BARS);
      }
    );

    it("on phones (no extraTop) the absolute CHAPTER_PROGRESS_Y itself shifts by the same 32dp", () => {
      const on = computePlayerLayout(phone({ showBookProgress: true }));
      const off = computePlayerLayout(phone({ showBookProgress: false }));
      expect(on.extraTop).toBe(0);
      expect(off.extraTop).toBe(0);
      expect(on.CHAPTER_PROGRESS_Y - off.CHAPTER_PROGRESS_Y).toBe(32);
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
        // Cover → bar block: mirrors the component's book-row marginTop
        // (BOOK_PROGRESS_Y - COVER_Y_EXP - COVER_SIZE_EXP). The old separate
        // numeric info row is gone — labels are inline on the bars.
        expect(l.BOOK_PROGRESS_Y - l.COVER_Y_EXP - l.COVER_SIZE_EXP).toBe(l.COVER_TO_BARS);
        // Bar block top → scrubber: the book row's whole box when shown,
        // nothing when hidden (the scrubber IS the bar block then). The box
        // is 20 + BARS_GAP — 32 at the design rhythm, 28 compact.
        expect(l.CHAPTER_PROGRESS_Y - l.BOOK_PROGRESS_Y).toBe(l.BOOK_BAR_BOX);
        expect(l.CHAPTER_PROGRESS_Y - l.BOOK_PROGRESS_Y).toBe(
          showBookProgress ? 20 + l.BARS_GAP : 0
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
    it("a short 360x640 phone COMPRESSES instead of scrolling (the display-scale screenshot)", () => {
      // Pre-ladder behavior: this class of screen kept the natural cover and
      // flipped scrolling on — which parked the transport under the chapters
      // peek with nothing hinting that scrolling was even possible (the field
      // screenshot at large display size). The compact pass now tightens the
      // rhythm and shrinks the cover until everything fits above the peek.
      const l = computePlayerLayout({
        screenWidth: 360,
        screenHeight: 640,
        insetTop: 24,
        insetBottom: 0,
        showBookProgress: true,
      });
      expect(l.compact).toBe(true);
      expect(l.contentOverflows).toBe(false);
      expect(l.COVER_SIZE_EXP).toBeGreaterThanOrEqual(MIN_COMPACT_COVER);
      expect(l.contentBottomY + 8).toBeLessThanOrEqual(640 - 0 - PEEK_HANDLE_H);
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

    it("walks the compression ladder as the viewport shrinks: normal → compact → scroll", () => {
      // 412-wide phone, insets 24/0. Rung 1: the design rhythm holds while
      // the cover can absorb the missing height down to MIN_ADAPTIVE_COVER.
      // One dp below that, rung 2: the compact rhythm engages (tighter gaps,
      // smaller transport/pill) — the freed height even lets the cover grow
      // back past the rung-1 floor. Rung 3: only when the compact rhythm
      // can't fit the cover at MIN_COMPACT_COVER does scrolling turn on, with
      // the cover pinned at the floor (not snapped back to natural) so the
      // scrolled-away remainder stays small.
      const at = (screenHeight: number) =>
        computePlayerLayout({ screenWidth: 412, screenHeight, insetTop: 24, insetBottom: 0, showBookProgress: true });
      expect(at(744).compact).toBe(false);
      expect(at(744).COVER_SIZE_EXP).toBe(MIN_ADAPTIVE_COVER); // rung-1 floor
      expect(at(744).contentOverflows).toBe(false);
      expect(at(743).compact).toBe(true); // rung 2 engages
      expect(at(743).contentOverflows).toBe(false);
      expect(at(743).COVER_SIZE_EXP).toBeGreaterThanOrEqual(MIN_ADAPTIVE_COVER);
      expect(at(624).compact).toBe(true);
      expect(at(624).COVER_SIZE_EXP).toBe(MIN_COMPACT_COVER); // rung-2 floor
      expect(at(624).contentOverflows).toBe(false);
      expect(at(623).compact).toBe(true); // rung 3: floor + scroll
      expect(at(623).COVER_SIZE_EXP).toBe(MIN_COMPACT_COVER);
      expect(at(623).contentOverflows).toBe(true);
    });

    it("bottom-inset flip: 3-button nav (48) shrinks the cover instead of overflowing", () => {
      // Pre-adaptive behavior: the 48dp inset pushed the pill under the peek
      // and flipped scrolling on. Now the cover absorbs exactly the inset
      // difference and both configurations fit without scrolling.
      const dims = { screenWidth: 412, screenHeight: 820, insetTop: 24, showBookProgress: true };
      const gesture = computePlayerLayout({ ...dims, insetBottom: 0 });
      const buttons = computePlayerLayout({ ...dims, insetBottom: 48 });
      expect(gesture.contentOverflows).toBe(false);
      expect(buttons.contentOverflows).toBe(false);
      expect(gesture.COVER_SIZE_EXP - buttons.COVER_SIZE_EXP).toBe(48);
      expect(buttons.COVER_SIZE_EXP).toBeGreaterThanOrEqual(MIN_ADAPTIVE_COVER);
    });

    it("hiding the book bar frees exactly 32dp of cascade height", () => {
      const on = computePlayerLayout(phone({ showBookProgress: true }));
      const off = computePlayerLayout(phone({ showBookProgress: false }));
      expect(on.CONTENT_BLOCK_H - off.CONTENT_BLOCK_H).toBe(32);
      expect(on.contentBottomY - off.contentBottomY).toBe(32);
    });
  });

  describe("chapters-sheet peek budgeting (the foldable fix)", () => {
    // The chapters/queue sheet permanently peeks PEEK_HANDLE_H above the
    // bottom inset while the player is expanded. The original bug: every fit
    // bound stopped at the safe-area bottom, so near-square screens (foldables
    // unfolded) parked the transport/pill UNDER the peeking sheet with
    // scrolling still off — invisible and unreachable.
    it.each(devices)(
      "%s: whenever scrolling stays off, the pill clears the peek, both modes",
      (_name, dims) => {
        for (const showBookProgress of [true, false]) {
          const l = computePlayerLayout({ ...dims, showBookProgress });
          if (!l.contentOverflows) {
            expect(l.contentBottomY + 8).toBeLessThanOrEqual(
              dims.screenHeight - dims.insetBottom - PEEK_HANDLE_H
            );
          }
        }
      }
    );

    it("foldable inner 673x841: the cover shrinks to fit and nothing scrolls", () => {
      const l = computePlayerLayout({
        screenWidth: 673,
        screenHeight: 841,
        insetTop: 24,
        insetBottom: 24,
        showBookProgress: true,
      });
      // The natural cover (min(400, 42% of height, 420) = 353) can't fit above
      // the peek here; the adaptive size fills the room exactly instead.
      const natural = Math.min(480 - 80, Math.round(841 * 0.42), 420);
      expect(l.COVER_SIZE_EXP).toBeLessThan(natural);
      expect(l.COVER_SIZE_EXP).toBeGreaterThanOrEqual(MIN_ADAPTIVE_COVER);
      expect(l.COVER_SIZE_EXP).toBe(Math.floor(l.availH - (l.CONTENT_BLOCK_H - l.COVER_SIZE_EXP)));
      expect(l.contentOverflows).toBe(false);
    });

    it("adaptive sizing never touches screens whose natural cover already fits", () => {
      for (const dims of [phone(), tablet()]) {
        const l = computePlayerLayout(dims);
        const natural = Math.min(
          Math.min(dims.screenWidth, 480) - 80,
          Math.round(dims.screenHeight * 0.42),
          Math.min(dims.screenWidth, dims.screenHeight) >= 600 ? 420 : 320
        );
        expect(l.COVER_SIZE_EXP).toBe(natural);
      }
    });
  });

  describe("tablet vertical centering", () => {
    it("extraTop = max(0, floor((availH - CONTENT_BLOCK_H) / 2)) on tablets", () => {
      const l = computePlayerLayout(tablet());
      expect(l.isTablet).toBe(true);
      // Below the top bar (24+8+56) and the source-label rhythm (12+20+8),
      // above the bottom inset + the chapters sheet's peek + 8dp slack.
      const expectedAvail = 1280 - (24 + 8 + 56) - (12 + 20 + 8) - 24 - PEEK_HANDLE_H - 8;
      expect(l.availH).toBe(expectedAvail);
      expect(l.extraTop).toBe(Math.max(0, Math.floor((expectedAvail - l.CONTENT_BLOCK_H) / 2)));
      expect(l.extraTop).toBeGreaterThan(0);
      // The centering must feed the cascade: the source label shifts by extraTop.
      const base = computePlayerLayout(tablet());
      expect(base.SOURCE_LABEL_Y).toBe(base.TOP_BAR_Y + 56 + 12 + base.extraTop);
    });

    it("squat 800x760 tablet: the compact pass makes the block fit exactly (extraTop 0)", () => {
      // Pre-ladder this was the extraTop-clamp case (natural cover + scroll).
      // The compact rhythm now absorbs the shortfall — the cover fills the
      // remaining room to the dp, so there is nothing left to center.
      const l = computePlayerLayout({
        screenWidth: 800,
        screenHeight: 760,
        insetTop: 24,
        insetBottom: 24,
        showBookProgress: true,
      });
      expect(l.isTablet).toBe(true);
      expect(l.compact).toBe(true);
      expect(l.contentOverflows).toBe(false);
      expect(l.CONTENT_BLOCK_H).toBeLessThanOrEqual(l.availH);
      expect(l.extraTop).toBe(Math.floor((l.availH - l.CONTENT_BLOCK_H) / 2));
    });

    it("extraTop is clamped to 0 when even the compact block cannot fit (squat 800x640)", () => {
      const l = computePlayerLayout({
        screenWidth: 800,
        screenHeight: 640,
        insetTop: 24,
        insetBottom: 24,
        showBookProgress: true,
      });
      expect(l.isTablet).toBe(true);
      expect(l.compact).toBe(true);
      expect(l.availH).toBeLessThan(l.CONTENT_BLOCK_H);
      expect(l.extraTop).toBe(0);
      expect(l.contentOverflows).toBe(true);
    });

    it("phones never get extraTop", () => {
      for (const showBookProgress of [true, false]) {
        expect(computePlayerLayout(phone({ showBookProgress })).extraTop).toBe(0);
      }
    });

    it("centering is book-bar-aware: toggling the bar changes tablet extraTop by half the freed height", () => {
      const on = computePlayerLayout(tablet({ showBookProgress: true }));
      const off = computePlayerLayout(tablet({ showBookProgress: false }));
      expect(off.extraTop - on.extraTop).toBe(16); // 32dp freed, half above
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
      // 360x640 is a compact-mode screen now: the cover is fitted to the
      // remaining room (availH minus the compact below-cover stack), not the
      // natural height-limited size.
      const small = computePlayerLayout(phone({ screenWidth: 360, screenHeight: 640, insetBottom: 0 }));
      expect(small.compact).toBe(true);
      expect(small.COVER_SIZE_EXP).toBe(
        Math.floor(small.availH - (small.CONTENT_BLOCK_H - small.COVER_SIZE_EXP))
      );
      expect(small.COVER_SIZE_EXP).toBeGreaterThanOrEqual(MIN_COMPACT_COVER);
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

  describe("transport geometry (the display-scale overflow fix)", () => {
    // The design row — side 56 / play 88 / 16dp gaps, centered on the play
    // button — spans 376dp. Display-size scaling drops the dp width below
    // that, and the old hardcoded offsets ran the skip buttons off BOTH
    // screen edges (the field screenshot). The row now scales as one unit.
    it("roomy columns reproduce the original hardcoded design geometry bit-for-bit", () => {
      for (const dims of [phone(), tablet()]) {
        const l = computePlayerLayout(dims);
        expect(l.SIDE_BTN).toBe(56);
        expect(l.PLAY_BTN).toBe(88);
        expect(l.T_GAP).toBe(16);
        expect(l.SIDE_TOP).toBe(16);
        expect(l.TRANSPORT_H).toBe(88);
        // The legacy expressions, verbatim:
        expect(l.PLAY_X).toBe(l.PX + (l.PW - 88) / 2);
        expect(l.JUMP_BACK_X).toBe(l.PX + (l.PW - 88) / 2 - 72);
        expect(l.SKIP_PREV_X).toBe(l.PX + (l.PW - 88) / 2 - 144);
        expect(l.JUMP_FWD_X).toBe(l.PX + (l.PW - 88) / 2 + 104);
        expect(l.SKIP_NEXT_X).toBe(l.PX + (l.PW - 88) / 2 + 176);
      }
    });

    it.each([
      ["display-scaled 320dp", 320],
      ["display-scaled 340dp", 340],
      ["display-scaled 360dp", 360],
      ["compact 412dp", 412],
    ])("%s column: the whole row stays inside the column with margin", (_n, screenWidth) => {
      const l = computePlayerLayout({
        screenWidth,
        screenHeight: 640,
        insetTop: 24,
        insetBottom: 0,
        showBookProgress: true,
      });
      // Left and right edges clear the column by the 8dp breathing room.
      expect(l.SKIP_PREV_X).toBeGreaterThanOrEqual(l.PX + 8 - 1);
      expect(l.SKIP_NEXT_X + l.SIDE_BTN).toBeLessThanOrEqual(l.PX + l.PW - 8 + 1);
      // Touch targets stay legal, play stays dominant.
      expect(l.SIDE_BTN).toBeGreaterThanOrEqual(44);
      expect(l.PLAY_BTN).toBeGreaterThanOrEqual(56);
      expect(l.PLAY_BTN).toBeGreaterThan(l.SIDE_BTN);
      // The row is symmetric around the column center.
      const center = l.PX + l.PW / 2;
      expect(l.PLAY_X + l.PLAY_BTN / 2).toBeCloseTo(center, 5);
      expect(center - l.SKIP_PREV_X).toBeCloseTo(l.SKIP_NEXT_X + l.SIDE_BTN - center, 5);
      // Row height always equals the play button.
      expect(l.TRANSPORT_H).toBe(l.PLAY_BTN);
      expect(l.SIDE_TOP).toBe(Math.round((l.PLAY_BTN - l.SIDE_BTN) / 2));
    });

    it("gaps never exceed the 16dp design gap on ultra-wide columns", () => {
      const l = computePlayerLayout(tablet({ screenWidth: 1200 }));
      expect(l.T_GAP).toBe(16);
    });
  });

  describe("compact rhythm values", () => {
    it("compact mode tightens exactly the intended knobs and nothing else", () => {
      const c = computePlayerLayout({
        screenWidth: 360,
        screenHeight: 640,
        insetTop: 24,
        insetBottom: 0,
        showBookProgress: true,
      });
      expect(c.compact).toBe(true);
      expect(c.COVER_TO_BARS).toBe(10);
      expect(c.BARS_GAP).toBe(8);
      expect(c.SCRUBBER_TO_TITLE).toBe(12);
      expect(c.TITLE_TO_TRANSPORT).toBe(8);
      expect(c.TRANSPORT_TO_PILL).toBe(8);
      expect(c.PILL_H).toBe(48);
      // Never-compressed: source rhythm, scrubber touch target, title text box.
      expect(c.TOPBAR_TO_SOURCE).toBe(12);
      expect(c.SOURCE_LABEL_H).toBe(20);
      expect(c.SOURCE_TO_COVER).toBe(8);
      expect(c.SCRUBBER_H).toBe(36);
      expect(c.TITLE_H).toBe(64);
      // Compact transport shrinks toward the 48/72 ideals.
      expect(c.PLAY_BTN).toBeLessThanOrEqual(72);
      expect(c.SIDE_BTN).toBeLessThanOrEqual(48);
    });

    it("roomy screens never see the compact rhythm (design values pinned)", () => {
      for (const dims of [phone(), tablet()]) {
        const l = computePlayerLayout(dims);
        expect(l.compact).toBe(false);
        expect(l.COVER_TO_BARS).toBe(14);
        expect(l.BARS_GAP).toBe(12);
        expect(l.SCRUBBER_TO_TITLE).toBe(20);
        expect(l.TITLE_TO_TRANSPORT).toBe(12);
        expect(l.TRANSPORT_TO_PILL).toBe(12);
        expect(l.PILL_H).toBe(56);
      }
    });
  });

  describe("landscape transport pane sizing", () => {
    it("the pane budget matches the component's padding arithmetic", () => {
      const l = computePlayerLayout({
        screenWidth: 915,
        screenHeight: 412,
        insetTop: 0,
        insetBottom: 24,
        showBookProgress: true,
      });
      // outer 16dp paddings (32) + cover column (LS_COVER + 16) + pane 8dp
      // paddings (16) — the component's landscape two-pane layout, verbatim.
      expect(l.LS_PANE_W).toBe(915 - 32 - (l.LS_COVER + 16) - 16);
    });

    it.each([
      ["phone landscape 915x412", { screenWidth: 915, screenHeight: 412, insetTop: 0, insetBottom: 24 }],
      ["short scaled landscape 640x330", { screenWidth: 640, screenHeight: 330, insetTop: 0, insetBottom: 0 }],
      ["narrow scaled landscape 592x296", { screenWidth: 592, screenHeight: 296, insetTop: 0, insetBottom: 0 }],
      ["tablet landscape 1280x800", { screenWidth: 1280, screenHeight: 800, insetTop: 24, insetBottom: 24 }],
    ])("%s: the 5-button row fits the pane", (_n, dims) => {
      const l = computePlayerLayout({ ...dims, showBookProgress: true });
      const rowSpan = 4 * l.LS_SIDE_BTN + l.LS_PLAY_BTN + 4 * l.LS_T_GAP;
      expect(rowSpan).toBeLessThanOrEqual(l.LS_PANE_W);
      expect(l.LS_SIDE_BTN).toBeGreaterThanOrEqual(44);
      expect(l.LS_PLAY_BTN).toBeGreaterThanOrEqual(56);
    });
  });
});
