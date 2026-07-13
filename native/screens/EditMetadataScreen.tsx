import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  ActivityIndicator,
  AccessibilityInfo,
  type KeyboardTypeOptions,
  type ReturnKeyTypeOptions,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { useServerCapabilities } from "../utils/abs/capabilities";
import {
  updateItemMedia,
  searchBookMetadata,
  searchCovers,
  setCoverFromUrl,
} from "../utils/abs/items";

/**
 * EditMetadataScreen — segmented Details / Cover / Match editor for one item.
 *
 * Route: "EditMetadata"  Params: { libraryItemId: string }
 *
 * - Details: full metadata form; Save PATCHes /api/items/:id/media with ONLY
 *   the dirty fields (a whole-object PATCH would clobber concurrent web edits).
 * - Cover: set-by-URL + provider cover search grid. Gallery upload is
 *   deliberately absent (no image-picker dependency — tracked in issue #61);
 *   the whole tab is gated on canUploadCover (the server's cover route needs
 *   the `upload` permission, not just `update`).
 * - Match: provider search → pick a candidate → choose-fields diff (defaults
 *   to fill-missing-only) → apply as a media PATCH (+ cover POST when chosen).
 *
 * Entry is capability-gated from ItemDetail, but the screen still renders a
 * read-only lock state for users without `update` (deep links, stale caps).
 */

type Tab = "details" | "cover" | "match";

const PROVIDERS: { id: string; label: string }[] = [
  { id: "audible", label: "Audible" },
  { id: "google", label: "Google Books" },
  { id: "itunes", label: "iTunes" },
  { id: "openlibrary", label: "Open Library" },
];

