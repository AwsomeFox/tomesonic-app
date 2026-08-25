#!/usr/bin/env python3
"""A fake AudiobookShelf server, just big enough to photograph the watch app.

Python 3 STANDARD LIBRARY ONLY (http.server, zlib, struct) — this runs on a CI
runner between `npm ci` and an emulator boot, and a pip install there is one
more thing that can go red.

It answers the exact endpoints `native/wear/src/main/java/com/tomesonic/app/
wear/data/AbsApi.kt` calls, in the exact shapes `Models.kt` parses. Field names
were derived from those parsers, NOT from the ABS docs: the watch reads
`media.metadata.authorName` with an `author` fallback, takes `media.tracks`
before `media.audioFiles`, needs `libraryItemId` on a play session, and treats
an explicit JSON null as absent. Anything a parser ignores is omitted rather
than faked.

Two numbers are load-bearing and must stay in step with the workflow:

  * every track is TRACK_SECONDS (600s) long and is served from the SAME
    `silence.mp3` the workflow generates with ffmpeg. Declaring a track longer
    than the file is what makes a seek land past EOF, which ExoPlayer reports
    as an unplayable book;
  * a play session opens at currentTime 1234, which therefore lands inside
    track 3 (1200-1800) at 34s — comfortably inside the file, in every item
    here, so the player screenshot shows a real position on a real chapter.

Ids are stable and referenced by `.github/workflows/wear-screenshots.yml`:
  libraries  lib_books ("Library", book) / lib_podcasts ("Podcasts", podcast)
  books      li_book_1 … li_book_6      (li_book_1 and li_book_3 in progress)
  podcast    li_pod_1                   (episodes ep_pod_1_1 … _3)

Usage (from the directory that holds silence.mp3):
    python3 mock_abs.py            # binds 0.0.0.0:3333, logs to stdout
"""

import json
import os
import re
import struct
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST = "0.0.0.0"
PORT = int(os.environ.get("MOCK_ABS_PORT", "3333"))

# The generated silence file, looked up in the working directory. Every track of
# every item streams from this one file.
AUDIO_FILE = os.environ.get("MOCK_ABS_AUDIO", "silence.mp3")

# Seconds per track — MUST match `ffmpeg -t` in the workflow (see module docs).
TRACK_SECONDS = 600.0

BOOK_LIBRARY_ID = "lib_books"
PODCAST_LIBRARY_ID = "lib_podcasts"

# Distinct, deliberately un-alike covers: the screenshots are the point, and six
# rows of the same green tell a reviewer nothing.
BOOKS = [
    {
        "id": "li_book_1",
        "title": "The Salt Road",
        "author": "Mariam Okonkwo",
        "narrator": "Ada Bell",
        "tracks": 6,
        "color": (32, 96, 84),
        "progress": 0.35,
    },
    {
        "id": "li_book_2",
        "title": "Winter Harbour",
        "author": "Jonas Vik",
        "narrator": "Erik Sand",
        "tracks": 5,
        "color": (38, 66, 112),
        "progress": None,
    },
    {
        "id": "li_book_3",
        "title": "A Field Guide to Falling",
        "author": "Priya Raman",
        "narrator": "Nila Rao",
        "tracks": 7,
        "color": (120, 62, 40),
        "progress": 0.70,
    },
    {
        "id": "li_book_4",
        "title": "The Lantern Keepers",
        "author": "Helena Frost",
        "narrator": "Kit Moore",
        "tracks": 4,
        "color": (86, 44, 104),
        "progress": None,
    },
    {
        "id": "li_book_5",
        "title": "Signal and Noise",
        "author": "Devon Marsh",
        "narrator": "Ray Idris",
        "tracks": 8,
        "color": (24, 84, 112),
        "progress": None,
    },
    {
        "id": "li_book_6",
        "title": "Every Quiet Thing",
        "author": "Tomás Reyes",
        "narrator": "Lena Cruz",
        "tracks": 5,
        "color": (110, 88, 28),
        "progress": None,
    },
]

PODCAST = {
    "id": "li_pod_1",
    "title": "The Long Commute",
    "author": "Field Notes Media",
    "color": (46, 78, 62),
    "episodes": [
        {"id": "ep_pod_1_1", "title": "What the map leaves out", "tracks": 3},
        {"id": "ep_pod_1_2", "title": "Two hours from anywhere", "tracks": 3},
        {"id": "ep_pod_1_3", "title": "The last ferry", "tracks": 3},
    ],
}

BOOKS_BY_ID = {b["id"]: b for b in BOOKS}
EPISODES_BY_ID = {e["id"]: e for e in PODCAST["episodes"]}

# Books the watch should show under "Continue Listening".
IN_PROGRESS_IDS = [b["id"] for b in BOOKS if b["progress"] is not None]

