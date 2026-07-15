import { HomeRow, HomeRowItem, writeHomeRowsState } from "./autoCreds";

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
// content actually changes (shelves reload often with identical data).
function rowsSignature(rows: HomeRow[]): string {
  return rows
    .map((r) => `${r.id}:${r.items.map((i) => i.id).join(",")}`)
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
    writeHomeRowsState(rows).catch(() => {});
  } catch {
    // Ignore — mirroring is best-effort.
  }
}

// Test-only: reset the dedupe cache between cases.
export function __resetHomeRowsMirror(): void {
  lastSignature = null;
}
