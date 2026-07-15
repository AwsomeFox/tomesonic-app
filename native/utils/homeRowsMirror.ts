import { HomeRow, HomeRowItem, writeHomeRowsState } from "./autoCreds";
import { refreshHomeRowWidget } from "./widgetRefresh";

// Personalized-shelf types whose entities are NOT directly-openable library
// items (series/author/genre groupings). The home-row widget opens a book on
// tap, so these can't back it — skip them.
const NON_BOOK_SHELF_TYPES = new Set([
  "series",
  "authors",
  "author",
  "genres",
  "tags",
  "narrators",
]);

// Cap items mirrored per row — the widget list is scrollable but a full library
// of covers would bloat the state file and the per-item cover fetches.
const MAX_ITEMS_PER_ROW = 20;

function coverUrlFor(
  entity: any,
  serverAddress: string,
  token: string
): string {
  const id = entity?.id;
  if (id && serverAddress && token) {
    return `${serverAddress}/api/items/${id}/cover?width=400&format=webp&token=${token}`;
  }
  // Fall back to any absolute URL the entity already carries (rare); a relative
  // or local path is useless to the widget's HTTP fetch, so drop it.
  const cu = entity?.coverUrl;
  return typeof cu === "string" && /^https?:\/\//.test(cu) ? cu : "";
}

function titleOf(entity: any): string {
  return (
    entity?.media?.metadata?.title ||
    entity?.title ||
    entity?.name ||
    ""
  );
}

function authorOf(entity: any): string {
  const md = entity?.media?.metadata;
  if (md?.authorName) return md.authorName;
  if (Array.isArray(md?.authors)) {
    return md.authors.map((a: any) => a?.name).filter(Boolean).join(", ");
  }
  return entity?.author || "";
}

// Pure mapper: personalized shelves + server creds -> home-row widget rows.
// Keeps only book-like shelves that have a stable id, a label, and at least one
// openable item. Exported for unit testing.
export function buildHomeRows(
  shelves: any[],
  serverAddress: string,
  token: string
): HomeRow[] {
  if (!Array.isArray(shelves)) return [];
  const server = (serverAddress || "").replace(/\/$/, "");
  const rows: HomeRow[] = [];
  for (const shelf of shelves) {
    const id = shelf?.id;
    const label = shelf?.label;
    if (typeof id !== "string" || !id) continue;
    if (typeof label !== "string" || !label) continue;
    if (shelf?.type && NON_BOOK_SHELF_TYPES.has(shelf.type)) continue;
    const entities = Array.isArray(shelf?.entities) ? shelf.entities : [];
    const items: HomeRowItem[] = [];
    for (const e of entities) {
      if (items.length >= MAX_ITEMS_PER_ROW) break;
      const itemId = e?.id;
      const title = titleOf(e);
      if (typeof itemId !== "string" || !itemId || !title) continue;
      items.push({
        id: itemId,
        title,
        author: authorOf(e),
        coverUrl: coverUrlFor(e, server, token),
      });
    }
    if (items.length === 0) continue;
    rows.push({ id, label, items });
  }
  return rows;
}

// Signature of the mirrored rows so we only rewrite the file when the visible
// content actually changes (shelves reload often with identical data). Includes
// coverUrl (which embeds the access token) so a token refresh — which rotates
// the token without reloading shelves — is detected and the file is rewritten
// with fresh URLs instead of leaving the widget's cover fetches to 401.
function rowsSignature(rows: HomeRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.id}:${r.label}:${r.items
          .map((i) => `${i.id}~${i.title}~${i.author || ""}~${i.coverUrl || ""}`)
          .join(",")}`
    )
    .join("|");
}

let lastSignature: string | null = null;

// Reads the current shelves + server creds and mirrors them for the widget.
// Deduped by content signature so repeated shelf loads don't churn the file.
// Best-effort: any failure just leaves the previous widget state in place.
export function mirrorHomeRows(): void {
  try {
    const {
      useLibraryStore,
    } = require("../store/useLibraryStore") as typeof import("../store/useLibraryStore");
    const shelves = useLibraryStore.getState().personalizedShelves || [];

    const { storageHelper } = require("./storage");
    const cfg = storageHelper.getServerConfig?.();
    const rows = buildHomeRows(shelves, cfg?.address || "", cfg?.token || "");

    const sig = rowsSignature(rows);
    if (sig === lastSignature) return;
    lastSignature = sig;
    // Push a home-row widget redraw once the new file is on disk — this is the
    // dedicated home-row refresh path (NOT the ~2s playback cadence), so its
    // network cover fetches only run when the shelves/creds actually change.
    writeHomeRowsState(rows)
      .then(() => refreshHomeRowWidget())
      .catch(() => {});
  } catch {
    // Ignore — mirroring is best-effort.
  }
}

let installed = false;

// Installs the store subscriptions that keep the widget's mirror fresh. Called
// once from App.tsx (not at module scope) to avoid a require cycle — useUserStore
// imports useLibraryStore at module load. Re-mirrors when:
//   - the personalized shelves or active library change (new content), OR
//   - the server config token/address change (a 401 token refresh rotates the
//     token embedded in every coverUrl; without this the widget keeps stale URLs
//     that 401 until the next shelf reload).
export function installHomeRowsMirror(): void {
  if (installed) return;
  installed = true;
  try {
    const { useLibraryStore } = require("../store/useLibraryStore");
    useLibraryStore.subscribe((state: any, prev: any) => {
      if (
        state.personalizedShelves !== prev.personalizedShelves ||
        state.currentLibraryId !== prev.currentLibraryId
      ) {
        mirrorHomeRows();
      }
    });
  } catch {
    // Best-effort — never let install break app startup.
  }
  try {
    const { useUserStore } = require("../store/useUserStore");
    useUserStore.subscribe((state: any, prev: any) => {
      const a = state.serverConnectionConfig;
      const b = prev.serverConnectionConfig;
      if ((a?.token || "") !== (b?.token || "") || (a?.address || "") !== (b?.address || "")) {
        mirrorHomeRows();
      }
    });
  } catch {
    // Best-effort.
  }
  // Seed once in case shelves already loaded before this ran.
  mirrorHomeRows();
}

// Test-only: reset the dedupe cache between cases.
export function __resetHomeRowsMirror(): void {
  lastSignature = null;
}