/** Comma-splitter for list fields: "a, b, , c" → ["a", "b", "c"]. */
export function splitList(s: string): string[] {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

interface FormState {
  title: string;
  subtitle: string;
  authors: string;
  narrators: string;
  seriesName: string;
  seriesSequence: string;
  genres: string;
  tags: string;
  description: string;
  publisher: string;
  publishedYear: string;
  language: string;
  isbn: string;
  asin: string;
  explicit: boolean;
  abridged: boolean;
}

function seedFromItem(it: any): FormState {
  const md = it?.media?.metadata || {};
  return {
    title: md.title || "",
    subtitle: md.subtitle || "",
    authors: (md.authors || [])
      .map((a: any) => a?.name)
      .filter(Boolean)
      .join(", "),
    narrators: (md.narrators || []).join(", "),
    seriesName: md.series?.[0]?.name || "",
    seriesSequence: md.series?.[0]?.sequence ? String(md.series[0].sequence) : "",
    genres: (md.genres || []).join(", "),
    tags: (it?.media?.tags || []).join(", "),
    description: md.description || "",
    publisher: md.publisher || "",
    publishedYear: md.publishedYear != null ? String(md.publishedYear) : "",
    language: md.language || "",
    isbn: md.isbn || "",
    asin: md.asin || "",
    explicit: !!md.explicit,
    abridged: !!md.abridged,
  };
}

/**
 * Diff form vs seed into the PATCH /api/items/:id/media payload — ONLY dirty
 * keys are included (metadata fields under `metadata`, tags top-level).
 *
 * `originalSeries` is the item's FULL metadata.series array: the form only
 * edits series[0], so a series patch is [edited head, ...untouched tail].
 * Without it a book in 2+ series would have every other series DROPPED
 * server-side (the PATCH replaces the whole array).
 * Exported for direct unit assertion.
 */
export function buildDirtyPatch(
  form: FormState,
  seed: FormState,
  originalSeries: any[] = []
): any {
  const md: any = {};
  const patch: any = {};
  const changed = (k: keyof FormState) => form[k] !== seed[k];

  if (changed("title")) md.title = form.title.trim();
  if (changed("subtitle")) md.subtitle = form.subtitle.trim() || null;
  if (changed("authors")) md.authors = splitList(form.authors).map((name) => ({ name }));
  if (changed("narrators")) md.narrators = splitList(form.narrators);
  if (changed("seriesName") || changed("seriesSequence")) {
    const name = form.seriesName.trim();
    const sequence = form.seriesSequence.trim();
    const head = name ? [{ name, ...(sequence ? { sequence } : {}) }] : [];
    // Preserve every series entry beyond the edited first one, verbatim
    // (ids intact so the server updates rather than re-creates them).
    const tail = (Array.isArray(originalSeries) ? originalSeries : []).slice(1);
    md.series = [...head, ...tail];
  }
  if (changed("genres")) md.genres = splitList(form.genres);
  if (changed("description")) md.description = form.description.trim() || null;
  if (changed("publisher")) md.publisher = form.publisher.trim() || null;
  if (changed("publishedYear")) md.publishedYear = form.publishedYear.trim() || null;
  if (changed("language")) md.language = form.language.trim() || null;
  if (changed("isbn")) md.isbn = form.isbn.trim() || null;
  if (changed("asin")) md.asin = form.asin.trim() || null;
  if (changed("explicit")) md.explicit = form.explicit;
  if (changed("abridged")) md.abridged = form.abridged;

  if (Object.keys(md).length > 0) patch.metadata = md;
  if (changed("tags")) patch.tags = splitList(form.tags);
  return patch;
}

// Fields the match choose-step can pull from a provider search result. Each
// row maps a candidate value + the current form value; `apply` folds the
// candidate into the metadata payload.
const MATCH_FIELDS: {
  key: string;
  label: string;
  candidate: (c: any) => string;
  current: (f: FormState) => string;
  apply: (md: any, c: any) => void;
}[] = [
  {
    key: "title",
    label: "Title",
    candidate: (c) => c.title || "",
    current: (f) => f.title,
    apply: (md, c) => (md.title = c.title),
  },
  {
    key: "subtitle",
    label: "Subtitle",
    candidate: (c) => c.subtitle || "",
    current: (f) => f.subtitle,
    apply: (md, c) => (md.subtitle = c.subtitle),
  },
  {
    key: "author",
    label: "Author",
    candidate: (c) => c.author || "",
    current: (f) => f.authors,
    apply: (md, c) => (md.authors = splitList(c.author).map((name: string) => ({ name }))),
  },
  {
    key: "narrator",
    label: "Narrator",
    candidate: (c) => c.narrator || (Array.isArray(c.narrators) ? c.narrators.join(", ") : ""),
    current: (f) => f.narrators,
    apply: (md, c) =>
      (md.narrators = splitList(
        c.narrator || (Array.isArray(c.narrators) ? c.narrators.join(", ") : "")
      )),
  },
  {
    key: "series",
    label: "Series",
    candidate: (c) => normalizeSeries(c.series).map((s) => s.name).join(", "),
    current: (f) => f.seriesName,
    apply: (md, c) => (md.series = normalizeSeries(c.series)),
  },
  {
    key: "description",
    label: "Description",
    candidate: (c) => c.description || "",
    current: (f) => f.description,
    apply: (md, c) => (md.description = c.description),
  },
  {
    key: "publisher",
    label: "Publisher",
    candidate: (c) => c.publisher || "",
    current: (f) => f.publisher,
    apply: (md, c) => (md.publisher = c.publisher),
  },
  {
    key: "publishedYear",
    label: "Publish year",
    candidate: (c) => (c.publishedYear != null ? String(c.publishedYear) : ""),
    current: (f) => f.publishedYear,
    apply: (md, c) => (md.publishedYear = String(c.publishedYear)),
  },
  {
    key: "genres",
    label: "Genres",
    candidate: (c) => (Array.isArray(c.genres) ? c.genres.join(", ") : c.genres || ""),
    current: (f) => f.genres,
    apply: (md, c) =>
      (md.genres = Array.isArray(c.genres) ? c.genres : splitList(String(c.genres || ""))),
  },
  {
    key: "language",
    label: "Language",
    candidate: (c) => c.language || "",
    current: (f) => f.language,
    apply: (md, c) => (md.language = c.language),
  },
  {
    key: "isbn",
    label: "ISBN",
    candidate: (c) => c.isbn || "",
    current: (f) => f.isbn,
    apply: (md, c) => (md.isbn = c.isbn),
  },
  {
    key: "asin",
    label: "ASIN",
    candidate: (c) => c.asin || "",
    current: (f) => f.asin,
    apply: (md, c) => (md.asin = c.asin),
  },
];

/** Providers return series as [{series|name, sequence}] or a plain string. */
function normalizeSeries(s: any): { name: string; sequence?: string }[] {
  if (!s) return [];
  if (typeof s === "string") return s.trim() ? [{ name: s.trim() }] : [];
  if (!Array.isArray(s)) return [];
  return s
    .map((x: any) =>
      typeof x === "string"
        ? { name: x }
        : {
            name: x?.series || x?.name || "",
            ...(x?.sequence != null && x.sequence !== "" ? { sequence: String(x.sequence) } : {}),
          }
    )
    .filter((x) => !!x.name);
}

// Module-scope so TextInputs don't remount per keystroke (PodcastSettings note).
function Field({
  label,
  helper,
  value,
  onChangeText,
  multiline,
  colors,
  keyboardType,
  autoCapitalize,
  returnKeyType,
  onSubmitEditing,
  inputRef,
}: {
  label: string;
  helper?: string;
  value: string;
  onChangeText: (t: string) => void;
  multiline?: boolean;
  colors: any;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  returnKeyType?: ReturnKeyTypeOptions;
  onSubmitEditing?: () => void;
  inputRef?: (r: TextInput | null) => void;
}) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
      <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>{label}</Text>
      {helper ? (
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>{helper}</Text>
      ) : null}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        multiline={!!multiline}
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize ?? (multiline ? "sentences" : "none")}
        autoCorrect={false}
        keyboardType={keyboardType}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        // Keep the keyboard up while "next" hops fields.
        submitBehavior={returnKeyType === "next" ? "submit" : undefined}
        placeholderTextColor={colors.onSurfaceVariant}
        style={{
          backgroundColor: colors.surfaceContainer,
          color: colors.onSurface,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 10,
          fontSize: 15,
          marginTop: 8,
          minHeight: multiline ? 120 : undefined,
          textAlignVertical: multiline ? "top" : "auto",
        }}
      />
    </View>
  );
}

