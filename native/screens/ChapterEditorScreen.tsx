import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  TextInput,
  Platform,
  AccessibilityInfo,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import { api } from "../utils/api";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { updateChapters, searchChaptersByAsin } from "../utils/abs/items";
import type { AbsChapter } from "../utils/abs/types";

/**
 * ChapterEditorScreen — edit a book's chapter list against the server.
 *
 * Route: "ChapterEditor"
 * Params: { libraryItemId: string }
 *
 * EDITING MODEL (the load-bearing decision): everything edits a LOCAL DRAFT —
 * nothing touches the server until Save, which validates and then POSTs the
 * WHOLE chapter array via utils/abs/items.updateChapters. Chapter `end` times
 * are never edited directly: ABS semantics make each chapter end where the
 * next begins (and the last ends at the item duration), so ends are derived
 * from the ordered starts at save time. Leaving with a dirty draft is guarded
 * by a `beforeRemove` navigation listener + discard dialog.
 *
 * Validation (matches the ABS server's own checks on POST /api/items/:id/chapters):
 *   - first chapter starts at exactly 0
 *   - start times strictly increasing
 *   - every start within [0, duration)
 */

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Clamp float noise to millisecond precision (the payload the server stores). */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Format absolute seconds as `HH:MM:SS` (with `.mmm` only when there is a
 * fractional part). parseTimestamp(formatTimestamp(x)) round-trips exactly to
 * millisecond precision.
 */
export function formatTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = ms % 1000;
  const base = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return frac ? `${base}.${String(frac).padStart(3, "0")}` : base;
}

/**
 * Parse a human timestamp into seconds. Accepts `HH:MM:SS.mmm`, `MM:SS`, or
 * bare seconds (`SS` / `SS.mmm`); a comma decimal separator is tolerated.
 * Returns null when the text isn't a valid time (minutes/seconds must be < 60
 * when a higher field is present). Result is rounded to milliseconds.
 */
export function parseTimestamp(text: string): number | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length > 3) return null;
  const secText = parts[parts.length - 1].replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(secText)) return null;
  const sec = parseFloat(secText);
  let min = 0;
  let hr = 0;
  if (parts.length >= 2) {
    if (!/^\d+$/.test(parts[parts.length - 2])) return null;
    min = parseInt(parts[parts.length - 2], 10);
    if (sec >= 60) return null;
  }
  if (parts.length === 3) {
    if (!/^\d+$/.test(parts[0])) return null;
    hr = parseInt(parts[0], 10);
    if (min >= 60) return null;
  }
  return round3(hr * 3600 + min * 60 + sec);
}

/** A draft chapter row. `key` is a stable React identity; ends are derived. */
export interface DraftChapter {
  key: number;
  title: string;
  start: number;
}

/** The exact validation message for a first chapter that doesn't start at 0. */
export const FIRST_CHAPTER_ERROR = "The first chapter must start at 00:00:00.";

/**
 * Validate a draft against ABS chapter semantics. Returns human-readable
 * error strings — an empty array means the draft is saveable.
 */
export function validateChapterDraft(
  draft: readonly { start: number }[],
  duration: number
): string[] {
  const errors: string[] = [];
  if (!draft.length) return errors;
  if (draft[0].start !== 0) errors.push(FIRST_CHAPTER_ERROR);
  for (let i = 1; i < draft.length; i++) {
    if (draft[i].start <= draft[i - 1].start) {
      errors.push("Chapter start times must be strictly increasing.");
      break;
    }
  }
  if (draft.some((c) => c.start < 0 || (duration > 0 && c.start >= duration))) {
    errors.push("Every chapter must start within the book's duration.");
  }
  return errors;
}

/** Indices of rows that participate in a validation failure (for row styling). */
export function invalidDraftIndices(
  draft: readonly { start: number }[],
  duration: number
): Set<number> {
  const bad = new Set<number>();
  draft.forEach((c, i) => {
    if (i === 0 && c.start !== 0) bad.add(i);
    if (i > 0 && c.start <= draft[i - 1].start) bad.add(i);
    if (c.start < 0 || (duration > 0 && c.start >= duration)) bad.add(i);
  });
  return bad;
}

/**
 * Build the exact POST /api/items/:id/chapters payload from a draft: ids are
 * re-indexed 0..n-1 and each end is the next chapter's start (the last ends
 * at the item duration).
 */
export function buildChaptersPayload(
  draft: readonly DraftChapter[],
  duration: number
): AbsChapter[] {
  return draft.map((c, i) => ({
    id: i,
    start: round3(c.start),
    end: round3(i + 1 < draft.length ? draft[i + 1].start : duration),
    title: c.title,
  }));
}

/**
 * Map an Audnexus /api/search/chapters result row to draft seconds. Audnexus
 * reports `startOffsetMs`; tolerate a plain `start` (seconds) as a fallback.
 */
function audnexusChapterStart(c: any): number {
  if (typeof c?.startOffsetMs === "number") return round3(c.startOffsetMs / 1000);
  if (typeof c?.start === "number") return round3(c.start);
  return 0;
}

function humanDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

const serializeDraft = (draft: DraftChapter[]) =>
  JSON.stringify(draft.map((c) => ({ t: c.title, s: c.start })));

/**
 * Resolve the item's audio duration in seconds. `media.duration` is a computed
 * field ABS only serializes on the EXPANDED item (toOldJSONExpanded); the
 * minified form omits it. We fetch with `?expanded=1` so it's present, but a
 * book that carries an ebook (or any payload variance) can still arrive without
 * a top-level duration — so fall back to summing the audio tracks / files, and
 * finally to the last chapter's end. Returns 0 only when there is genuinely no
 * audio to derive from.
 */
export function deriveItemDuration(media: any): number {
  const top = Number(media?.duration);
  if (Number.isFinite(top) && top > 0) return round3(top);

  const sum = (arr: any): number =>
    Array.isArray(arr)
      ? arr.reduce((acc, x) => {
          const d = Number(x?.duration);
          return acc + (Number.isFinite(d) && d > 0 ? d : 0);
        }, 0)
      : 0;

  const fromTracks = sum(media?.tracks);
  if (fromTracks > 0) return round3(fromTracks);
  const fromFiles = sum(media?.audioFiles);
  if (fromFiles > 0) return round3(fromFiles);

  const chapters: any[] = Array.isArray(media?.chapters) ? media.chapters : [];
  const lastEnd = chapters.reduce((mx, c) => {
    const e = Number(c?.end);
    return Number.isFinite(e) && e > mx ? e : mx;
  }, 0);
  return lastEnd > 0 ? round3(lastEnd) : 0;
}

/**
 * "numbers-and-punctuation" only exists on iOS — Android silently falls back
 * to the default keyboard. Select it explicitly per platform so the Android
 * behavior (default keyboard, which can type ':' and '.') is intentional
 * rather than dead code.
 */
const TIME_KEYBOARD = Platform.select({
  ios: "numbers-and-punctuation" as const,
  android: undefined,
});

/**
 * Audible/Audnexus marketplace regions the chapter lookup accepts. An ASIN is
 * marketplace-specific, so the region must match where the book was bought —
 * "us" is the default because it's the largest catalog.
 */
export const AUDNEXUS_REGIONS = [
  "us",
  "uk",
  "ca",
  "au",
  "fr",
  "de",
  "es",
  "it",
  "jp",
  "in",
] as const;

/** Read the item's server-side revision marker (media-level wins, then item). */
function readUpdatedAt(it: any): any {
  return it?.media?.updatedAt ?? it?.updatedAt ?? null;
}

// ---------------------------------------------------------------------------
// Small UI pieces (module scope so TextInput identity survives re-renders)
// ---------------------------------------------------------------------------