# One published-at per episode, newest first, so the list has a believable order.
_EPOCH_MS = 1_740_000_000_000


# --------------------------------------------------------------------------
# JSON shapes — one builder per parser in Models.kt
# --------------------------------------------------------------------------

def _duration(track_count):
    return round(track_count * TRACK_SECONDS, 3)


def _tracks(item_id, track_count, size_bytes):
    """`media.tracks` / a session's `audioTracks` — AudioTrack.fromJson."""
    out = []
    for i in range(track_count):
        index = i + 1
        out.append(
            {
                "index": index,
                "startOffset": round(i * TRACK_SECONDS, 3),
                "duration": TRACK_SECONDS,
                "title": "track_%d.mp3" % index,
                # Server-relative, exactly like ABS: AbsClient.resolve() joins it
                # onto the server origin and streams it with the Bearer header.
                "contentUrl": "/audio/%s.mp3" % item_id,
                "mimeType": "audio/mpeg",
                "codec": "mp3",
                "metadata": {
                    "filename": "track_%d.mp3" % index,
                    "ext": ".mp3",
                    "size": size_bytes,
                },
            }
        )
    return out


def _chapters(total_seconds, count=5):
    span = total_seconds / count
    return [
        {
            "id": i,
            "start": round(i * span, 3),
            "end": round((i + 1) * span, 3),
            "title": "Chapter %d" % (i + 1),
        }
        for i in range(count)
    ]


def _user_progress(book):
    fraction = book["progress"]
    if fraction is None:
        return None
    total = _duration(book["tracks"])
    return {
        "id": "mp_%s" % book["id"],
        "libraryItemId": book["id"],
        "duration": total,
        "currentTime": round(total * fraction, 3),
        "progress": fraction,
        "isFinished": False,
        "lastUpdate": _EPOCH_MS,
    }


def book_summary(book):
    """A minified row — ItemSummary.fromJson reads only these keys."""
    row = {
        "id": book["id"],
        "libraryId": BOOK_LIBRARY_ID,
        "mediaType": "book",
        "media": {
            "metadata": {
                "title": book["title"],
                "authorName": book["author"],
                "narratorName": book["narrator"],
            },
            "duration": _duration(book["tracks"]),
        },
    }
    progress = _user_progress(book)
    if progress is not None:
        row["userMediaProgress"] = progress
    return row


def podcast_summary():
    return {
        "id": PODCAST["id"],
        "libraryId": PODCAST_LIBRARY_ID,
        "mediaType": "podcast",
        "media": {
            # Podcasts carry `author`, books carry `authorName`; ItemSummary
            # reads authorName first and falls back to author.
            "metadata": {"title": PODCAST["title"], "author": PODCAST["author"]},
            "duration": _duration(sum(e["tracks"] for e in PODCAST["episodes"])),
        },
    }


def book_detail(book, size_bytes):
    """`GET /api/items/{id}?expanded=1` — ItemDetail.fromJson."""
    total = _duration(book["tracks"])
    detail = {
        "id": book["id"],
        "libraryId": BOOK_LIBRARY_ID,
        "mediaType": "book",
        "size": size_bytes * book["tracks"],
        "media": {
            "id": "media_%s" % book["id"],
            "metadata": {
                "title": book["title"],
                "authorName": book["author"],
                "narratorName": book["narrator"],
                "description": "A demo item served by native/wear/screenshots/mock_abs.py.",
            },
            "duration": total,
            "chapters": _chapters(total),
            "tracks": _tracks(book["id"], book["tracks"], size_bytes),
        },
    }
    progress = _user_progress(book)
    if progress is not None:
        detail["userMediaProgress"] = progress
    return detail


def podcast_detail(size_bytes):
    episodes = []
    for i, episode in enumerate(PODCAST["episodes"]):
        episodes.append(
            {
                "id": episode["id"],
                "title": episode["title"],
                # Newest first: one week apart, counting back from _EPOCH_MS.
                "publishedAt": _EPOCH_MS - i * 7 * 24 * 60 * 60 * 1000,
                "duration": _duration(episode["tracks"]),
                "audioFile": {
                    "duration": _duration(episode["tracks"]),
                    "metadata": {"filename": "%s.mp3" % episode["id"], "ext": ".mp3"},
                },
            }
        )
    total = _duration(sum(e["tracks"] for e in PODCAST["episodes"]))
    return {
        "id": PODCAST["id"],
        "libraryId": PODCAST_LIBRARY_ID,
        "mediaType": "podcast",
        "size": size_bytes * sum(e["tracks"] for e in PODCAST["episodes"]),
        "media": {
            "id": "media_%s" % PODCAST["id"],
            "metadata": {"title": PODCAST["title"], "author": PODCAST["author"]},
            "duration": total,
            "episodes": episodes,
        },
    }