function ToggleField({
  label,
  value,
  onValueChange,
  colors,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  colors: any;
}) {
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <Text style={{ flex: 1, color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
        {label}
      </Text>
      <View
        style={{
          width: 44,
          height: 26,
          borderRadius: 13,
          padding: 3,
          justifyContent: "center",
          backgroundColor: value ? colors.primary : colors.surfaceContainerHighest,
          alignItems: value ? "flex-end" : "flex-start",
        }}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: value ? colors.onPrimary : colors.outline,
          }}
        />
      </View>
    </Pressable>
  );
}

function Pill({
  label,
  onPress,
  disabled,
  busy,
  primary,
  colors,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  primary?: boolean;
  colors: any;
  accessibilityLabel?: string;
}) {
  const bg = primary ? colors.primary : colors.secondaryContainer;
  const fg = primary ? colors.onPrimary : colors.onSecondaryContainer;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      android_ripple={{ color: withAlpha(fg, 0.15) }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        marginHorizontal: 16,
        marginTop: 12,
        height: 48,
        borderRadius: 24,
        overflow: "hidden",
        backgroundColor: bg,
        opacity: disabled || busy ? 0.5 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Text style={{ color: fg, fontSize: 15, fontWeight: "700" }}>{label}</Text>
      )}
    </Pressable>
  );
}

