import React from "react";
import Icon, { IconName } from "./Icon";

/**
 * Renders the icon the ABS SERVER assigned to a library (Settings → Library →
 * icon on the server's web UI) — the parity feature the original app had via
 * the abs-icons font. The server sends one of a fixed set of names on
 * /api/libraries; unknown/missing names fall back by media type.
 *
 * Android Auto maps the same SERVER NAMES natively (absLibraryIconRes in the
 * track-player patch) onto bundled drawables. Keep the recognized NAME LISTS
 * in sync. Glyphs are visually equivalent across the two sets even where the
 * internal names differ — e.g. "book-1"/"audiobookshelf" render menu-book in
 * both (the app's "book" glyph IS aa_library's path). The one deliberate
 * divergence: "podcast" uses the podcast glyph here but a mic drawable in AA
 * (no podcast vector is bundled natively).
 */
export const ABS_ICON_MAP: Record<string, IconName> = {
  database: "database",
  audiobookshelf: "book", // menu-book — same glyph as AA's aa_library
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

/**
 * The pickable ABS library icons, in the ABS web-UI order. Sourced from the
 * ABS_ICON_MAP keys so the picker can never offer a name LibraryIcon can't
 * render (an unknown key would fall back to the media-type default). Raw ABS
 * keys — the value stored on the library and sent back to the server.
 */
export const ABS_LIBRARY_ICONS: string[] = [
  "database",
  "audiobookshelf",
  "books-1",
  "books-2",
  "book-1",
  "microphone-1",
  "microphone-3",
  "radio",
  "podcast",
  "rss",
  "headphones",
  "music",
  "file-picture",
  "rocket",
  "power",
  "star",
  "heart",
].filter((key) => key in ABS_ICON_MAP);

/**
 * Human-readable labels for the ABS icon keys — the raw keys ("books-1",
 * "microphone-3") are meaningless to a screen reader (and two mic keys share a
 * glyph), so the picker announces these instead. Numbered variants are
 * disambiguated so TalkBack users can tell them apart.
 */
export const ABS_ICON_LABELS: Record<string, string> = {
  database: "Database",
  audiobookshelf: "Audiobookshelf",
  "books-1": "Books",
  "books-2": "Book stack",
  "book-1": "Book",
  "microphone-1": "Microphone",
  "microphone-3": "Microphone (alt)",
  radio: "Radio",
  podcast: "Podcast",
  rss: "RSS",
  headphones: "Headphones",
  music: "Music",
  "file-picture": "Picture",
  rocket: "Rocket",
  power: "Power",
  star: "Star",
  heart: "Heart",
};

/** Human label for an ABS icon key (falls back to the raw key). */
export function libraryIconLabel(icon: string): string {
  return ABS_ICON_LABELS[icon] || icon;
}

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
