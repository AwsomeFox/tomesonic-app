import React from "react";
import Icon, { IconName } from "./Icon";

/**
 * Renders the icon the ABS SERVER assigned to a library (Settings → Library →
 * icon on the server's web UI) — the parity feature the original app had via
 * the abs-icons font. The server sends one of a fixed set of names on
 * /api/libraries; unknown/missing names fall back by media type.
 *
 * The same name→glyph mapping exists natively for Android Auto
 * (absLibraryIconRes in the track-player patch) — keep the two in sync.
 */
export const ABS_ICON_MAP: Record<string, IconName> = {
  database: "database",
  audiobookshelf: "library",
  "books-1": "books",
  "books-2": "collections",
  "book-1": "book",
  "microphone-1": "mic",
  "microphone-3": "mic",
  radio: "radio",
  podcast: "podcast",
  rss: "rss",
  headphones: "headphones",
  music: "music",
  "file-picture": "image",
  rocket: "rocket",
  power: "power",
  star: "star",
  heart: "heart",
};

export function libraryIconName(icon?: string | null, mediaType?: string | null): IconName {
  if (icon && ABS_ICON_MAP[icon]) return ABS_ICON_MAP[icon];
  return mediaType === "podcast" ? "podcast" : "library";
}

export default function LibraryIcon({
  icon,
  mediaType,
  size = 22,
  color,
  style,
}: {
  icon?: string | null;
  mediaType?: string | null;
  size?: number;
  color: string;
  style?: any;
}) {
  return <Icon name={libraryIconName(icon, mediaType)} size={size} color={color} style={style} />;
}
