import React from "react";
import { MaterialIcons, MaterialCommunityIcons } from "@expo/vector-icons";

/**
 * Icon abstraction backed by @expo/vector-icons (Material Symbols), chosen to
 * match the original tomesonic app's iconography. Single swap-point for all
 * call sites via the stable IconName union.
 */
export type IconName =
  | "menu"
  | "search"
  | "filter"
  | "sort"
  | "back"
  | "close"
  | "chevron-down"
  | "chevron-up"
  | "chevron-right"
  | "chevron-left"
  | "home"
  | "library"
  | "series"
  | "collections"
  | "authors"
  | "account"
  | "stats"
  | "folder"
  | "settings"
  | "logs"
  | "globe"
  | "logout"
  | "play"
  | "pause"
  | "download"
  | "cloud"
  | "cloud-sync"
  | "cloud-off"
  | "book"
  | "clock"
  | "check"
  | "replay-10"
  | "replay-30"
  | "forward-30"
  | "rewind-5"
  | "rewind-10"
  | "rewind-15"
  | "rewind-30"
  | "rewind-45"
  | "rewind-60"
  | "fast-forward-5"
  | "fast-forward-10"
  | "fast-forward-15"
  | "fast-forward-30"
  | "fast-forward-45"
  | "fast-forward-60"
  | "skip-previous"
  | "skip-next"
  | "more-vert"
  | "moon"
  | "play-triangle"
  | "speed"
  | "timer"
  | "list"
  | "bookmark"
  | "cast"
  | "warning"
  | "podcast"
  | "headphones"
  | "auto-stories"
  | "share"
  | "send"
  | "explore"
  | "heart"
  | "undo"
  | "copy"
  | "trash"
  | "refresh"
  | "restore"
  | "edit"
  | "calendar"
  | "info"
  | "person"
  | "screen-rotation"
  | "vibration"
  | "palette"
  | "color-fill"
  | "replay"
  | "lock"
  | "add"
  | "playlist-add"
  | "eye"
  | "eye-off"
  // ABS library-icon glyphs (server-chosen per library; see LibraryIcon).
  | "database"
  | "radio"
  | "rss"
  | "music"
  | "image"
  | "rocket"
  | "power"
  | "star"
  | "mic"
  | "books"
  | "bell"
  // Generic in-progress/activity glyph (server task rows).
  | "activity";

type Family = "mi" | "mci";

// name -> [family, glyph]
const MAP: Record<IconName, [Family, string]> = {
  menu: ["mi", "menu"],
  search: ["mi", "search"],
  filter: ["mi", "tune"],
  sort: ["mi", "swap-vert"],
  back: ["mi", "arrow-back"],
  close: ["mi", "close"],
  "chevron-down": ["mi", "keyboard-arrow-down"],
  "chevron-up": ["mi", "keyboard-arrow-up"],
  "chevron-right": ["mi", "chevron-right"],
  "chevron-left": ["mi", "chevron-left"],
  home: ["mi", "home"],
  library: ["mci", "database"],
  series: ["mci", "bookshelf"],
  collections: ["mi", "collections-bookmark"],
  authors: ["mi", "people"],
  account: ["mi", "person"],
  stats: ["mi", "bar-chart"],
  folder: ["mi", "folder"],
  settings: ["mi", "settings"],
  logs: ["mi", "bug-report"],
  globe: ["mi", "language"],
  logout: ["mi", "logout"],
  play: ["mi", "play-arrow"],
  pause: ["mi", "pause"],
  download: ["mi", "file-download"],
  cloud: ["mi", "cloud-done"],
  "cloud-sync": ["mi", "cloud-sync"],
  "cloud-off": ["mi", "cloud-off"],
  book: ["mi", "menu-book"],
  clock: ["mi", "schedule"],
  check: ["mi", "check"],
  "replay-10": ["mi", "replay-10"],
  "replay-30": ["mi", "replay-30"],
  "forward-30": ["mi", "forward-30"],
  "rewind-5": ["mci", "rewind-5"],
  "rewind-10": ["mci", "rewind-10"],
  "rewind-15": ["mci", "rewind-15"],
  "rewind-30": ["mci", "rewind-30"],
  "rewind-45": ["mci", "rewind-45"],
  "rewind-60": ["mci", "rewind-60"],
  "fast-forward-5": ["mci", "fast-forward-5"],
  "fast-forward-10": ["mci", "fast-forward-10"],
  "fast-forward-15": ["mci", "fast-forward-15"],
  "fast-forward-30": ["mci", "fast-forward-30"],
  "fast-forward-45": ["mci", "fast-forward-45"],
  "fast-forward-60": ["mci", "fast-forward-60"],
  "skip-previous": ["mi", "skip-previous"],
  "skip-next": ["mi", "skip-next"],
  "more-vert": ["mi", "more-vert"],
  moon: ["mi", "bedtime"],
  "play-triangle": ["mi", "play-arrow"],
  speed: ["mi", "speed"],
  timer: ["mi", "timer"],
  list: ["mi", "format-list-bulleted"],
  bookmark: ["mi", "bookmark-border"],
  cast: ["mi", "cast"],
  warning: ["mi", "error-outline"],
  podcast: ["mci", "podcast"],
  headphones: ["mi", "headphones"],
  "auto-stories": ["mi", "auto-stories"],
  share: ["mi", "share"],
  send: ["mi", "send"],
  explore: ["mi", "explore"],
  heart: ["mi", "favorite"],
  undo: ["mi", "undo"],
  copy: ["mi", "content-copy"],
  trash: ["mi", "delete-outline"],
  refresh: ["mi", "refresh"],
  restore: ["mi", "settings-backup-restore"],
  edit: ["mi", "edit"],
  calendar: ["mi", "calendar-today"],
  info: ["mi", "info-outline"],
  person: ["mi", "person"],
  "screen-rotation": ["mi", "screen-lock-rotation"],
  vibration: ["mi", "vibration"],
  palette: ["mi", "palette"],
  "color-fill": ["mci", "format-color-fill"],
  replay: ["mi", "replay"],
  lock: ["mi", "lock-outline"],
  add: ["mi", "add"],
  "playlist-add": ["mi", "playlist-add"],
  eye: ["mi", "visibility"],
  "eye-off": ["mi", "visibility-off"],
  database: ["mi", "storage"],
  radio: ["mi", "radio"],
  rss: ["mi", "rss-feed"],
  music: ["mi", "music-note"],
  image: ["mi", "image"],
  rocket: ["mi", "rocket-launch"],
  power: ["mi", "power-settings-new"],
  star: ["mi", "star"],
  mic: ["mi", "mic"],
  books: ["mi", "library-books"],
  bell: ["mi", "notifications"],
  activity: ["mci", "pulse"],
};

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  style?: any;
}

export default function Icon({ name, size = 22, color = "#000", style }: IconProps) {
  const [family, glyph] = MAP[name] || (["mi", "help-outline"] as [Family, string]);
  if (family === "mci") {
    return <MaterialCommunityIcons name={glyph as any} size={size} color={color} style={style} />;
  }
  return <MaterialIcons name={glyph as any} size={size} color={color} style={style} />;
}
