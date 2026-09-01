import React from "react";
import { useDownloadStore } from "../store/useDownloadStore";

export type EpisodeDownloadState = {
  /** This episode's activeDownloads entry (pending/downloading/failed), or null. */
  epActiveDl: any;
  /** True when the episode's file is on disk and no retry/redownload is running. */
  epDownloaded: boolean;
};

/**
 * Per-episode download-state boundary for podcast episode rows.
 *
 * The episode lists (ItemDetail's episodes section, Latest Episodes) used to
 * subscribe the WHOLE screen to activeDownloads/completedDownloads and index
 * per row — so every ≥1% progress write of ANY download re-rendered every row
 * on screen for the whole download. Subscribing per COMPOSITE KEY here means a
 * progress write re-renders exactly one row: the episode actually downloading.
 *
 * Deliberately a children-function, not a memoized row: the row JSX stays in
 * the screen (it reads screen state — handlers, filter, spinner ids), and the
 * isolation comes from the SCREEN no longer subscribing to the maps at all.
 * When the screen re-renders for its own reasons the row re-renders with it,
 * which is correct — the closure always carries current screen state.
 */
export function EpisodeDownloadLive({
  downloadKey,
  children,
}: {
  downloadKey: string;
  children: (live: EpisodeDownloadState) => React.ReactElement;
}) {
  const epActiveDl =
    useDownloadStore((s) => (downloadKey ? s.activeDownloads[downloadKey] : undefined)) ?? null;
  const epCompleted = useDownloadStore((s) => !!(downloadKey && s.completedDownloads[downloadKey]));
  return children({ epActiveDl, epDownloaded: epCompleted && !epActiveDl });
}

export default EpisodeDownloadLive;
