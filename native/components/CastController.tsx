import { useEffect, useRef } from "react";
import TrackPlayer from "react-native-track-player";
import { useRemoteMediaClient } from "react-native-google-cast";
import { usePlaybackStore } from "../store/usePlaybackStore";
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

  // Register/unregister the client for transport routing, and resume local on
  // disconnect.
  useEffect(() => {
    setCastState(client || null);
    if (client) {
      wasCastingRef.current = true;
    } else if (wasCastingRef.current) {
      wasCastingRef.current = false;
      loadedKeyRef.current = null;
      const pos = usePlaybackStore.getState().position;
      (async () => {
        try {
          // Route through the store's seek — with a chapter-clipped local
          // queue a raw TrackPlayer.seekTo(absolute) lands in the wrong spot
          // (each queue item is chapter-relative). setCastState(null) already
          // ran above, so seek() takes the local path with chapter mapping.
          await usePlaybackStore.getState().seek(pos);
          await TrackPlayer.play();
          usePlaybackStore.setState({ isPlaying: true });
        } catch (e) {
          console.warn("[Cast] resume local failed", e);
        }
      })();
    }
  }, [client]);

  // Mirror the receiver's progress + play state into the store.
  useEffect(() => {
    if (!client) return;
    const subs: any[] = [];
    subs.push(
      client.onMediaProgressUpdated((progress: number) => {
        usePlaybackStore.setState({ position: baseOffsetRef.current + progress });
      }, 1)
    );
    subs.push(
      client.onMediaStatusUpdated((status: any) => {
        if (!status) return;
        const items = status.queueItems || [];
        const idx = items.findIndex((it: any) => it.itemId === status.currentItemId);
        if (idx >= 0 && offsetsRef.current[idx] != null) {
          baseOffsetRef.current = offsetsRef.current[idx];
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
    if (!client || !currentSession) return;
    const itemId = currentSession.libraryItemId || currentSession.libraryItem?.id;
    const key = `${itemId}@${currentSession.episodeId || ""}`;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;

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
        if (!tracks.length) return;
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

        const pos = usePlaybackStore.getState().position || currentSession.currentTime || 0;
        let startIndex = offsets.findIndex((s, i) => pos < s + (tracks[i].duration || 0));
        if (startIndex < 0) startIndex = 0;
        const startTime = Math.max(0, pos - offsets[startIndex]);
        baseOffsetRef.current = offsets[startIndex];
        items[startIndex].startTime = startTime;

        await client.loadMedia({
          queueData: { items, startIndex } as any,
          startTime,
          autoplay: true,
        });
        try {
          await TrackPlayer.pause();
        } catch {}
      } catch (e) {
        console.warn("[Cast] loadMedia failed", e);
        loadedKeyRef.current = null;
      }
    })();
  }, [client, currentSession]);

  return null;
}
