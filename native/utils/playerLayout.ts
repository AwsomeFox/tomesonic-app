// Pure layout math for the expanded player (PlayerBottomSheet). The expanded
// sheet renders an ABSOLUTE Y cascade (source label → cover → progress bars →
// title → transport → pill) plus mirrored in-flow placeholders, and two recent
// device-only bugs were pure arithmetic hiding in that cascade (the book-
// progress bar's box being omitted crowded the title and clipped the bottom
// pill). Extracting the math here makes it unit-testable so CI catches the
// next drift. The component styles its views from these fields ONLY — never
// re-hardcoded literals — so the cascade, the in-flow placeholders, and the
// transport button geometry can't disagree.

/**
 * Height of the chapters/queue sheet's collapsed "Chapters & Up Next" handle.
 * The sheet permanently peeks (PEEK_HANDLE_H + insetBottom) above the screen
 * bottom while the player is expanded, so every "does the cascade fit"
 * question in this module ends at the TOP of that peek — not at the safe-area
 * bottom. Defined in this pure module so the layout math and the components
 * (PlayerChaptersQueueSheet renders the handle, PlayerBottomSheet budgets
 * padding under it) can never disagree about the number.
 */
export const PEEK_HANDLE_H = 54;

/**
 * Floor for the adaptive cover in the NORMAL (design-rhythm) pass: the cover
 * shrinks to absorb missing height, but not below this. When even this floor
 * can't fit, the layout does not jump straight to scrolling any more — it
 * first compresses (see the compact pass below).
 */
export const MIN_ADAPTIVE_COVER = 220;

/**
 * Floor for the adaptive cover in the COMPACT pass. Below this the art reads
 * as a thumbnail; screens that can't fit even this keep a floor-sized cover
 * and fall back to scrolling (contentOverflows).
 */
export const MIN_COMPACT_COVER = 148;

export interface PlayerLayoutInput {
  /** Effective screen width in dp (the component's measured?.w ?? window.width). */
  screenWidth: number;
  /** Effective screen height in dp (the component's measured?.h ?? window.height). */
  screenHeight: number;
  /** Safe-area top inset (insets.top). */
  insetTop: number;
  /** Safe-area bottom inset (insets.bottom). */
  insetBottom: number;
  /**
   * Whether the overall book progress bar is shown. The component computes
   * this as `showPlayerBookProgress !== false` (undefined defaults to true).
   */
  showBookProgress: boolean;
}

export interface PlayerLayout {
  /** min(screenWidth, screenHeight) >= 600 — tablet gets vertical centering. */
  isTablet: boolean;
  /** Landscape cover edge: fits the (short) height, capped by width. */
  LS_COVER: number;
  /** Landscape right-pane inner width (the transport row's budget there). */
  LS_PANE_W: number;
  /** Landscape transport: side (skip/jump) button edge. */
  LS_SIDE_BTN: number;
  /** Landscape transport: play button edge. */
  LS_PLAY_BTN: number;
  /** Landscape transport: gap between buttons. */
  LS_T_GAP: number;
  /** Content column width (capped at 480 so tablets stay balanced). */
  PW: number;
  /** Content column left inset ((screenWidth - PW) / 2). */
  PX: number;
  /**
   * Expanded cover edge length. Natural size (column/height/tablet-capped),
   * adaptively shrunk to fit — through the normal pass (floor
   * MIN_ADAPTIVE_COVER), then the compact pass (floor MIN_COMPACT_COVER) —
   * before the scroll fallback ever engages.
   */
  COVER_SIZE_EXP: number;
  /** Top bar (collapse/cast/overflow row) top Y. */
  TOP_BAR_Y: number;

  /**
   * True when the COMPACT pass is in effect: the design rhythm could not fit
   * the cover at MIN_ADAPTIVE_COVER (display-size scaling, near-square
   * foldables, short phones), so gaps tighten and the transport/pill shrink.
   * Every field below already reflects it — the component just styles from
   * the fields as always.
   */
  compact: boolean;

