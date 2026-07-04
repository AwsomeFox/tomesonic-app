/**
 * Shared TypeScript types for the Audiobookshelf domain. Types only — no
 * runtime effect. Intended for incremental adoption; existing call sites are
 * not refactored to use these yet.
 */

export interface AudioTrack {
  index: number;
  contentUrl: string;
  duration: number;
  startOffset?: number;
  metadata?: any;
}

export interface Chapter {
  id?: number;
  start: number;
  end: number;
  title: string;
}

export interface Bookmark {
  libraryItemId: string;
  title: string;
  time: number;
}

export interface MediaProgress {
  libraryItemId: string;
  episodeId?: string;
  currentTime: number;
  duration: number;
  progress: number;
  isFinished: boolean;
  updatedAt?: number;
}

export interface PlaybackSession {
  id: string;
  libraryItemId: string;
  displayTitle: string;
  displayAuthor: string;
  duration: number;
  currentTime: number;
  chapters?: Chapter[];
  audioTracks?: AudioTrack[];
  playbackRate?: number;
  coverUrl?: string;
  episodeId?: string;
}

export interface Author {
  id: string;
  name: string;
  imagePath?: string;
}

export interface Series {
  id: string;
  name: string;
  books?: any[];
}

export interface Library {
  id: string;
  name: string;
  mediaType: string;
}

export interface LibraryItem {
  id: string;
  mediaType: string;
  media?: any;
  coverPath?: string;
}