def play_session(item_id, episode_id, size_bytes):
    """`POST /api/items/{id}/play[/{episodeId}]` — PlaySession.fromJson.

    `libraryItemId` is REQUIRED: without it (or a nested `libraryItem.id`) the
    parser returns null and the watch reports "no connection".
    """
    if episode_id is not None:
        episode = EPISODES_BY_ID[episode_id]
        track_count = episode["tracks"]
        title = episode["title"]
        author = PODCAST["author"]
        media_type = "podcast"
    else:
        book = BOOKS_BY_ID[item_id]
        track_count = book["tracks"]
        title = book["title"]
        author = book["author"]
        media_type = "book"
    total = _duration(track_count)
    session = {
        "id": "play_%s_%d" % (episode_id or item_id, int(time.time())),
        "userId": "usr_demo",
        "libraryItemId": item_id,
        "mediaType": media_type,
        "displayTitle": title,
        "displayAuthor": author,
        "duration": total,
        # Lands in track 3 at 34s — inside the generated file. See module docs.
        "currentTime": 1234.0,
        "playMethod": 0,
        "mediaPlayer": "exo-player",
        "audioTracks": _tracks(episode_id or item_id, track_count, size_bytes),
        "chapters": _chapters(total),
        "startedAt": _EPOCH_MS,
        "updatedAt": _EPOCH_MS,
    }
    if episode_id is not None:
        session["episodeId"] = episode_id
    return session


# --------------------------------------------------------------------------
# Covers — a PNG encoder in ~20 lines, because PIL is not in the stdlib
# --------------------------------------------------------------------------

COVER_SIZE = 480
_COVER_CACHE = {}


def _chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def _cover_color(item_id):
    if item_id in BOOKS_BY_ID:
        return BOOKS_BY_ID[item_id]["color"]
    if item_id == PODCAST["id"]:
        return PODCAST["color"]
    # Anything unexpected still gets its own stable colour rather than a 404,
    # so a mistyped id shows up as a wrong cover instead of an empty box.
    digest = zlib.crc32(item_id.encode("utf-8"))
    return (40 + (digest & 0x7F), 40 + ((digest >> 8) & 0x7F), 40 + ((digest >> 16) & 0x7F))


def cover_png(item_id, size=COVER_SIZE):
    """A per-item vertical gradient as a 24-bit PNG. Cached — Coil asks often."""
    cached = _COVER_CACHE.get(item_id)
    if cached is not None:
        return cached
    r0, g0, b0 = _cover_color(item_id)
    raw = bytearray()
    for y in range(size):
        shade = 1.0 - 0.55 * (y / float(size - 1))
        row = bytes((int(r0 * shade), int(g0 * shade), int(b0 * shade))) * size
        raw.append(0)  # PNG filter type 0 (None) for this scanline
        raw.extend(row)
    png = (
        b"\x89PNG\r\n\x1a\n"
        # width, height, bit depth 8, colour type 2 (truecolour), no interlace
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + _chunk(b"IEND", b"")
    )
    _COVER_CACHE[item_id] = png
    return png


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

RE_LIBRARY_ITEMS = re.compile(r"^/api/libraries/([^/]+)/items$")
RE_ITEM = re.compile(r"^/api/items/([^/]+)$")
RE_COVER = re.compile(r"^/api/items/([^/]+)/cover$")
RE_PLAY = re.compile(r"^/api/items/([^/]+)/play(?:/([^/]+))?$")
RE_SESSION = re.compile(r"^/api/session/([^/]+)/(sync|close)$")
RE_AUDIO = re.compile(r"^/audio/([^/]+)\.mp3$")
RE_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