  // Transport geometry (portrait absolute cascade). The design row —
  // side 56 / play 88 / 16dp gaps, centered on the play button — spans 376dp
  // and simply ran off BOTH screen edges once display-size scaling dropped
  // the dp width below that (the field screenshot: skip prev/next half
  // off-screen). One uniform scale shrinks the whole row to the column, with
  // floors that keep touch targets legal.
  /** Side (skip/jump) button edge length. 56 at design size. */
  SIDE_BTN: number;
  /** Play button edge length. 88 at design size (72 compact). */
  PLAY_BTN: number;
  /** Gap between transport buttons. 16 at design size. */
  T_GAP: number;
  /** Side buttons' top offset inside the row ((PLAY_BTN - SIDE_BTN) / 2). */
  SIDE_TOP: number;
  /** Absolute X of each transport button (left edges, centered on play). */
  SKIP_PREV_X: number;
  JUMP_BACK_X: number;
  PLAY_X: number;
  JUMP_FWD_X: number;
  SKIP_NEXT_X: number;

  // In-flow vertical rhythm — the exact box each section occupies
  // (marginTop + height). The absolute cascade AND the tablet centering
  // height are BOTH derived from these, and the component styles its in-flow
  // views from these SAME fields (never re-hardcoded literals), so the two
  // coordinate systems can't drift. Compact mode changes the VALUES here;
  // the structure is identical.
  /** Top bar bottom → source label gap (the label's marginTop, sans extraTop). */
  TOPBAR_TO_SOURCE: number;
  /** Source label row height. */
  SOURCE_LABEL_H: number;
  /** Source label bottom → cover top gap. */
  SOURCE_TO_COVER: number;
  /**
   * Cover bottom → first progress-bar row gap. The old separate numeric info
   * row is gone — each bar now carries its elapsed/remaining labels INLINE
   * (flanking the wave), so the bar rows take the numeric row's place in the
   * cascade (with their own gap value, not the old row's exact offset).
   */
  COVER_TO_BARS: number;
  /** Book bar row height — wave + inline flanking time labels (when shown). */
  BOOK_ROW_H: number;
  /** The book WavyProgress wave height inside its row. */
  BOOK_BAR_H: number;
  /** Book row bottom → chapter scrubber row gap (when the book row is shown). */
  BARS_GAP: number;
  /** The book row's whole box (BOOK_ROW_H + BARS_GAP) — 0 when hidden. */
  BOOK_BAR_BOX: number;
  /**
   * The chapter scrubber row's marginTop: BARS_GAP under the book row, or
   * COVER_TO_BARS directly under the cover when the book row is hidden. One
   * exported delta so the component never re-encodes the ternary.
   */
  SCRUBBER_TOP_GAP: number;
  /** Chapter scrubber row height (wave + inline flanking labels). */
  SCRUBBER_H: number;
  /** Bars → title gap (both modes). */
  SCRUBBER_TO_TITLE: number;
  /**
   * Title + author (+ chapter caption) block height. FIXED, not font-scale
   * aware: the rows inside it cap their text with maxFontSizeMultiplier 1.3,
   * which is the assumption that keeps a fixed 64dp box sufficient. (fontScale
   * is deliberately NOT an input here; the component separately guards runaway
   * real-world text via its measured-overflow/scroll fallback.) Kept at 64
   * even in compact mode — text safety beats density.
   */
  TITLE_H: number;
  /** Title → transport gap. */
  TITLE_TO_TRANSPORT: number;
  /** Transport control row height (== PLAY_BTN). */
  TRANSPORT_H: number;
  /** Transport → bottom pill gap. */
  TRANSPORT_TO_PILL: number;
  /** Bottom pill (speed / sleep / bookmark) height. */
  PILL_H: number;

  /** Height of the cover→pill block (sum of the deltas above). */
  CONTENT_BLOCK_H: number;
  /**
   * Vertical space available for the cover→pill block: below the top bar and
   * source-label rhythm, above the chapters sheet's permanent peek handle.
   */
  availH: number;
  /** Tablet-only extra top margin that vertically centers the block. */
  extraTop: number;

  // Absolute overlay Y cascade.
  SOURCE_LABEL_Y: number;
  COVER_Y_EXP: number;
  /** Top of the book bar row (== scrubber top when the book row is hidden). */
  BOOK_PROGRESS_Y: number;
  CHAPTER_PROGRESS_Y: number;
  TITLE_Y_EXP: number;
  TRANSPORT_Y_EXP: number;