function PillButton({
  label,
  onPress,
  colors,
  tone = "secondary",
  disabled,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  colors: any;
  tone?: "secondary" | "primary" | "error";
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const bg =
    tone === "primary"
      ? colors.primary
      : tone === "error"
      ? colors.errorContainer
      : colors.secondaryContainer;
  const fg =
    tone === "primary"
      ? colors.onPrimary
      : tone === "error"
      ? colors.onErrorContainer
      : colors.onSecondaryContainer;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{ disabled: !!disabled }}
      android_ripple={{ color: withAlpha(fg, 0.14) }}
      hitSlop={{ top: 6, bottom: 6 }}
      style={{
        paddingHorizontal: 14,
        height: 36,
        borderRadius: 18,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bg,
        opacity: disabled ? 0.5 : 1,
        marginRight: 8,
        marginBottom: 8,
      }}
    >
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function Stepper({
  label,
  text,
  onPress,
  colors,
}: {
  label: string;
  text: string;
  onPress: () => void;
  colors: any;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
      // 40dp tall — pad the touch target up to the 48dp guideline.
      hitSlop={{ top: 4, bottom: 4 }}
      style={{
        minWidth: 48,
        height: 40,
        borderRadius: 12,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.surfaceContainerHighest,
        marginRight: 6,
      }}
    >
      <Text style={{ color: colors.onSurface, fontSize: 13, fontWeight: "700" }}>{text}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ChapterEditorScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const libraryItemId: string | undefined = route?.params?.libraryItemId;

  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [saving, setSaving] = useState(false);
  // Synchronous mutex for the actual POST: the `saving` STATE lags a rapid
  // double-tap (and performSave is also reachable from dialog buttons like
  // conflict→Overwrite), so this ref prevents duplicate chapter POSTs.
  const savingRef = useRef(false);

  // The local draft + the serialized snapshot it was seeded from (dirty test).
  const [draft, setDraft] = useState<DraftChapter[]>([]);
  const [baseline, setBaseline] = useState("[]");
  const keyCounter = useRef(0);
  const nextKey = () => keyCounter.current++;

  // The server revision marker captured at load/seed time. handleSave re-fetches
  // and compares this before POSTing to catch a concurrent edit (issue #69).
  const updatedAtRef = useRef<any>(null);

  // Row editor state: which row is expanded + its start-time text field.
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [editStart, setEditStart] = useState("");

  // Tool panels.
  const [asinOpen, setAsinOpen] = useState(false);
  const [asinText, setAsinText] = useState("");
  const [asinLoading, setAsinLoading] = useState(false);
  const [asinPreview, setAsinPreview] = useState<{ title: string; start: number }[] | null>(null);
  const [asinNote, setAsinNote] = useState<string | null>(null);
  const [asinRegion, setAsinRegion] = useState<string>("us");
  const [shiftOpen, setShiftOpen] = useState(false);
  const [shiftText, setShiftText] = useState("");

  const duration: number = deriveItemDuration(item?.media);
  const dirty = useMemo(() => serializeDraft(draft) !== baseline, [draft, baseline]);
  const validationErrors = useMemo(
    () => validateChapterDraft(draft, duration),
    [draft, duration]
  );
  const invalidRows = useMemo(() => invalidDraftIndices(draft, duration), [draft, duration]);

  // "Use current playback position" is only meaningful when the loaded
  // playback session IS the item being edited (read-only store usage).
  const playingItemId = usePlaybackStore(
    (s) => s.currentSession?.libraryItemId || s.currentSession?.libraryItem?.id || null
  );
  const playbackMatchesItem = !!libraryItemId && playingItemId === libraryItemId;

  const seedFromItem = (it: any) => {
    const chapters: any[] = Array.isArray(it?.media?.chapters) ? it.media.chapters : [];
    const seeded: DraftChapter[] = chapters.map((c, i) => ({
      key: i,
      title: c?.title != null ? String(c.title) : "",
      start: round3(Number(c?.start) || 0),
    }));
    keyCounter.current = seeded.length;
    setDraft(seeded);
    setBaseline(serializeDraft(seeded));
    updatedAtRef.current = readUpdatedAt(it);
  };

  useEffect(() => {
    if (!libraryItemId) {
      setLoadError("No item provided.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        // `?expanded=1` matches every other item fetch in the app and is
        // required for the computed `media.duration` + full `chapters`/`tracks`
        // (the minified item omits them, which reported "no audio duration").
        const res = await api.get(`/api/items/${libraryItemId}?expanded=1`);
        if (cancelled) return;
        setItem(res?.data);
        seedFromItem(res?.data);
      } catch (err: any) {
        if (cancelled) return;
        console.error("[ChapterEditor] Failed to load item:", err);
        // ItemDetail idiom: no HTTP response ⇒ the request never reached the server.
        setLoadError(
          err?.response
            ? "Failed to load the item's chapters."
            : "You're offline. Reconnect to edit chapters."
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [libraryItemId, retryTick]);

  // Prefill the ASIN lookup from the item's metadata once loaded.
  useEffect(() => {
    const asin = item?.media?.metadata?.asin;
    if (asin) setAsinText(String(asin));
  }, [item]);

  // Unsaved-changes guard: intercept ANY navigation that would remove this
  // screen while the draft is dirty. Refs keep the listener stable.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty && !saving;
  useEffect(() => {
    if (!navigation?.addListener) return;
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      showAppDialog({
        title: "Discard chapter changes?",
        message: "You have unsaved chapter edits. Nothing has been sent to the server yet.",
        buttons: [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => navigation.dispatch(e.data.action),
          },
        ],
      });
    });
    return unsub;
  }, [navigation]);

  // ------------------------------------------------------------------ edits

  const selectedIndex = draft.findIndex((c) => c.key === selectedKey);
  const selectedChapter = selectedIndex >= 0 ? draft[selectedIndex] : null;

  // Commit-once guard for the start-time field. Android fires BOTH
  // onSubmitEditing and onEndEditing for a single commit, so without this an
  // invalid entry would snackbar twice. `true` means the field has no pending
  // (uncommitted) text; typing flips it to false, committing flips it back.
  const startCommittedRef = useRef(true);

  const setChapterTitle = (key: number, title: string) =>
    setDraft((d) => d.map((c) => (c.key === key ? { ...c, title } : c)));

  // Returns the draft AFTER applying the start — a synchronous caller (Save)
  // can use the flushed value without waiting for the setDraft re-render.
  const applyStart = (key: number, start: number): DraftChapter[] => {
    const clamped = round3(Math.max(0, start));
    const next = draft.map((c) => (c.key === key ? { ...c, start: clamped } : c));
    setDraft(next);
    setEditStart(formatTimestamp(clamped));
    startCommittedRef.current = true; // field now mirrors the draft
    return next;
  };

  const handleEditStartChange = (text: string) => {
    startCommittedRef.current = false;
    setEditStart(text);
  };

  // Commit any pending start-time text into the draft, returning the resulting
  // draft (the current draft unchanged when there's nothing pending / invalid).
  const commitStartText = (): DraftChapter[] => {
    if (startCommittedRef.current) return draft; // already committed this edit session
    startCommittedRef.current = true;
    if (!selectedChapter) return draft;
    const parsed = parseTimestamp(editStart);
    if (parsed == null) {
      showSnackbar({ message: "Invalid time — use HH:MM:SS.mmm" });
      setEditStart(formatTimestamp(selectedChapter.start));
      return draft;
    }
    return applyStart(selectedChapter.key, parsed);
  };

  const toggleRow = (key: number) => {
    // Commit any pending start-time text BEFORE the active row changes — on
    // Android the old input's blur events can land after the switch, which
    // would otherwise discard (or misapply) what was typed.
    commitStartText();
    if (selectedKey === key) {
      setSelectedKey(null);
      return;
    }
    const row = draft.find((c) => c.key === key);
    setSelectedKey(key);
    setEditStart(row ? formatTimestamp(row.start) : "");
  };

  // The steppers update the TextInput silently as far as TalkBack/VoiceOver
  // are concerned — announce the resulting timestamp, debounced so a burst of
  // rapid taps announces only the final value.
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    },
    []
  );
  const announceStartChange = (formatted: string) => {
    if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    announceTimerRef.current = setTimeout(() => {
      announceTimerRef.current = null;
      AccessibilityInfo.announceForAccessibility(`Start time ${formatted}`);
    }, 300);
  };

  const nudgeStart = (deltaSeconds: number) => {
    if (!selectedChapter) return;
    const next = round3(Math.max(0, selectedChapter.start + deltaSeconds));
    applyStart(selectedChapter.key, next);
    announceStartChange(formatTimestamp(next));
  };

  const useCurrentPlaybackPosition = () => {
    if (!selectedChapter) return;
    // Read imperatively at tap time — subscribing to `position` would re-render
    // this whole editor every playback tick.
    const pos = usePlaybackStore.getState().position || 0;
    applyStart(selectedChapter.key, pos);
    showSnackbar({ message: `Start set to ${formatTimestamp(round3(pos))}` });
  };

  const removeChapter = (key: number) => {
    // Draft-local (nothing hits the server until Save), so removal is instant.
    setDraft((d) => d.filter((c) => c.key !== key));
    if (selectedKey === key) setSelectedKey(null);
  };

  /** Insert after `index` (or append when index is the last row / list is empty). */
  const insertChapterAfter = (index: number) => {
    const prevStart = index >= 0 && draft[index] ? draft[index].start : 0;
    const nextStart = index + 1 < draft.length ? draft[index + 1].start : duration;
    if (draft.length && nextStart - prevStart < 0.002) {
      showSnackbar({ message: "No room between chapters to insert here." });
      return;
    }
    const start = draft.length ? round3((prevStart + nextStart) / 2) : 0;
    const row: DraftChapter = {
      key: nextKey(),
      title: `Chapter ${draft.length + 1}`,
      start,
    };
    setDraft((d) => {
      const copy = d.slice();
      copy.splice(index + 1, 0, row);
      return copy;
    });
    setSelectedKey(row.key);
    setEditStart(formatTimestamp(row.start));
    startCommittedRef.current = true; // fresh field mirrors the new row
  };

  const addChapterAtEnd = () => insertChapterAfter(draft.length - 1);

  // ------------------------------------------------------------------ tools

  const applyShift = () => {
    const normalized = shiftText.trim().replace(",", ".");
    const offset = Number(normalized);
    if (!normalized || !isFinite(offset)) {
      showAppDialog({
        title: "Invalid shift amount",
        message: "Enter the number of seconds to shift by (e.g. 1.5 or -2).",
      });
      return;
    }
    // ABS semantics: the first chapter stays anchored at 0 — only later
    // chapters shift.
    const next = draft.map((c, i) => (i === 0 ? c : { ...c, start: round3(c.start + offset) }));
    const outOfRange = next.some(
      (c, i) => i > 0 && (c.start <= 0 || (duration > 0 && c.start >= duration))
    );
    if (outOfRange) {
      showAppDialog({
        title: "Can't shift chapters",
        message:
          "Shifting by that amount would push a chapter outside the book. No changes were made.",
      });
      return;
    }
    setDraft(next);
    showSnackbar({ message: `Shifted ${Math.max(0, next.length - 1)} chapters by ${offset}s` });
  };

  // Reset to a single chapter at 0. ABS books need at least one chapter that
  // starts at 0 — an empty list would fail validation — so "remove all" leaves
  // exactly that. Draft-local: dirty until Save, like any other edit.
  const removeAllChapters = () => {
    showAppDialog({
      title: "Remove all chapters?",
      message:
        "This replaces your draft with a single chapter starting at 00:00:00. Nothing is saved to the server until you press Save.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove all",
          style: "destructive",
          onPress: () => {
            setDraft([{ key: nextKey(), title: "Chapter 1", start: 0 }]);
            setSelectedKey(null);
            setAsinOpen(false);
            setShiftOpen(false);
            showSnackbar({ message: "Chapters cleared — review and save" });
          },
        },
      ],
    });
  };

  const lookupAsin = async () => {
    const asin = asinText.trim();
    if (!asin || asinLoading) return;
    setAsinLoading(true);
    setAsinPreview(null);
    setAsinNote(null);
    try {
      const result = await searchChaptersByAsin(asin, asinRegion);
      // The server signals a miss with 200 + { error } (see utils/abs/items.ts).
      if (result?.error) {
        showAppDialog({ title: "Chapter lookup failed", message: String(result.error) });
        return;
      }
      const rows: any[] = Array.isArray(result?.chapters) ? result.chapters : [];
      if (!rows.length) {
        showAppDialog({
          title: "No chapters found",
          message: "Audnexus has no chapter data for that ASIN.",
        });
        return;
      }
      const mapped = rows.map((c, i) => ({
        title: c?.title ? String(c.title) : `Chapter ${i + 1}`,
        start: audnexusChapterStart(c),
      }));
      setAsinPreview(mapped);
      let note = `Found ${mapped.length} chapters`;
      if (typeof result?.runtimeLengthMs === "number" && duration > 0) {
        const diff = Math.abs(result.runtimeLengthMs / 1000 - duration);
        note += diff > 2 ? ` — runtime differs from this book by ${Math.round(diff)}s` : " — runtime matches";
      }
      setAsinNote(note);
    } catch (e: any) {
      showAppDialog({
        title: "Chapter lookup failed",
        message: e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      setAsinLoading(false);
    }
  };

  // The preview replaces the DRAFT only after an explicit confirm — and the
  // server only changes when the user then saves.
  const confirmApplyPreview = () => {
    if (!asinPreview) return;
    showAppDialog({
      title: "Replace chapters?",
      message: `Replace the ${draft.length} chapters in your draft with ${asinPreview.length} chapters from Audnexus? Nothing is saved to the server until you press Save.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Replace",
          style: "destructive",
          onPress: () => {
            setDraft(asinPreview.map((c) => ({ key: nextKey(), title: c.title, start: c.start })));
            setSelectedKey(null);
            setAsinPreview(null);
            setAsinOpen(false);
            showSnackbar({ message: "Draft replaced — review and save" });
          },
        },
      ],
    });
  };

  // ------------------------------------------------------------------- save

  // Reseed the draft from a freshly-fetched item, discarding the local draft.
  // Confirms first when the draft is dirty (which, at conflict time, it is).
  const reloadFromServer = (fresh: any) => {
    const doReload = () => {
      setItem(fresh);
      seedFromItem(fresh); // reseeds draft + baseline + captured updatedAt
      setSelectedKey(null);
      showSnackbar({ message: "Reloaded chapters from the server" });
    };
    if (dirtyRef.current) {
      showAppDialog({
        title: "Discard your changes?",
        message: "Reloading replaces your local edits with the server's chapters.",
        buttons: [
          { text: "Keep editing", style: "cancel" },
          { text: "Discard & reload", style: "destructive", onPress: doReload },
        ],
      });
    } else {
      doReload();
    }
  };

  // The actual validated POST. Refreshes the captured revision marker from the
  // response when the server echoes one, so a follow-up save re-checks cleanly.
  const performSave = async (flushed: DraftChapter[]) => {
    if (!libraryItemId || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const res: any = await updateChapters(libraryItemId, buildChaptersPayload(flushed, duration));
      setBaseline(serializeDraft(flushed));
      showSnackbar({ message: "Chapters saved" });
      // POST /chapters echoes no updatedAt, but the save DID bump the server's
      // media.updatedAt — so re-baseline the conflict marker from a fresh read,
      // otherwise a second save this session would false-conflict against the
      // stale load-time value. Prefer an echoed marker if the server ever adds
      // one; else re-fetch (best-effort — clear the marker on failure so we
      // degrade to "no check" rather than a spurious conflict dialog).
      const echoed = readUpdatedAt(res?.libraryItem) ?? readUpdatedAt(res) ?? null;
      if (echoed != null) {
        updatedAtRef.current = echoed;
      } else {
        try {
          const fresh = await api.get(`/api/items/${libraryItemId}?expanded=1`);
          updatedAtRef.current = readUpdatedAt(fresh?.data);
        } catch {
          updatedAtRef.current = null;
        }
      }
    } catch (e: any) {
      // AbsError carries a user-facing message ("offline", "forbidden", ...).
      showAppDialog({
        title: "Couldn't save chapters",
        message: e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  // Concurrent-edit guard (issue #69): re-fetch the item and compare its
  // updatedAt to the one captured at load. On a mismatch, let the user Reload
  // (discard local, take the server's) or Overwrite (POST anyway). A missing
  // marker or a failed re-fetch never blocks the save — it just proceeds.
  const saveWithConflictCheck = async (flushed: DraftChapter[]) => {
    if (!libraryItemId) return;
    const captured = updatedAtRef.current;
    if (captured != null) {
      try {
        const res = await api.get(`/api/items/${libraryItemId}?expanded=1`);
        const fresh = res?.data;
        const serverUpdatedAt = readUpdatedAt(fresh);
        if (serverUpdatedAt != null && serverUpdatedAt !== captured) {
          showAppDialog({
            title: "Chapters changed on the server",
            message:
              "Someone (or another device) edited this book's chapters since you opened it. Reload to take the server's version, or overwrite it with your edits.",
            buttons: [
              { text: "Cancel", style: "cancel" },
              { text: "Reload", onPress: () => reloadFromServer(fresh) },
              {
                text: "Overwrite",
                style: "destructive",
                onPress: () => performSave(flushed),
              },
            ],
          });
          return;
        }
      } catch (e) {
        // A failed pre-check must not block saving — fall through to the POST.
        console.error("[ChapterEditor] updatedAt pre-check failed:", e);
      }
    }
    await performSave(flushed);
  };

  const handleSave = async () => {
    if (!libraryItemId || saving) return;
    // Flush a typed-but-unblurred start-time edit BEFORE reading the draft:
    // relying on the field's onEndEditing/blur to fire before this press isn't
    // ordering-guaranteed (same reason toggleRow commits first), so a valid
    // typed start could otherwise be dropped from the payload. Use the returned
    // draft — the setDraft above won't have re-rendered this closure yet.
    const flushed = commitStartText();
    if (serializeDraft(flushed) === baseline) return; // nothing to save
    const errors = validateChapterDraft(flushed, duration);
    if (errors.length) {
      // When the ONLY blocker is a non-zero first chapter, offer a one-tap fix
      // that anchors chapter 1 at 0 and re-validates (issue #69). Any other
      // validation error still hard-blocks.
      const canAutoFixFirst =
        errors.length === 1 && errors[0] === FIRST_CHAPTER_ERROR && flushed.length > 0;
      const buttons: any[] = [{ text: "OK", style: "cancel" }];
      if (canAutoFixFirst) {
        buttons.push({
          text: "Set first chapter to 0:00",
          onPress: () => {
            const fixed = flushed.map((c, i) => (i === 0 ? { ...c, start: 0 } : c));
            setDraft(fixed);
            if (selectedKey === fixed[0].key) setEditStart(formatTimestamp(0));
            const remaining = validateChapterDraft(fixed, duration);
            if (remaining.length) {
              showAppDialog({ title: "Can't save chapters", message: remaining.join("\n") });
              return;
            }
            saveWithConflictCheck(fixed);
          },
        });
      }
      showAppDialog({ title: "Can't save chapters", message: errors.join("\n"), buttons });
      return;
    }
    await saveWithConflictCheck(flushed);
  };

  // ------------------------------------------------------------------ render

  const title = item?.media?.metadata?.title;
  const mono = { fontVariant: ["tabular-nums"] as any };

  const renderRow = ({ item: row, index }: { item: DraftChapter; index: number }) => {
    const expanded = row.key === selectedKey;
    const rowInvalid = invalidRows.has(index);
    return (
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
          backgroundColor: expanded ? colors.surfaceContainer : "transparent",
        }}
      >
        <Pressable
          onPress={() => toggleRow(row.key)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`Chapter ${index + 1}: ${row.title || "Untitled"}, starts at ${formatTimestamp(row.start)}`}
          android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.1) }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 16,
            minHeight: 52,
          }}
        >
          <Text
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 12,
              fontWeight: "700",
              width: 34,
            }}
          >
            #{index + 1}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: colors.onSurface, fontSize: 15, flex: 1, marginRight: 10 }}
          >
            {row.title || "Untitled"}
          </Text>
          <Text
            style={[
              {
                color: rowInvalid ? colors.error : colors.onSurfaceVariant,
                fontSize: 13,
                fontWeight: rowInvalid ? "700" : "500",
              },
              mono,
            ]}
          >
            {formatTimestamp(row.start)}
          </Text>
        </Pressable>

        {expanded ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginBottom: 4 }}>
              Title
            </Text>
            <TextInput
              value={row.title}
              onChangeText={(t) => setChapterTitle(row.key, t)}
              accessibilityLabel="Chapter title"
              placeholder="Chapter title"
              placeholderTextColor={colors.onSurfaceVariant}
              style={{
                backgroundColor: colors.surfaceContainerHigh,
                color: colors.onSurface,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 15,
              }}
            />
            <Text
              style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 12, marginBottom: 4 }}
            >
              Start time (HH:MM:SS.mmm)
            </Text>
            <TextInput
              value={editStart}
              onChangeText={handleEditStartChange}
              // Both fire for one commit on Android — commitStartText dedupes
              // via startCommittedRef.
              onEndEditing={commitStartText}
              onSubmitEditing={commitStartText}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={TIME_KEYBOARD}
              accessibilityLabel="Chapter start time"
              placeholder="00:00:00.000"
              placeholderTextColor={colors.onSurfaceVariant}
              style={[
                {
                  backgroundColor: colors.surfaceContainerHigh,
                  color: colors.onSurface,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  fontSize: 15,
                  maxWidth: 200,
                },
                mono,
              ]}
            />
            <View style={{ flexDirection: "row", marginTop: 10 }}>
              <Stepper
                label="Decrease start time by 1 second"
                text="−1s"
                onPress={() => nudgeStart(-1)}
                colors={colors}
              />
              <Stepper
                label="Decrease start time by 0.1 seconds"
                text="−0.1s"
                onPress={() => nudgeStart(-0.1)}
                colors={colors}
              />
              <Stepper
                label="Increase start time by 0.1 seconds"
                text="+0.1s"
                onPress={() => nudgeStart(0.1)}
                colors={colors}
              />
              <Stepper
                label="Increase start time by 1 second"
                text="+1s"
                onPress={() => nudgeStart(1)}
                colors={colors}
              />
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 12 }}>
              {playbackMatchesItem ? (
                <PillButton
                  label="Use current playback position"
                  onPress={useCurrentPlaybackPosition}
                  colors={colors}
                />
              ) : null}
              <PillButton
                label="Insert chapter after"
                onPress={() => insertChapterAfter(index)}
                colors={colors}
              />
              <PillButton
                label="Remove chapter"
                tone="error"
                onPress={() => removeChapter(row.key)}
                colors={colors}
              />
            </View>
          </View>
        ) : null}
      </View>
    );
  };

  // Header tools are a plain element (NOT an inline component) so the
  // TextInputs inside aren't remounted by FlatList on every render.
  const listHeader = (
    <View>
      {/* Book title + tool toggles */}
      <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
        {title ? (
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ color: colors.onSurface, fontSize: 17, fontWeight: "700" }}
          >
            {title}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 12 }}>
          <PillButton
            label="Find chapters by ASIN"
            onPress={() => {
              setAsinOpen((v) => !v);
              setShiftOpen(false);
            }}
            colors={colors}
          />
          <PillButton
            label="Shift all times"
            onPress={() => {
              setShiftOpen((v) => !v);
              setAsinOpen(false);
            }}
            colors={colors}
          />
          {draft.length > 0 ? (
            <PillButton
              label="Remove all chapters"
              tone="error"
              onPress={removeAllChapters}
              colors={colors}
            />
          ) : null}
        </View>
      </View>

      {/* Audnexus ASIN lookup panel */}
      {asinOpen ? (
        <View
          style={{
            marginHorizontal: 16,
            marginTop: 4,
            marginBottom: 8,
            padding: 14,
            borderRadius: 14,
            backgroundColor: colors.surfaceContainerHigh,
          }}
        >
          <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
            Audnexus chapter lookup
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
            Fetches chapter names and times for an Audible ASIN. Results only replace your draft
            after you confirm.
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
            <TextInput
              value={asinText}
              onChangeText={setAsinText}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="ASIN"
              placeholder="ASIN (e.g. B00XXXXXXX)"
              placeholderTextColor={colors.onSurfaceVariant}
              style={{
                flex: 1,
                backgroundColor: colors.surfaceContainerHighest,
                color: colors.onSurface,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 15,
                marginRight: 10,
              }}
            />
            <Pressable
              onPress={lookupAsin}
              disabled={asinLoading || !asinText.trim()}
              accessibilityRole="button"
              accessibilityLabel="Look up chapters"
              accessibilityState={{ disabled: asinLoading || !asinText.trim() }}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
              style={{
                height: 40,
                paddingHorizontal: 16,
                borderRadius: 20,
                overflow: "hidden",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.primary,
                opacity: asinLoading || !asinText.trim() ? 0.5 : 1,
              }}
            >
              {asinLoading ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={{ color: colors.onPrimary, fontSize: 13, fontWeight: "700" }}>
                  Look up
                </Text>
              )}
            </Pressable>
          </View>

          {/* Marketplace region — an ASIN is region-specific, so the lookup
              must target the store the book came from. */}
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 12 }}>
            Region
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 6 }}>
            {AUDNEXUS_REGIONS.map((r) => {
              const active = r === asinRegion;
              return (
                <Pressable
                  key={r}
                  onPress={() => setAsinRegion(r)}
                  accessibilityRole="button"
                  accessibilityLabel={`Region ${r.toUpperCase()}`}
                  accessibilityState={{ selected: active }}
                  android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.14) }}
                  hitSlop={{ top: 4, bottom: 4 }}
                  style={{
                    paddingHorizontal: 12,
                    height: 32,
                    borderRadius: 16,
                    overflow: "hidden",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: active ? colors.primary : colors.surfaceContainerHighest,
                    marginRight: 8,
                    marginBottom: 8,
                  }}
                >
                  <Text
                    style={{
                      color: active ? colors.onPrimary : colors.onSurfaceVariant,
                      fontSize: 12,
                      fontWeight: active ? "700" : "600",
                    }}
                  >
                    {r.toUpperCase()}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {asinPreview ? (
            <View style={{ marginTop: 12 }}>
              {asinNote ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginBottom: 6 }}>
                  {asinNote}
                </Text>
              ) : null}
              {asinPreview.slice(0, 8).map((c, i) => (
                <View
                  key={`${i}-${c.start}`}
                  style={{ flexDirection: "row", alignItems: "center", paddingVertical: 3 }}
                >
                  <Text style={[{ color: colors.onSurfaceVariant, fontSize: 12, width: 86 }, mono]}>
                    {formatTimestamp(c.start)}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ color: colors.onSurface, fontSize: 13, flex: 1 }}
                  >
                    {c.title}
                  </Text>
                </View>
              ))}
              {asinPreview.length > 8 ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                  …and {asinPreview.length - 8} more
                </Text>
              ) : null}
              <View style={{ flexDirection: "row", marginTop: 10 }}>
                <PillButton
                  label={`Replace draft with ${asinPreview.length} chapters`}
                  accessibilityLabel="Replace draft"
                  tone="primary"
                  onPress={confirmApplyPreview}
                  colors={colors}
                />
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Shift-all panel */}
      {shiftOpen ? (
        <View
          style={{
            marginHorizontal: 16,
            marginTop: 4,
            marginBottom: 8,
            padding: 14,
            borderRadius: 14,
            backgroundColor: colors.surfaceContainerHigh,
          }}
        >
          <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
            Shift all chapter times
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
            Seconds to add to every chapter (negative shifts earlier). The first chapter stays at
            00:00:00.
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
            <TextInput
              value={shiftText}
              onChangeText={setShiftText}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={TIME_KEYBOARD}
              accessibilityLabel="Shift amount in seconds"
              placeholder="e.g. 1.5 or -2"
              placeholderTextColor={colors.onSurfaceVariant}
              style={{
                width: 140,
                backgroundColor: colors.surfaceContainerHighest,
                color: colors.onSurface,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 15,
                marginRight: 10,
              }}
            />
            <PillButton label="Apply shift" tone="primary" onPress={applyShift} colors={colors} />
          </View>
        </View>
      ) : null}

      {/* Validation banner */}
      {validationErrors.length ? (
        <View
          accessibilityRole="alert"
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginHorizontal: 16,
            marginTop: 4,
            marginBottom: 8,
            padding: 12,
            borderRadius: 12,
            backgroundColor: colors.errorContainer,
          }}
        >
          <Icon name="warning" size={18} color={colors.onErrorContainer} style={{ marginRight: 10 }} />
          <Text style={{ color: colors.onErrorContainer, fontSize: 13, flex: 1 }}>
            {validationErrors.join(" ")}
          </Text>
        </View>
      ) : null}

      {draft.length === 0 ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 24, alignItems: "center" }}>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>
            No chapters yet. Add one below or look them up by ASIN.
          </Text>
        </View>
      ) : null}
    </View>
  );

  const listFooter = (
    <View style={{ padding: 16, paddingBottom: dirty ? 72 : 32 }}>
      <Pressable
        onPress={addChapterAtEnd}
        accessibilityRole="button"
        accessibilityLabel="Add chapter"
        android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.14) }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          height: 48,
          borderRadius: 24,
          overflow: "hidden",
          backgroundColor: colors.secondaryContainer,
        }}
      >
        <Icon name="add" size={18} color={colors.onSecondaryContainer} />
        <Text
          style={{
            color: colors.onSecondaryContainer,
            fontSize: 15,
            fontWeight: "600",
            marginLeft: 8,
          }}
        >
          Add chapter
        </Text>
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      {/* Settings-family header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: "center",
            justifyContent: "center",
            marginRight: 4,
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700" }}
          >
            Chapters
          </Text>
          {!loading && !loadError ? (
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12 }}>
              {draft.length} chapter{draft.length === 1 ? "" : "s"}
              {duration > 0 ? ` · ${humanDuration(duration)}` : ""}
            </Text>
          ) : null}
        </View>
        {!loading && !loadError ? (
          <Pressable
            onPress={handleSave}
            disabled={saving || !dirty}
            accessibilityRole="button"
            accessibilityLabel="Save chapters"
            accessibilityState={{ disabled: saving || !dirty, busy: saving }}
            hitSlop={8}
            style={{ paddingHorizontal: 8, paddingVertical: 8, opacity: saving || !dirty ? 0.5 : 1 }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={{ color: colors.primary, fontSize: 15, fontWeight: "700" }}>Save</Text>
            )}
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loadError ? (
        <ErrorState
          style={{ flex: 1 }}
          icon="book"
          title="Couldn't load chapters"
          message={loadError}
          onRetry={libraryItemId ? () => setRetryTick((t) => t + 1) : undefined}
        />
      ) : duration <= 0 ? (
        <ErrorState
          style={{ flex: 1 }}
          icon="book"
          title="No audio duration"
          message="This item has no audio duration, so chapters can't be edited."
        />
      ) : (
        <View style={{ flex: 1 }}>
          <FlatList
            data={draft}
            keyExtractor={(c) => String(c.key)}
            renderItem={renderRow}
            extraData={[selectedKey, editStart, invalidRows, playbackMatchesItem]}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={listHeader}
            ListFooterComponent={listFooter}
          />
          {/* Persistent dirty chip */}
          {dirty ? (
            <View
              accessibilityLiveRegion="polite"
              style={{
                position: "absolute",
                bottom: 12,
                alignSelf: "center",
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 16,
                backgroundColor: colors.tertiaryContainer,
              }}
            >
              <Icon name="edit" size={14} color={colors.onTertiaryContainer} style={{ marginRight: 6 }} />
              <Text style={{ color: colors.onTertiaryContainer, fontSize: 12, fontWeight: "600" }}>
                Unsaved changes
              </Text>
            </View>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}