export default function EditMetadataScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const { libraryItemId } = route?.params || {};
  const caps = useServerCapabilities();
  const serverConnectionConfig = useUserStore((s) => s.serverConnectionConfig);
  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const [tab, setTab] = useState<Tab>("details");
  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // Details form
  const [form, setForm] = useState<FormState>(seedFromItem(null));
  const [seed, setSeed] = useState<FormState>(seedFromItem(null));
  const [saving, setSaving] = useState(false);

  // Cover tab
  const [coverUrlInput, setCoverUrlInput] = useState("");
  const [coverQuery, setCoverQuery] = useState("");
  const [coverResults, setCoverResults] = useState<string[] | null>(null);
  const [coverSearching, setCoverSearching] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  // Bumped after a cover write so the preview cache-busts.
  const [coverBust, setCoverBust] = useState(0);

  // Match tab
  const [matchStage, setMatchStage] = useState<"search" | "results" | "fields">("search");
  const [provider, setProvider] = useState("audible");
  const [matchTitle, setMatchTitle] = useState("");
  const [matchAuthor, setMatchAuthor] = useState("");
  const [matchResults, setMatchResults] = useState<any[]>([]);
  const [matchSearching, setMatchSearching] = useState(false);
  const [candidate, setCandidate] = useState<any>(null);
  const [fieldChecks, setFieldChecks] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);

  const setField = (key: keyof FormState, value: any) =>
    setForm((f) => ({ ...f, [key]: value }));

  const reseed = (it: any) => {
    const s = seedFromItem(it);
    setSeed(s);
    setForm(s);
    setMatchTitle(s.title);
    setMatchAuthor(splitList(s.authors)[0] || "");
    setCoverQuery(s.title);
  };

  useEffect(() => {
    if (!libraryItemId) {
      setError("No item provided.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get(`/api/items/${libraryItemId}?expanded=1`);
        if (cancelled) return;
        setItem(res.data);
        reseed(res.data);
      } catch (err: any) {
        if (cancelled) return;
        setError(
          err?.response
            ? "Failed to load this item."
            : "You're offline. Reconnect to edit this item's details."
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryItemId, retryTick]);

  const originalSeries: any[] = item?.media?.metadata?.series || [];
  const patch = useMemo(
    () => buildDirtyPatch(form, seed, item?.media?.metadata?.series || []),
    [form, seed, item]
  );
  const dirty = Object.keys(patch).length > 0;
  const isPodcast = item?.mediaType === "podcast";

  // Unsaved-changes guard (ChapterEditor pattern): intercept ANY navigation
  // that would remove this screen while the form is dirty — hardware back
  // included, which a header-back-only guard misses. Refs keep the listener
  // stable.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty && !saving;
  useEffect(() => {
    if (!navigation?.addListener) return;
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      showAppDialog({
        title: "Discard changes?",
        message: "You have unsaved edits to this item's details.",
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

  // returnKeyType="next" focus chain through the Details form (Description is
  // multiline — return inserts a newline there, so it's not in the chain).
  const DETAILS_FOCUS_ORDER = [
    "title",
    "subtitle",
    "authors",
    "narrators",
    "seriesName",
    "seriesSequence",
    "genres",
    "tags",
    "publisher",
    "publishedYear",
    "language",
    "isbn",
    "asin",
  ] as const;
  const detailInputsRef = useRef<Record<string, TextInput | null>>({});
  const chainProps = (key: (typeof DETAILS_FOCUS_ORDER)[number]) => {
    const idx = DETAILS_FOCUS_ORDER.indexOf(key);
    const next = DETAILS_FOCUS_ORDER[idx + 1];
    return {
      inputRef: (r: TextInput | null) => {
        detailInputsRef.current[key] = r;
      },
      returnKeyType: (next ? "next" : "done") as ReturnKeyTypeOptions,
      onSubmitEditing: next ? () => detailInputsRef.current[next]?.focus() : undefined,
    };
  };

  const coverUri =
    libraryItemId && serverAddress && token
      ? `${serverAddress}/api/items/${libraryItemId}/cover?width=400&format=webp&token=${token}&ts=${coverBust}`
      : null;

  // --- Details save ----------------------------------------------------------

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const res = await updateItemMedia(libraryItemId, patch);
      // Prefer the server's echo as the new seed; otherwise the current form
      // IS the new truth (dirty resets either way).
      if (res?.libraryItem) {
        setItem(res.libraryItem);
        reseed(res.libraryItem);
      } else {
        setSeed(form);
      }
      showSnackbar({ message: "Details saved" });
    } catch (e: any) {
      showAppDialog({
        title: "Couldn't save",
        message: e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  // Header back goes through goBack() — the beforeRemove listener above owns
  // the dirty guard, so hardware back and header back share one code path.
  const handleBack = () => navigation.goBack();

  // --- Cover actions ----------------------------------------------------------

  const applyCover = async (url: string, successMessage: string) => {
    if (coverBusy) return;
    setCoverBusy(true);
    try {
      await setCoverFromUrl(libraryItemId, url);
      setCoverBust((n) => n + 1);
      setCoverUrlInput("");
      showSnackbar({ message: successMessage });
    } catch (e: any) {
      showAppDialog({
        title: "Couldn't update cover",
        message: e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      setCoverBusy(false);
    }
  };

  const handleCoverSearch = async () => {
    if (coverSearching) return;
    setCoverSearching(true);
    try {
      const results = await searchCovers({
        title: coverQuery.trim() || form.title,
        author: splitList(form.authors)[0] || undefined,
        podcast: isPodcast || undefined,
      });
      setCoverResults(results);
      // Announce the outcome — the grid pops in silently for screen readers.
      AccessibilityInfo.announceForAccessibility(
        results.length === 0
          ? "No covers found"
          : `${results.length} cover option${results.length === 1 ? "" : "s"} found`
      );
    } catch (e: any) {
      showAppDialog({
        title: "Cover search failed",
        message: e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      setCoverSearching(false);
    }
  };

  // Tier-1 like set-by-URL: picking a result applies instantly + snackbar —
  // the two cover paths must not sit on different confirmation tiers.
  const pickCoverResult = (url: string) => applyCover(url, "Cover updated");

  // --- Match flow ---------------------------------------------------------------

  const handleMatchSearch = async () => {
    if (matchSearching) return;
    setMatchSearching(true);
    try {
      const results = await searchBookMetadata({
        title: matchTitle.trim(),
        author: matchAuthor.trim() || undefined,
        provider,
      });
      setMatchResults(results);
      setMatchStage("results");
    } catch (e: any) {
      showAppDialog({
        title: "Search failed",
        message: e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      setMatchSearching(false);
    }
  };

  // Rows shown in the choose-fields step: candidate has a value that differs
  // from the current one. Cover is handled as an extra pseudo-row.
  const diffRows = useMemo(() => {
    if (!candidate) return [];
    return MATCH_FIELDS.map((fieldDef) => ({
      ...fieldDef,
      candidateValue: fieldDef.candidate(candidate),
      currentValue: fieldDef.current(form),
    })).filter((r) => r.candidateValue && r.candidateValue !== r.currentValue);
  }, [candidate, form]);
  const candidateCover: string = candidate?.cover || "";

  const pickCandidate = (c: any) => {
    setCandidate(c);
    // Fill-missing-only default: a field starts checked only when the current
    // value is EMPTY (the safest apply); overwrites are opt-in per field.
    const checks: Record<string, boolean> = {};
    MATCH_FIELDS.forEach((fieldDef) => {
      const cv = fieldDef.candidate(c);
      if (cv && cv !== fieldDef.current(form)) checks[fieldDef.key] = !fieldDef.current(form);
    });
    // Applying a matched cover is a cover UPLOAD — same permission gate as the
    // Cover tab. Default-checked only when the item has no cover yet.
    if (c?.cover && caps.canUploadCover) checks.cover = !item?.media?.coverPath;
    setFieldChecks(checks);
    setMatchStage("fields");
  };

  const doApplyMatch = async () => {
    setApplying(true);
    // Tracks the partial-failure case: the metadata PATCH landed but the
    // cover POST failed — the error copy must say so, not imply nothing stuck.
    let metadataApplied = false;
    try {
      const md: any = {};
      MATCH_FIELDS.forEach((fieldDef) => {
        if (fieldChecks[fieldDef.key]) fieldDef.apply(md, candidate);
      });
      if (Object.keys(md).length > 0) {
        await updateItemMedia(libraryItemId, { metadata: md });
        metadataApplied = true;
      }
      if (fieldChecks.cover && candidateCover) {
        await setCoverFromUrl(libraryItemId, candidateCover);
        setCoverBust((n) => n + 1);
      }
      const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label || provider;
      showSnackbar({ message: `Matched from ${providerLabel}` });
      // Refetch so the Details form reflects the applied fields.
      try {
        const res = await api.get(`/api/items/${libraryItemId}?expanded=1`);
        setItem(res.data);
        reseed(res.data);
      } catch {
        // Non-fatal — the PATCH landed; the form just keeps its pre-match seed.
      }
      setMatchStage("search");
      setCandidate(null);
    } catch (e: any) {
      showAppDialog({
        title: metadataApplied ? "Cover not applied" : "Couldn't apply match",
        message: metadataApplied
          ? `The matched details were saved, but the cover couldn't be updated${
              e?.message ? `: ${e.message}` : "."
            }`
          : e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      setApplying(false);
    }
  };

  const handleApplyMatch = () => {
    if (applying) return;
    const anythingChecked =
      diffRows.some((r) => fieldChecks[r.key]) || (fieldChecks.cover && !!candidateCover);
    if (!anythingChecked) return;
    const proceed = () => {
      // Tier-2 confirm ONLY when overwriting non-empty fields (fill-missing is safe).
      const overwriteCount = diffRows.filter((r) => fieldChecks[r.key] && r.currentValue).length;
      if (overwriteCount > 0) {
        showAppDialog({
          title: "Overwrite existing fields?",
          message: `This will overwrite ${overwriteCount} existing field${
            overwriteCount === 1 ? "" : "s"
          } with the matched values.`,
          buttons: [
            { text: "Cancel", style: "cancel" },
            { text: "Apply", style: "destructive", onPress: doApplyMatch },
          ],
        });
        return;
      }
      doApplyMatch();
    };
    // The post-apply reseed replaces the Details form — never silently clobber
    // unsaved edits sitting on that tab.
    if (dirty) {
      showAppDialog({
        title: "Unsaved edits on Details",
        message:
          "Applying this match reloads the Details form and discards your unsaved edits there.",
        buttons: [
          { text: "Keep editing", style: "cancel" },
          { text: "Apply match", style: "destructive", onPress: proceed },
        ],
      });
      return;
    }
    proceed();
  };

  // --- Render pieces -------------------------------------------------------------

  const TabChip = ({ value, label }: { value: Tab; label: string }) => {
    const active = tab === value;
    return (
      <Pressable
        onPress={() => setTab(value)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`${label} tab`}
        hitSlop={{ top: 6, bottom: 6 }}
        style={{
          paddingHorizontal: 18,
          height: 36,
          borderRadius: 18,
          alignItems: "center",
          justifyContent: "center",
          marginRight: 8,
          backgroundColor: active ? colors.secondaryContainer : "transparent",
          borderWidth: 1,
          borderColor: active ? colors.secondaryContainer : colors.outlineVariant,
        }}
      >
        <Text
          style={{
            color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
            fontSize: 14,
            fontWeight: "600",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  const renderDetails = () => (
    <>
      <Field
        label="Title"
        value={form.title}
        onChangeText={(t) => setField("title", t)}
        autoCapitalize="words"
        colors={colors}
        {...chainProps("title")}
      />
      <Field
        label="Subtitle"
        value={form.subtitle}
        onChangeText={(t) => setField("subtitle", t)}
        autoCapitalize="words"
        colors={colors}
        {...chainProps("subtitle")}
      />
      <Field
        label="Authors"
        helper="Separate with commas"
        value={form.authors}
        onChangeText={(t) => setField("authors", t)}
        autoCapitalize="words"
        colors={colors}
        {...chainProps("authors")}
      />
      <Field
        label="Narrators"
        helper="Separate with commas"
        value={form.narrators}
        onChangeText={(t) => setField("narrators", t)}
        autoCapitalize="words"
        colors={colors}
        {...chainProps("narrators")}
      />
      <Field
        label="Series"
        // The form edits the FIRST series only; a multi-series book keeps its
        // remaining entries untouched on save (buildDirtyPatch tail).
        helper={
          originalSeries.length > 1
            ? `+${originalSeries.length - 1} more series — kept unchanged`
            : undefined
        }
        value={form.seriesName}
        onChangeText={(t) => setField("seriesName", t)}
        autoCapitalize="words"
        colors={colors}
        {...chainProps("seriesName")}
      />
      <Field
        label="Series sequence"
        value={form.seriesSequence}
        onChangeText={(t) => setField("seriesSequence", t)}
        keyboardType="decimal-pad"
        colors={colors}
        {...chainProps("seriesSequence")}
      />
      <Field
        label="Genres"
        helper="Separate with commas"
        value={form.genres}
        onChangeText={(t) => setField("genres", t)}
        colors={colors}
        {...chainProps("genres")}
      />
      <Field
        label="Tags"
        helper="Separate with commas"
        value={form.tags}
        onChangeText={(t) => setField("tags", t)}
        colors={colors}
        {...chainProps("tags")}
      />
      <Field
        label="Description"
        multiline
        value={form.description}
        onChangeText={(t) => setField("description", t)}
        colors={colors}
      />
      <Field
        label="Publisher"
        value={form.publisher}
        onChangeText={(t) => setField("publisher", t)}
        autoCapitalize="words"
        colors={colors}
        {...chainProps("publisher")}
      />
      <Field
        label="Publish year"
        value={form.publishedYear}
        onChangeText={(t) => setField("publishedYear", t)}
        keyboardType="number-pad"
        colors={colors}
        {...chainProps("publishedYear")}
      />
      <Field
        label="Language"
        value={form.language}
        onChangeText={(t) => setField("language", t)}
        colors={colors}
        {...chainProps("language")}
      />
      <Field
        label="ISBN"
        value={form.isbn}
        onChangeText={(t) => setField("isbn", t)}
        colors={colors}
        {...chainProps("isbn")}
      />
      <Field
        label="ASIN"
        value={form.asin}
        onChangeText={(t) => setField("asin", t)}
        colors={colors}
        {...chainProps("asin")}
      />
      <ToggleField label="Explicit" value={form.explicit} onValueChange={(v) => setField("explicit", v)} colors={colors} />
      <ToggleField label="Abridged" value={form.abridged} onValueChange={(v) => setField("abridged", v)} colors={colors} />
    </>
  );

  const renderCover = () => {
    if (!caps.canUploadCover) {
      return (
        <EmptyState
          icon="lock"
          title="Permission needed"
          message="Changing covers needs the upload permission on your account."
        />
      );
    }
    return (
      <>
        <View style={{ alignItems: "center", paddingTop: 16 }}>
          <View
            style={{
              width: 160,
              height: 160,
              borderRadius: 12,
              overflow: "hidden",
              backgroundColor: colors.surfaceContainerHigh,
            }}
          >
            {coverUri ? (
              <Image source={{ uri: coverUri }} style={{ width: 160, height: 160 }} contentFit="cover" />
            ) : (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <Icon name="image" size={40} color={colors.onSurfaceVariant} />
              </View>
            )}
          </View>
        </View>

        <Field
          label="Cover image URL"
          helper="The server downloads the image from this address."
          value={coverUrlInput}
          onChangeText={setCoverUrlInput}
          keyboardType="url"
          autoCapitalize="none"
          colors={colors}
        />
        <Pill
          label="Set cover from URL"
          onPress={() => applyCover(coverUrlInput.trim(), "Cover updated")}
          disabled={!coverUrlInput.trim()}
          busy={coverBusy}
          primary
          colors={colors}
        />

        <Field label="Search covers" value={coverQuery} onChangeText={setCoverQuery} colors={colors} />
        <Pill
          label="Search covers"
          accessibilityLabel="Run cover search"
          onPress={handleCoverSearch}
          busy={coverSearching}
          colors={colors}
        />
        {coverResults !== null ? (
          coverResults.length === 0 ? (
            <EmptyState icon="image" title="No covers found" message="Try different search terms." />
          ) : (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                paddingHorizontal: 12,
                paddingTop: 16,
              }}
            >
              {coverResults.map((url, i) => (
                <Pressable
                  key={`${url}-${i}`}
                  onPress={() => pickCoverResult(url)}
                  accessibilityRole="button"
                  accessibilityLabel={`Cover option ${i + 1} of ${coverResults.length}`}
                  style={{ width: "33.33%", padding: 4 }}
                >
                  <Image
                    source={{ uri: url }}
                    style={{ width: "100%", aspectRatio: 1, borderRadius: 8 }}
                    contentFit="cover"
                  />
                </Pressable>
              ))}
            </View>
          )
        ) : null}
      </>
    );
  };

  const renderMatch = () => {
    if (matchStage === "fields" && candidate) {
      const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label || provider;
      // Cover apply = cover upload permission (same gate as the Cover tab).
      const coverRowVisible = !!candidateCover && caps.canUploadCover;
      return (
        <>
          <Text
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 13,
              paddingHorizontal: 16,
              paddingTop: 16,
            }}
          >
            Pick which fields to apply from {providerLabel}. Fields that would overwrite existing
            values start unchecked.
          </Text>
          {diffRows.map((row) => {
            const checked = !!fieldChecks[row.key];
            return (
              <Pressable
                key={row.key}
                onPress={() => setFieldChecks((c) => ({ ...c, [row.key]: !c[row.key] }))}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                accessibilityLabel={`${row.label}: current ${row.currentValue || "empty"}, proposed ${row.candidateValue}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.outlineVariant,
                }}
              >
                <View
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 6,
                    borderWidth: 2,
                    borderColor: checked ? colors.primary : colors.outline,
                    backgroundColor: checked ? colors.primary : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 14,
                  }}
                >
                  {checked ? <Icon name="check" size={16} color={colors.onPrimary} /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: "600" }}>
                    {row.label}
                  </Text>
                  {row.currentValue ? (
                    <Text numberOfLines={2} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                      {row.currentValue}
                    </Text>
                  ) : (
                    <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2, fontStyle: "italic" }}>
                      (empty)
                    </Text>
                  )}
                  <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 12, marginTop: 2 }}>
                    → {row.candidateValue}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {coverRowVisible ? (
            <Pressable
              onPress={() => setFieldChecks((c) => ({ ...c, cover: !c.cover }))}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: !!fieldChecks.cover }}
              accessibilityLabel="Cover: use the matched cover image"
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  borderWidth: 2,
                  borderColor: fieldChecks.cover ? colors.primary : colors.outline,
                  backgroundColor: fieldChecks.cover ? colors.primary : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: 14,
                }}
              >
                {fieldChecks.cover ? <Icon name="check" size={16} color={colors.onPrimary} /> : null}
              </View>
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: 14, fontWeight: "600" }}>
                Cover
              </Text>
              <Image
                source={{ uri: candidateCover }}
                style={{ width: 48, height: 48, borderRadius: 6 }}
                contentFit="cover"
              />
            </Pressable>
          ) : null}
          {diffRows.length === 0 && !coverRowVisible ? (
            <EmptyState icon="check" title="Nothing to apply" message="This match has no fields that differ from the current details." />
          ) : null}
          <Pill label="Apply match" onPress={handleApplyMatch} busy={applying} primary colors={colors} />
          <Pill label="Back to results" onPress={() => setMatchStage("results")} colors={colors} />
        </>
      );
    }

    if (matchStage === "results") {
      return (
        <>
          {matchResults.length === 0 ? (
            <EmptyState icon="search" title="No matches" message="Try editing the search terms." />
          ) : (
            matchResults.map((c: any, i: number) => (
              <Pressable
                key={i}
                onPress={() => pickCandidate(c)}
                accessibilityRole="button"
                accessibilityLabel={`Match result: ${c.title || "Untitled"}${c.author ? ` by ${c.author}` : ""}`}
                android_ripple={{ color: withAlpha(colors.onSurface, 0.1) }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.outlineVariant,
                }}
              >
                <View
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 8,
                    overflow: "hidden",
                    backgroundColor: colors.surfaceContainerHighest,
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 12,
                  }}
                >
                  {c.cover ? (
                    <Image source={{ uri: c.cover }} style={{ width: 56, height: 56 }} contentFit="cover" />
                  ) : (
                    <Icon name="book" size={24} color={colors.onSurfaceVariant} />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
                    {c.title || "Untitled"}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    {[c.author, c.publishedYear].filter(Boolean).join(" · ")}
                  </Text>
                </View>
              </Pressable>
            ))
          )}
          <Pill label="Edit search" onPress={() => setMatchStage("search")} colors={colors} />
        </>
      );
    }

    // search stage
    return (
      <>
        <Text
          style={{
            color: colors.onSurface,
            fontSize: 15,
            fontWeight: "600",
            paddingHorizontal: 16,
            paddingTop: 16,
          }}
        >
          Provider
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, alignItems: "center" }}
        >
          {PROVIDERS.map((p) => {
            const active = provider === p.id;
            return (
              <Pressable
                key={p.id}
                onPress={() => setProvider(p.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Provider: ${p.label}`}
                hitSlop={{ top: 6, bottom: 6 }}
                style={{
                  paddingHorizontal: 14,
                  height: 34,
                  borderRadius: 17,
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: 8,
                  backgroundColor: active ? colors.secondaryContainer : "transparent",
                  borderWidth: 1,
                  borderColor: active ? colors.secondaryContainer : colors.outlineVariant,
                }}
              >
                <Text
                  style={{
                    color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Field label="Search title" value={matchTitle} onChangeText={setMatchTitle} colors={colors} />
        <Field label="Search author" value={matchAuthor} onChangeText={setMatchAuthor} colors={colors} />
        <Pill
          label="Search"
          accessibilityLabel="Search provider"
          onPress={handleMatchSearch}
          disabled={!matchTitle.trim()}
          busy={matchSearching}
          primary
          colors={colors}
        />
      </>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Settings-family header: back + title + Save (details tab only). */}
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
          onPress={handleBack}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
          Edit metadata
        </Text>
        {tab === "details" && caps.canEditMetadata && !loading && !error ? (
          <Pressable
            onPress={handleSave}
            disabled={!dirty || saving}
            accessibilityRole="button"
            accessibilityLabel="Save details"
            accessibilityState={{ disabled: !dirty || saving, busy: saving }}
            hitSlop={8}
            style={{ paddingHorizontal: 8, paddingVertical: 6, opacity: !dirty || saving ? 0.4 : 1 }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "700" }}>Save</Text>
            )}
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          message={error}
          onRetry={libraryItemId ? () => setRetryTick((t) => t + 1) : undefined}
        />
      ) : !caps.canEditMetadata ? (
        // Read-only lock — entry points are gated, but deep links/stale caps
        // must not render an editable form the server will 403.
        <EmptyState
          icon="lock"
          title="Permission needed"
          message="Your account doesn't have permission to edit this item's details."
          style={{ flex: 1 }}
        />
      ) : (
        <>
          <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 12 }}>
            <TabChip value="details" label="Details" />
            <TabChip value="cover" label="Cover" />
            <TabChip value="match" label="Match" />
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 48 }}
            keyboardShouldPersistTaps="handled"
          >
            {tab === "details" ? renderDetails() : tab === "cover" ? renderCover() : renderMatch()}
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}