def audio_size():
    try:
        return os.path.getsize(AUDIO_FILE)
    except OSError:
        return 0


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 keep-alive: ExoPlayer reconnects per track and per seek, and a
    # fresh TCP handshake each time is a slower, flakier capture. Every reply
    # below therefore sets Content-Length.
    protocol_version = "HTTP/1.1"
    server_version = "MockABS/1.0"

    # -- helpers ----------------------------------------------------------

    def log_message(self, fmt, *args):
        # stdout, not stderr, and flushed: the workflow tees this into an
        # artifact and it is the first place to look when a screen comes back
        # empty (a 404 here is a field name the app wanted and did not get).
        sys.stdout.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()

    def _send(self, status, body, content_type, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    def _json(self, payload, status=200):
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

    def _not_found(self):
        # Loud on purpose: an unhandled path is a shape the app wanted.
        self.log_message("UNHANDLED %s %s", self.command, self.path)
        self._json({"error": "not found", "path": self.path}, status=404)

    def _read_body(self):
        """Drain the request body — required before replying on a keep-alive."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    # -- routes -----------------------------------------------------------

    def do_GET(self):
        # Authorization is deliberately ignored: the watch always sends a Bearer
        # token, and rejecting a wrong one would only turn a screenshot run into
        # a debugging session about the fake token.
        path = urlparse(self.path).path
        size = audio_size()

        if path == "/api/libraries":
            return self._json(
                {
                    "libraries": [
                        {"id": BOOK_LIBRARY_ID, "name": "Library", "mediaType": "book"},
                        {"id": PODCAST_LIBRARY_ID, "name": "Podcasts", "mediaType": "podcast"},
                    ]
                }
            )

        match = RE_LIBRARY_ITEMS.match(path)
        if match:
            library_id = match.group(1)
            if library_id == BOOK_LIBRARY_ID:
                results = [book_summary(b) for b in BOOKS]
            elif library_id == PODCAST_LIBRARY_ID:
                results = [podcast_summary()]
            else:
                results = []
            # Pagination.isEnd treats a short page as the end, so one page of
            # everything is exactly right: the watch never asks for page 1.
            return self._json(
                {"results": results, "total": len(results), "page": 0, "limit": 50}
            )

        if path == "/api/me/items-in-progress":
            return self._json(
                {"libraryItems": [book_summary(BOOKS_BY_ID[i]) for i in IN_PROGRESS_IDS]}
            )

        match = RE_COVER.match(path)
        if match:
            return self._send(200, cover_png(match.group(1)), "image/png")

        match = RE_ITEM.match(path)
        if match:
            item_id = match.group(1)
            if item_id in BOOKS_BY_ID:
                return self._json(book_detail(BOOKS_BY_ID[item_id], size))
            if item_id == PODCAST["id"]:
                return self._json(podcast_detail(size))
            return self._not_found()

        match = RE_AUDIO.match(path)
        if match:
            return self._serve_audio()

        return self._not_found()

    def do_POST(self):
        body = self._read_body()
        path = urlparse(self.path).path
        size = audio_size()

        match = RE_PLAY.match(path)
        if match:
            item_id, episode_id = match.group(1), match.group(2)
            known = item_id in BOOKS_BY_ID or item_id == PODCAST["id"]
            if not known or (episode_id is not None and episode_id not in EPISODES_BY_ID):
                return self._not_found()
            self.log_message("play %s episode=%s body=%d bytes", item_id, episode_id, len(body))
            return self._json(play_session(item_id, episode_id, size))

        if RE_SESSION.match(path) or path == "/api/session/local":
            # The watch only checks for a non-null body (AbsApi.syncSession).
            self.log_message("session %s <- %s", path, body.decode("utf-8", "replace")[:200])
            return self._json({})

        return self._not_found()

    def do_PATCH(self):
        body = self._read_body()
        path = urlparse(self.path).path
        if path == "/api/me/progress/batch/update":
            # The offline position queue flushes here on app start.
            self.log_message("batch progress <- %s", body.decode("utf-8", "replace")[:200])
            return self._json({})
        return self._not_found()

    # -- audio ------------------------------------------------------------

    def _serve_audio(self):
        """The one generated silence file, with Range support.

        A session opens mid-book, so media3's first request for a track is a
        ranged one. Answering 206 keeps that a seek instead of a download; a
        client that ignores ranges still gets a plain 200 with the whole file.
        """
        if not os.path.exists(AUDIO_FILE):
            self.log_message("MISSING %s (run the ffmpeg step first)", AUDIO_FILE)
            return self._json({"error": "no audio fixture"}, status=404)

        size = os.path.getsize(AUDIO_FILE)
        start, end, status = 0, size - 1, 200
        raw_range = self.headers.get("Range")
        match = RE_RANGE.match(raw_range.strip()) if raw_range else None
        if match:
            first, last = match.group(1), match.group(2)
            if first:
                start = int(first)
                end = int(last) if last else size - 1
            elif last:
                start = max(0, size - int(last))
            if start >= size:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            end = min(end, size - 1)
            status = 206

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()

        remaining = length
        try:
            with open(AUDIO_FILE, "rb") as handle:
                handle.seek(start)
                while remaining > 0:
                    chunk = handle.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # Expected: the player closes a track's connection when it seeks or
            # moves on. Nothing is wrong, and nothing should be logged as if it
            # were — but this connection is finished.
            self.close_connection = True


def main():
    size = audio_size()
    print("mock ABS on http://%s:%d  (audio fixture %s, %d bytes)" % (HOST, PORT, AUDIO_FILE, size))
    if size == 0:
        print("WARNING: %s missing or empty — /audio/*.mp3 will 404 until it exists" % AUDIO_FILE)
    print("libraries: %s (book), %s (podcast)" % (BOOK_LIBRARY_ID, PODCAST_LIBRARY_ID))
    print("books: %s" % ", ".join(b["id"] for b in BOOKS))
    print("in progress: %s" % ", ".join(IN_PROGRESS_IDS))
    sys.stdout.flush()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
