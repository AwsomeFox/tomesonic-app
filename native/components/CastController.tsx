import { useEffect, useRef } from "react";
import TrackPlayer from "react-native-track-player";
import { useRemoteMediaClient } from "react-native-google-cast";
import {
  usePlaybackStore,
  restoreLocalNowPlayingMeta,
  persistCastProgressSample,
} from "../store/usePlaybackStore";
import { storageHelper } from "../utils/storage";

/**
 * Bridges local playback ↔ Chromecast.
 * - On connect: loads the whole book as a cast queue at the current position and
 *   hands transport control off to the cast client (see usePlaybackStore routing).
 * - While casting: mirrors the receiver's progress + play state back into the store
 *   so the in-app Player/MiniPlayer stay in sync.
 * - On disconnect: resumes local playback where the cast left off.
 */
export default function CastController() {
  const client = useRemoteMediaClient();
  const currentSession = usePlaybackStore((s) => s.currentSession);
  const setCastState = usePlaybackStore((s) => s.setCastState);

  const loadedKeyRef = useRef<string | null>(null);
  const wasCastingRef = useRef(false);
  const offsetsRef = useRef<number[]>([]); // cumulative start (s) per queue item
  const baseOffsetRef = useRef(0); // offset of the currently-playing item
  const currentIdxRef = useRef(0); // queue index of the currently-playing item
  const itemsRef = useRef<any[]>([]); // the built queue items (for cross-track jumps)
  // Progress "settle" guard: right after loadMedia (connect or cross-track
  // seek) the receiver briefly reports positions from BEFORE the pending seek
  // (track start / stale item) — mirroring those makes the scrubber jump to
  // the beginning then snap back. Skip mirroring until the receiver reports
  // near the expected target (or the guard times out as a fail-safe).
  const settleRef = useRef<{ target: number; until: number } | null>(null);
  const SETTLE_EPSILON_S = 12;
  const SETTLE_TIMEOUT_MS = 10000;
  // Generation token for the async connect/load chain: bumped on every client
  // or session change so a stale loadMedia resolving late can't re-register a
  // dead seek handler or clobber the dedupe key of a healthy newer load.
  const genRef = useRef(0);
  // Cast SUSPENSION (wifi blip / backgrounding) surfaces as client → null →
  // new client. Treating the null as a real disconnect blasted local audio
  // over the still-playing TV and reloaded the whole queue on resume — so the
  // handback is deferred for a grace period and cancelled if a client returns.
  const pendingHandbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SUSPEND_GRACE_MS = 5000;

  // Register the ABSOLUTE seek handler for the store. The cast client's
  // seek() only moves within the CURRENT queue item, so a seek crossing a
  // file boundary (multi-file books: big jumps, chapter next/prev) must
  // reload the queue at the target index — otherwise the position lands at
  // the wrong spot inside the current file. Extracted so the suspend-resume
  // path can re-point it at the NEW client object without a queue reload.
  const registerSeekHandler = (activeClient: any) => {
    usePlaybackStore.getState().setCastSeekHandler(async (absSeconds: number) => {
      const offs = offsetsRef.current;
      const qItems = itemsRef.current;
      if (!offs.length || !qItems.length) return;
      let idx = offs.findIndex(
        (s, i) => absSeconds >= s && (i === offs.length - 1 || absSeconds < offs[i + 1])
      );
      if (idx < 0) idx = absSeconds <= 0 ? 0 : offs.length - 1;
      const within = Math.max(0, absSeconds - offs[idx]);
      // Ignore progress mirrors until the receiver lands at the target —
      // otherwise the last pre-seek tick rubber-bands the scrubber back.
      settleRef.current = { target: absSeconds, until: Date.now() + SETTLE_TIMEOUT_MS };
      const prevBase = baseOffsetRef.current;
      const prevIdx = currentIdxRef.current;
      try {
        if (idx === currentIdxRef.current) {
          await activeClient.seek({ position: within });
        } else {
          // Cross-track: reload the queue at the target item. Preserves
          // play state via autoplay from the current store state.
          const wasPlaying = usePlaybackStore.getState().isPlaying;
          baseOffsetRef.current = offs[idx];
          currentIdxRef.current = idx;
          // Clear any per-item startTime left from the ORIGINAL connect —
          // the receiver honors it whenever the queue naturally reaches
          // that item, silently skipping everything before the old offset.
          for (const it of qItems) delete (it as any).startTime;
          await activeClient.loadMedia({
            queueData: { items: qItems, startIndex: idx } as any,
            startTime: within,
            autoplay: wasPlaying,
          });
          const r = usePlaybackStore.getState().playbackSpeed || 1;
          if (r !== 1) {
            try { await activeClient.setPlaybackRate(r); } catch {}
          }
        }
      } catch (e) {
        // Failed seek: un-arm the settle guard (it was suppressing the
        // receiver's TRUE position as "pre-seek noise" for the full timeout)
        // and roll the refs back so mirrors re-base against reality.
        settleRef.current = null;
        baseOffsetRef.current = prevBase;
        currentIdxRef.current = prevIdx;
        throw e;
      }
    });
  };

  // Register/unregister the client for transport routing, and resume local on
  // disconnect.
  useEffect(() => {
    genRef.current++;
    if (client) {
      // A client (re)appeared — cancel any pending suspend-handback.
      if (pendingHandbackRef.current) {
        clearTimeout(pendingHandbackRef.current);
        pendingHandbackRef.current = null;
      }
      const resumedSameBook = wasCastingRef.current && loadedKeyRef.current != null;
      setCastState(client);
      wasCastingRef.current = true;
      if (resumedSameBook) {
        // Suspension resumed with the SAME queue still on the receiver — do
        // NOT reload (the load effect dedupes on loadedKeyRef); just point
        // the absolute-seek handler at the new client object.
        registerSeekHandler(client);
      }
      return;
    }
    if (!wasCastingRef.current || pendingHandbackRef.current) return;
    // Client dropped: wait out the suspension grace before treating it as a
    // real disconnect (suspend/resume must not blast local audio over the
    // still-playing TV or reload the receiver queue).
    pendingHandbackRef.current = setTimeout(() => {
      pendingHandbackRef.current = null;
      genRef.current++;
      wasCastingRef.current = false;
      loadedKeyRef.current = null;
      settleRef.current = null;
      setCastState(null);
      usePlaybackStore.getState().setCastSeekHandler(null);
      const pos = usePlaybackStore.getState().position;
      // Respect the receiver's play state at disconnect: if the cast was
      // paused, resume LOCAL playback paused too instead of blasting audio.
      const wasPlaying = usePlaybackStore.getState().isPlaying;
      (async () => {
        try {
          // Route through the store's seek — with a chapter-clipped local
          // queue a raw TrackPlayer.seekTo(absolute) lands in the wrong spot
          // (each queue item is chapter-relative). setCastState(null) already
          // ran above, so seek() takes the local path with chapter mapping.
          await usePlaybackStore.getState().seek(pos);
          // While casting the progress loop rewrote the paused local item's
          // title to the receiver's chapter — put the true one back.
          await restoreLocalNowPlayingMeta();
          // A sleep-timer fade may have lowered the local volume during the
          // cast session — never resume local playback quiet.
          TrackPlayer.setVolume(1).catch(() => {});
          if (wasPlaying) {
            await TrackPlayer.play();
            usePlaybackStore.setState({ isPlaying: true });
          }
        } catch (e) {
          console.warn("[Cast] resume local failed", e);
        }
      })();
    }, SUSPEND_GRACE_MS);
  }, [client]);

  // Mirror the receiver's progress + play state into the store.
  useEffect(() => {
    if (!client) return;
    const subs: any[] = [];
    subs.push(
      client.onMediaProgressUpdated((progress: number) => {
        const abs = baseOffsetRef.current + progress;
        // Never mirror garbage into the store — NaN/negative would flow into
        // the 1s persistence loop (MMKV session save + server sync payloads).
        if (!Number.isFinite(abs) || abs < 0) return;
        const dur = usePlaybackStore.getState().duration;
        if (dur > 0 && abs > dur + 60) return;
        const settle = settleRef.current;
        if (settle) {
          const settled = Math.abs(abs - settle.target) <= SETTLE_EPSILON_S;
          if (!settled && Date.now() < settle.until) return; // pre-seek noise — don't mirror
          settleRef.current = null;
        }
        usePlaybackStore.setState({ position: abs });
        // Event-driven persistence: with the screen off, the JS 1s interval
        // (previously the ONLY cast-persistence driver) is throttled — these
        // receiver callbacks arrive as native events regardless, so feed the
        // sample through the same throttled save/sync pipeline.
        persistCastProgressSample(abs);
      }, 1)
    );
    subs.push(
      client.onMediaStatusUpdated((status: any) => {
        if (!status) return;
        const items = status.queueItems || [];
        // Guard the null==null footgun: an id-less status would "match" the
        // first id-less item and silently rebase to track 1.
        const idx =
          status.currentItemId == null
            ? -1
            : items.findIndex((it: any) => it?.itemId === status.currentItemId);
        if (idx >= 0 && offsetsRef.current[idx] != null) {
          baseOffsetRef.current = offsetsRef.current[idx];
          currentIdxRef.current = idx;
        }
        const ps = status.playerState;
        if (ps === "playing" || ps === "buffering") usePlaybackStore.setState({ isPlaying: true });
        else if (ps === "paused" || ps === "idle") usePlaybackStore.setState({ isPlaying: false });
      })
    );
    return () => subs.forEach((s) => s?.remove?.());
  }, [client]);

  // Load the current book onto the receiver as a full queue.
  useEffect(() => {
    // Session closed (playback dismissed) — drop the dedupe key so re-opening
    // the SAME book while the cast session is still connected loads again
    // (otherwise: isPlaying true, receiver empty, silence).
    if (!currentSession) {
      loadedKeyRef.current = null;
      return;
    }
    if (!client) return;
    const itemId = currentSession.libraryItemId || currentSession.libraryItem?.id;
    const key = `${itemId}@${currentSession.episodeId || ""}`;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    const gen = ++genRef.current;

    (async () => {
      try {
        const serverConfig = storageHelper.getServerConfig();
        const serverAddress = (serverConfig?.address || "").replace(/\/$/, "");
        const token = serverConfig?.token || "";
        const abs = (url: string) => {
          if (!url) return url;
          const full = url.startsWith("http") ? url : `${serverAddress}${url}`;
          return token && !full.includes("token=")
            ? full + (full.includes("?") ? "&" : "?") + `token=${token}`
            : full;
        };

        const tracks = currentSession.audioTracks || currentSession.tracks || [];
        if (!tracks.length) {
          // Clear the dedupe key so a later session for the same book (with
          // tracks this time) isn't silently skipped.
          loadedKeyRef.current = null;
          return;
        }
        const coverUrl =
          currentSession.coverUrl ||
          (itemId && serverAddress
            ? `${serverAddress}/api/items/${itemId}/cover?width=800&format=webp&token=${token}`
            : undefined);

        // Build the queue + cumulative offsets so the whole book plays.
        let acc = 0;
        const offsets: number[] = [];
        const items = tracks.map((t: any) => {
          const start = typeof t.startOffset === "number" ? t.startOffset : acc;
          offsets.push(start);
          acc = start + (t.duration || 0);
          return {
            mediaInfo: {
              contentUrl: abs(t.contentUrl),
              contentType: t.mimeType || "audio/mpeg",
              streamType: "buffered" as any,
              streamDuration: t.duration,
              metadata: {
                type: "generic" as const,
                title: currentSession.displayTitle || "Audiobook",
                subtitle: currentSession.displayAuthor || "",
                images: coverUrl ? [{ url: coverUrl }] : undefined,
              },
            },
            playbackDuration: t.duration,
          } as any;
        });
        offsetsRef.current = offsets;
        itemsRef.current = items;

        const pos = usePlaybackStore.getState().position || currentSession.currentTime || 0;
        let startIndex = offsets.findIndex((s, i) => pos < s + (tracks[i].duration || 0));
        if (startIndex < 0) startIndex = 0;
        const startTime = Math.max(0, pos - offsets[startIndex]);
        baseOffsetRef.current = offsets[startIndex];
        currentIdxRef.current = startIndex;
        items[startIndex].startTime = startTime;

        // Hand off play state seamlessly: pause the LOCAL player BEFORE the
        // receiver loads (no double-audio overlap), and only autoplay on the
        // receiver if the book was actually playing — connecting while paused
        // must not start blasting the TV.
        const wasPlaying = usePlaybackStore.getState().isPlaying;
        try {
          await TrackPlayer.pause();
        } catch {}
        // Don't mirror the receiver's pre-seek positions (it loads the item
        // at 0 before seeking to startTime) — that's the visible "starts at
        // the beginning then jumps" on connect.
        settleRef.current = { target: pos, until: Date.now() + SETTLE_TIMEOUT_MS };
        await client.loadMedia({
          queueData: { items, startIndex } as any,
          startTime,
          autoplay: wasPlaying,
        });
        // A newer load / disconnect superseded us while loadMedia was in
        // flight — don't re-apply rate or register a handler for a dead run.
        if (gen !== genRef.current) return;
        // Casting must respect the user's playback speed: the receiver starts
        // at 1× on every load, so re-apply the current rate here (and again
        // after any cross-track queue reload below).
        const rate = usePlaybackStore.getState().playbackSpeed || 1;
        if (rate !== 1) {
          try { await client.setPlaybackRate(rate); } catch (e) { console.warn("[Cast] rate", e); }
        }

        registerSeekHandler(client);
      } catch (e) {
        console.warn("[Cast] loadMedia failed", e);
        // Only invalidate the dedupe key if WE are still the current load —
        // a stale load rejecting late must not clobber a healthy newer one
        // (that turned a mere speed change into a full queue reload).
        if (gen === genRef.current) loadedKeyRef.current = null;
      }
    })();
  }, [client, currentSession]);

  return null;
}