  /** Bottom edge of the in-flow block (pill bottom). */
  contentBottomY: number;
  /**
   * True when the cascade runs past the visible viewport EVEN AFTER the
   * compact pass — the component then re-enables ScrollView scrolling so the
   * bottom pill stays reachable.
   */
  contentOverflows: boolean;
}

/**
 * Uniformly scale a 5-button transport row (side, side, play, side, side with
 * equal gaps) into `colWidth`, keeping 8dp of breathing room each side. Floors
 * keep the buttons legal touch targets (44dp) and the play button dominant
 * (56dp); whatever width the floors reclaim comes out of the gaps (floor 6).
 * The gap never exceeds the design 16dp — extra room stays as margin, so a
 * roomy column reproduces the design geometry bit-for-bit.
 */
function transportGeometry(colWidth: number, idealSide: number, idealPlay: number) {
  const idealGap = 16;
  const inner = colWidth - 16;
  const ideal = 4 * idealSide + idealPlay + 4 * idealGap;
  const s = Math.min(1, inner / ideal);
  const side = Math.max(44, Math.round(idealSide * s));
  const play = Math.max(56, Math.round(idealPlay * s));
  const gap = Math.min(idealGap, Math.max(6, Math.floor((inner - 4 * side - play) / 4)));
  return { side, play, gap };
}

