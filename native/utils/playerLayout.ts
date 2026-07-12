// Pure layout math for the expanded player (PlayerBottomSheet). The expanded
// sheet renders an ABSOLUTE Y cascade (source label → cover → progress bars →
// title → transport → pill) plus mirrored in-flow placeholders, and two recent
// device-only bugs were pure arithmetic hiding in that cascade (the book-
// progress bar's box being omitted crowded the title and clipped the bottom
// pill). Extracting the math here makes it unit-testable so CI catches the
// next drift. This is a verbatim extraction of the component's expressions —
// behavior must be IDENTICAL to what PlayerBottomSheet computed inline.

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
  /** Content column width (capped at 480 so tablets stay balanced). */
  PW: number;
  /** Content column left inset ((screenWidth - PW) / 2). */
  PX: number;
  /** Expanded cover edge length. */
  COVER_SIZE_EXP: number;
  /** Top bar (collapse/cast/overflow row) top Y. */
  TOP_BAR_Y: number;

  // In-flow vertical rhythm — the exact box each section occupies
  // (marginTop + height). The absolute cascade AND the tablet centering
  // height are BOTH derived from these, and the component styles its in-flow
  // views from these SAME fields (never re-hardcoded literals), so the two
  // coordinate systems can't drift.
  /** Top bar bottom → source label gap (the label's marginTop, sans extraTop). */
  TOPBAR_TO_SOURCE: number;
  /** Source label row height. */
  SOURCE_LABEL_H: number;
  /** Source label bottom → cover top gap. */
  SOURCE_TO_COVER: number;
  /**
   * Cover bottom → first progress-bar row gap. The old separate numeric info
   * row is gone — each bar now carries its elapsed/remaining labels INLINE
   * (flanking the wave), so the bars start where the numeric row used to.
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
   * real-world text via its measured-overflow/scroll fallback.)
   */
  TITLE_H: number;
  /** Title → transport gap. */
  TITLE_TO_TRANSPORT: number;
  /** Transport control row height. */
  TRANSPORT_H: number;
  /** Transport → bottom pill gap. */
  TRANSPORT_TO_PILL: number;
  /** Bottom pill (speed / sleep / bookmark) height. */
  PILL_H: number;

  /** Height of the cover→pill block (sum of the deltas above). */
  CONTENT_BLOCK_H: number;
  /** Vertical space available for the block below the top bar. */
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
   * True when the cascade runs past the visible viewport — the component then
   * re-enables ScrollView scrolling so the bottom pill stays reachable.
   */
  contentOverflows: boolean;
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
  const PW = Math.min(screenWidth, 480); // content column width
  const PX = (screenWidth - PW) / 2; // column left inset
  const COVER_SIZE_EXP = Math.min(PW - 80, Math.round(screenHeight * 0.42), isTablet ? 420 : 320);
  const TOP_BAR_Y = insetTop + 8;
  // In-flow vertical rhythm below the cover, expressed as the exact box each
  // section occupies (marginTop + height). The absolute-overlay Y cascade
  // (SOURCE_LABEL_Y…TRANSPORT_Y_EXP) AND the tablet-centering block height are
  // BOTH derived from these deltas, so the two coordinate systems can't drift.
  // The bars carry their time labels INLINE (elapsed left, -remaining right,
  // flanking the wave) — the old standalone numeric info row is gone. When the
  // book-progress bar is hidden its whole box (row + gap) drops out and the
  // chapter scrubber sits directly under the cover.
  const showBook = showBookProgress;
  const TOPBAR_TO_SOURCE = 12;          // top bar bottom → source label
  const SOURCE_LABEL_H = 20;            // source label row
  const SOURCE_TO_COVER = 8;            // source label bottom → cover top
  const COVER_TO_BARS = 14;             // cover bottom → first bar row
  const BOOK_ROW_H = 20;                // book bar row: wave + inline labels (when shown)
  const BOOK_BAR_H = 12;                // the book wave's own height inside the row
  const BARS_GAP = 12;                  // book row → chapter scrubber (when shown)
  const BOOK_BAR_BOX = showBook ? BOOK_ROW_H + BARS_GAP : 0;
  const SCRUBBER_TOP_GAP = showBook ? BARS_GAP : COVER_TO_BARS; // scrubber row marginTop
  const SCRUBBER_H = 36;                // chapter scrubber row
  const SCRUBBER_TO_TITLE = 20;         // comfortable bars → title gap (both modes)
  const TITLE_H = 64;                   // title+author block (text capped at maxFontSizeMultiplier 1.3 — see interface doc)
  const TITLE_TO_TRANSPORT = 12;        // title → transport gap
  const TRANSPORT_H = 88;               // transport control row
  const TRANSPORT_TO_PILL = 12;         // transport → bottom pill gap
  const PILL_H = 56;                    // bottom pill (speed / sleep / bookmark)
  // Height of the cover→pill block, used to vertically center it on tablets.
  // Derived from the same deltas as the cascade so it stays book-bar-aware.
  const CONTENT_BLOCK_H =
    COVER_SIZE_EXP + COVER_TO_BARS + BOOK_BAR_BOX +
    SCRUBBER_H + SCRUBBER_TO_TITLE + TITLE_H + TITLE_TO_TRANSPORT + TRANSPORT_H +
    TRANSPORT_TO_PILL + PILL_H;
  const availH = screenHeight - (TOP_BAR_Y + 56) - insetBottom - 20;
  const extraTop = isTablet ? Math.max(0, (availH - CONTENT_BLOCK_H) / 2) : 0;
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
  // cleanly). On short viewports (small phones) the cascade can run past the
  // bottom of the screen and clip the bottom pill, which would then be
  // unreachable. This estimate is geometry-only — fontScale is NOT an input
  // (rows cap their text at maxFontSizeMultiplier 1.3, and the component keeps
  // a measured-overflow fallback for anything the estimate can't see). Compare
  // the in-flow block bottom against the visible viewport and re-enable
  // scrolling ONLY when it can't fit, so nothing is ever cut off; the top drag
  // region still collapses the sheet.
  const contentBottomY = TRANSPORT_Y_EXP + TRANSPORT_H + TRANSPORT_TO_PILL + PILL_H;
  const contentOverflows = contentBottomY + 8 > screenHeight - insetBottom;

  return {
    isTablet,
    LS_COVER,
    PW,
    PX,
    COVER_SIZE_EXP,
    TOP_BAR_Y,
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
