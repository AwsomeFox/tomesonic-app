// Pure layout/navigation math for the Home bookshelf (BookshelfScreen),
// extracted so unit tests can lock the arithmetic — a past device-only bug was
// shelf overlap born from layout races, and the "see all" gating below depends
// on width callbacks that arrive in any order.
import { encodeFilterValue } from "./filters";

/**
 * Does a horizontal shelf row overflow its viewport (i.e. are there more items
 * than fit)? Drives the header's "see all" arrow.
 *
 * Viewport and content widths arrive from separate callbacks
 * (onLayout / onContentSizeChange) and in either order, so either can still be
 * 0 (unmeasured) when this runs — an unmeasured viewport is never "overflow".
 *
 * @param slack sub-pixel rounding slack (default 4dp) so an exactly-fitting
 *              row isn't reported as overflowing.
 */
export function shelfOverflows(viewportW: number, contentW: number, slack = 4): boolean {
  return viewportW > 0 && contentW > viewportW + slack;
}

// Map a personalized shelf to the Library-tab sort/filter that shows the rest
// of it (each shelf is a capped horizontal scroll, so its tail is otherwise
// unreachable). Returns null for shelves with no sensible full-list mapping —
// those stay non-pressable.
// Maps a home shelf to its "see all" destination on the Library hub tab. The hub
// consumes `filter`/`orderBy`/`descending` (seeds the Books facet) and `segment`
// (switches to the Series/Authors facet). Series/author shelves and Continue
// Reading all resolve to a destination here; a shelf with no sensible full-list
// view returns null. Returning a destination does NOT by itself make the header
// pressable — the call site also requires the row to overflow (see
// `shelfOverflows` above); a null return is what unconditionally leaves a
// header non-pressable.

/** The minimal shelf shape this mapping reads (ABS shelves carry much more). */
export interface HomeShelfLike {
  id?: string;
  type?: string;
  /** Synthetic shelves (e.g. the affinity shelf) carry an explicit destination. */
  libParams?: Record<string, any> | null;
}

export function shelfToLibraryParams(
  shelf: HomeShelfLike | null | undefined
): Record<string, any> | null {
  // Synthetic shelves (e.g. the "Because you listened" affinity shelf) can
  // carry an explicit destination — honor it before the id/type heuristics.
  if (shelf?.libParams) return shelf.libParams;
  // Series/author shelves (incl. the transformed "Continue Series") open the
  // matching browse segment rather than a books filter.
  if (shelf?.type === "series") return { segment: "series" };
  if (shelf?.type === "authors" || shelf?.type === "author") return { segment: "authors" };
  switch (shelf?.id) {
    case "recently-added":
      return { orderBy: "addedAt", descending: true };
    // The ABS "Discover" shelf is a random sampling of the library — there's no
    // "see all random books", so its see-all opens the full library browse (the
    // Library hub's Books facet, default sort) where the rest of the catalog is
    // reachable. An empty destination is truthy, so the header still becomes a
    // pressable "see all" once the row overflows (see the `showSeeAll` gate).
    case "discover":
      return {};
    // Continue Reading is in-progress books too (its rows are ebooks-in-progress;
    // ABS filters are single-valued, so "in progress" is the closest full-list
    // match) — give it the same destination as Continue Listening.
    case "continue-listening":
    case "continue-reading":
      return { filter: `progress.${encodeFilterValue("in-progress")}` };
    case "listen-again":
      return { filter: `progress.${encodeFilterValue("finished")}` };
    default:
      return null;
  }
}