export function computePlayerLayout({
  screenWidth,
  screenHeight,
  insetTop,
  insetBottom,
  showBookProgress,
}: PlayerLayoutInput): PlayerLayout {
  // Responsive layout for the expanded player. Rather than stretching edge to
  // edge, the content lives in a centered, max-width column (PW) so it stays
  // balanced on tablets (Pixel Tablet portrait is ~800dp wide); on phones PW ==
  // screenWidth so nothing changes. On tablets the whole block is also centered
  // vertically instead of anchored to the top.
  const isTablet = Math.min(screenWidth, screenHeight) >= 600;
  // Landscape cover: sized to fit the (short) height, capped by width. Budget
  // the 56px top bar + margins — the old 48px budget let the vertically-
  // centered cover overflow up underneath the collapse button on phones.
  const LS_COVER = Math.round(
    Math.min(screenHeight - insetTop - insetBottom - 56 - 32, screenWidth * 0.42)
  );
  // Landscape right pane's inner width: full width minus the outer 16dp
  // horizontal paddings, the cover column (LS_COVER + 16), and the pane's own
  // 8dp horizontal paddings. The landscape transport row is sized INTO this —
  // its old fixed 56/56/72/56/56 + 16dp gaps span (360dp) overflowed the pane
  // on short display-scaled landscapes.
  const LS_PANE_W = screenWidth - 32 - (LS_COVER + 16) - 16;
  const lsT = transportGeometry(LS_PANE_W, 56, 72);
  const LS_SIDE_BTN = lsT.side;
  const LS_PLAY_BTN = lsT.play;
  const LS_T_GAP = lsT.gap;
  const PW = Math.min(screenWidth, 480); // content column width
  const PX = (screenWidth - PW) / 2; // column left inset
  const TOP_BAR_Y = insetTop + 8;

  // Vertical space the cover→pill block may occupy: below the top bar and the
  // source-label rhythm, above the chapters sheet's PERMANENT peek handle
  // (PEEK_HANDLE_H above the bottom inset), with 8dp breathing room. Budgeting
  // the peek here is the foldable fix: near-square screens used to park the
  // transport/pill under the peeking sheet because every bound stopped at the
  // safe-area bottom. This is also the tablet-centering denominator, so a
  // centered block stays inside the same bounds the fit check uses.
  // (The source rhythm — 12 + 20 + 8 — is mode-independent, so availH is too.)
  const TOPBAR_TO_SOURCE = 12;          // top bar bottom → source label
  const SOURCE_LABEL_H = 20;            // source label row
  const SOURCE_TO_COVER = 8;            // source label bottom → cover top
  const availH =
    screenHeight - (TOP_BAR_Y + 56) -
    (TOPBAR_TO_SOURCE + SOURCE_LABEL_H + SOURCE_TO_COVER) -
    insetBottom - PEEK_HANDLE_H - 8;

  // Natural cover (the old sizing) — what a roomy screen shows.
  const naturalCover = Math.min(PW - 80, Math.round(screenHeight * 0.42), isTablet ? 420 : 320);

  // The rhythm + transport + pill for one mode. Compact tightens the gaps and
  // shrinks the transport/pill — it is the SECOND lever, pulled only when the
  // normal pass can't fit the cover at MIN_ADAPTIVE_COVER (display-size
  // scaling, near-square foldables). SOURCE rhythm, SCRUBBER_H (touch target)
  // and TITLE_H (text safety) never change.
  const modeMetrics = (compact: boolean) => {
    const t = transportGeometry(PW, compact ? 48 : 56, compact ? 72 : 88);
    const COVER_TO_BARS = compact ? 10 : 14;
    const BOOK_ROW_H = 20;
    const BARS_GAP = compact ? 8 : 12;
    const BOOK_BAR_BOX = showBookProgress ? BOOK_ROW_H + BARS_GAP : 0;
    const SCRUBBER_H = 36;
    const SCRUBBER_TO_TITLE = compact ? 12 : 20;
    const TITLE_H = 64;
    const TITLE_TO_TRANSPORT = compact ? 8 : 12;
    const TRANSPORT_H = t.play;
    const TRANSPORT_TO_PILL = compact ? 8 : 12;
    const PILL_H = compact ? 48 : 56;
    // Everything below the cover, summed. The cover is the block's one
    // flexible box — this fixed remainder is what the adaptive sizing
    // subtracts out.
    const BELOW_COVER_H =
      COVER_TO_BARS + BOOK_BAR_BOX +
      SCRUBBER_H + SCRUBBER_TO_TITLE + TITLE_H + TITLE_TO_TRANSPORT + TRANSPORT_H +
      TRANSPORT_TO_PILL + PILL_H;
    return {
      t, COVER_TO_BARS, BOOK_ROW_H, BARS_GAP, BOOK_BAR_BOX, SCRUBBER_H,
      SCRUBBER_TO_TITLE, TITLE_H, TITLE_TO_TRANSPORT, TRANSPORT_H,
      TRANSPORT_TO_PILL, PILL_H, BELOW_COVER_H,
    };
  };

  // The compression ladder: normal rhythm with the cover shrunk to fit
  // (floor MIN_ADAPTIVE_COVER) → compact rhythm with the cover shrunk further
  // (floor MIN_COMPACT_COVER) → compact rhythm at the floor + scrolling.
  // Before the ladder, screens that failed the first rung jumped straight to
  // "natural cover + scroll" — which parked the transport under the chapters
  // peek with nothing hinting that scrolling was even possible.
  const normal = modeMetrics(false);
  const fittedNormal = Math.floor(availH - normal.BELOW_COVER_H);
  const compact = fittedNormal < MIN_ADAPTIVE_COVER;
  const m = compact ? modeMetrics(true) : normal;
  const fitted = compact ? Math.floor(availH - m.BELOW_COVER_H) : fittedNormal;
  const COVER_SIZE_EXP = Math.min(
    naturalCover,
    Math.max(fitted, compact ? MIN_COMPACT_COVER : MIN_ADAPTIVE_COVER)
  );

  const {
    COVER_TO_BARS, BOOK_ROW_H, BARS_GAP, BOOK_BAR_BOX, SCRUBBER_H,
    SCRUBBER_TO_TITLE, TITLE_H, TITLE_TO_TRANSPORT, TRANSPORT_H,
    TRANSPORT_TO_PILL, PILL_H, BELOW_COVER_H,
  } = m;
  const BOOK_BAR_H = 12; // the book wave's own height inside the row
  const SCRUBBER_TOP_GAP = showBookProgress ? BARS_GAP : COVER_TO_BARS;

  // Transport button geometry, centered on the play button. On any column
  // ≥ 392dp this reproduces the original hardcoded design positions exactly
  // (play at PX+(PW-88)/2, jumps ±72/+104, skips ±144/+176).
  const SIDE_BTN = m.t.side;
  const PLAY_BTN = m.t.play;
  const T_GAP = m.t.gap;
  const SIDE_TOP = Math.round((PLAY_BTN - SIDE_BTN) / 2);
  const PLAY_X = PX + (PW - PLAY_BTN) / 2;
  const JUMP_BACK_X = PLAY_X - T_GAP - SIDE_BTN;
  const SKIP_PREV_X = JUMP_BACK_X - T_GAP - SIDE_BTN;
  const JUMP_FWD_X = PLAY_X + PLAY_BTN + T_GAP;
  const SKIP_NEXT_X = JUMP_FWD_X + SIDE_BTN + T_GAP;

  // Height of the cover→pill block, used to vertically center it on tablets.
  // Derived from the same deltas as the cascade so it stays book-bar-aware.
  const CONTENT_BLOCK_H = COVER_SIZE_EXP + BELOW_COVER_H;
  // Floored so centering can never push a block that exactly fits half a dp
  // past the fit boundary on fractionally-measured screens.
  const extraTop = isTablet ? Math.max(0, Math.floor((availH - CONTENT_BLOCK_H) / 2)) : 0;
  const SOURCE_LABEL_Y = TOP_BAR_Y + 56 + TOPBAR_TO_SOURCE + extraTop;
  const COVER_Y_EXP = SOURCE_LABEL_Y + SOURCE_LABEL_H + SOURCE_TO_COVER;
  // Top of the book bar row. When the book row is hidden this is where the
  // chapter scrubber sits instead (BOOK_BAR_BOX is 0 in that mode).
  const BOOK_PROGRESS_Y = COVER_Y_EXP + COVER_SIZE_EXP + COVER_TO_BARS;
  // Scrubber top: directly under the cover, or under the book row's box.
  // (The scrubber's own SCRUBBER_TOP_GAP marginTop in the component
  // reconciles both cases against this.)
  const CHAPTER_PROGRESS_Y = BOOK_PROGRESS_Y + BOOK_BAR_BOX;
  const TITLE_Y_EXP = CHAPTER_PROGRESS_Y + SCRUBBER_H + SCRUBBER_TO_TITLE;
  const TRANSPORT_Y_EXP = TITLE_Y_EXP + TITLE_H + TITLE_TO_TRANSPORT;

  // The full-player content uses a fixed absolute cascade inside a ScrollView
  // whose scrolling is normally OFF (so the drag-to-collapse gesture runs
  // cleanly). After the compression ladder, screens can remain where the
  // cascade runs past the bottom of the VISIBLE area — which ends at the
  // chapters sheet's peek, not the screen edge — and clip the bottom pill,
  // which would then be unreachable. This estimate is geometry-only —
  // fontScale is NOT an input (rows cap their text at maxFontSizeMultiplier
  // 1.3, and the component keeps a measured-overflow fallback for anything
  // the estimate can't see). Compare the in-flow block bottom against the
  // visible viewport and re-enable scrolling ONLY when it can't fit, so
  // nothing is ever cut off; the top drag region still collapses the sheet.
  const contentBottomY = TRANSPORT_Y_EXP + TRANSPORT_H + TRANSPORT_TO_PILL + PILL_H;
  const contentOverflows = contentBottomY + 8 > screenHeight - insetBottom - PEEK_HANDLE_H;

  return {
    isTablet,
    LS_COVER,
    LS_PANE_W,
    LS_SIDE_BTN,
    LS_PLAY_BTN,
    LS_T_GAP,
    PW,
    PX,
    COVER_SIZE_EXP,
    TOP_BAR_Y,
    compact,
    SIDE_BTN,
    PLAY_BTN,
    T_GAP,
    SIDE_TOP,
    SKIP_PREV_X,
    JUMP_BACK_X,
    PLAY_X,
    JUMP_FWD_X,
    SKIP_NEXT_X,
    TOPBAR_TO_SOURCE,
    SOURCE_LABEL_H,
    SOURCE_TO_COVER,
    COVER_TO_BARS,
    BOOK_ROW_H,
    BOOK_BAR_H,
    BARS_GAP,
    BOOK_BAR_BOX,
    SCRUBBER_TOP_GAP,
    SCRUBBER_H,
    SCRUBBER_TO_TITLE,
    TITLE_H,
    TITLE_TO_TRANSPORT,
    TRANSPORT_H,
    TRANSPORT_TO_PILL,
    PILL_H,
    CONTENT_BLOCK_H,
    availH,
    extraTop,
    SOURCE_LABEL_Y,
    COVER_Y_EXP,
    BOOK_PROGRESS_Y,
    CHAPTER_PROGRESS_Y,
    TITLE_Y_EXP,
    TRANSPORT_Y_EXP,
    contentBottomY,
    contentOverflows,
  };
}
