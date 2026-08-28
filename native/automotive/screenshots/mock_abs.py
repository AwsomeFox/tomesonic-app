#!/usr/bin/env python3
"""A fake AudiobookShelf server, just big enough to photograph the car app.

Python 3 STANDARD LIBRARY ONLY (http.server, base64, zlib, struct) — this runs
on a CI runner between `npm ci` and an AAOS emulator boot, and a pip install
there is one more thing that can go red. Ported from
`native/wear/screenshots/mock_abs.py`; the differences are all downstream of the
one thing the car does that the watch does not — it serves a BROWSE TREE.

What that changes, endpoint by endpoint (see
`native/automotive/src/main/java/com/tomesonic/app/automotive/media/BrowseTree.kt`
and the "Browse-tree surface" half of `data/AbsApi.kt`):

  * `/api/libraries` rows carry `icon`, which BrowseStyles.libraryIconRes maps
    to one of the bundled `aa_lib_*` drawables — a library with no icon renders
    the fallback and the screenshot silently loses that mapping;
  * library items are requested MINIFIED, so a row's `media` carries
    `numTracks`/`numAudioFiles` rather than the `tracks` array the watch reads.
    BrowseTree.hasAudio filters out anything with neither, EVERYWHERE — a row
    without them simply never appears in the tree;
  * `filter=<type>.<base64(value)>` is how the tree asks for finished books
    (Listen Again), an author's books and a series' books. The value is standard
    base64 of the raw id, url-encoded (AbsApi.absB64). Filters are DECODED here
    rather than ignored: a filter the server doesn't understand returns the
    whole library, which looks like a working screen full of the wrong books;
  * `/api/me` (the `mediaProgress` array) backs nearly every row's "42% • Title"
    and "3h 12m left". Book rows carry an EXPLICIT `episodeId: null` — that is
    the org.json trap BrowseTree documents (optString on a JSON null returns the
    string "null"), and it is reproduced here on purpose so the rig exercises it;
  * `/api/libraries/{id}/personalized` answers an EMPTY BARE ARRAY. The tree
    only wants the `continue-series` shelf from it, that shelf is the tree's one
    N+1 fan-out, and Continue Series is not a screen this rig photographs.
    Returning `[]` is a legitimate ABS answer (nothing between books), so the
    folder renders empty instead of wrong.

There is deliberately NO audio fixture. The wear rig photographs a player and so
generates `silence.mp3` with ffmpeg; the car rig photographs BROWSE, and the
Media Center never asks for a byte of audio while browsing. `/audio/*.mp3`
therefore 404s with a loud log line — if a future capture plays a book, generate
the fixture the way `.github/workflows/wear-screenshots.yml` does and set
MOCK_ABS_AUDIO.

Ids are stable and referenced by `.github/workflows/automotive-screenshots.yml`
and `capture.sh`:
  libraries  lib_books ("Audiobooks", book) / lib_podcasts ("Podcasts", podcast)
  books      li_book_1 … li_book_6   (li_book_1, li_book_3 in progress;
                                      li_book_6 finished -> Listen Again)
  authors    aut_1 … aut_6           series ser_salt (2 books)
  collection col_road_trip           podcast li_pod_1 (ep_pod_1_1 … _3)

Usage:
    python3 mock_abs.py            # binds 0.0.0.0:3333, logs to stdout
"""

import base64
import json
import os
import re
import struct
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HOST = "0.0.0.0"
PORT = int(os.environ.get("MOCK_ABS_PORT", "3333"))

# Optional, and absent by default — see the module docstring.
AUDIO_FILE = os.environ.get("MOCK_ABS_AUDIO", "silence.mp3")

# Seconds per track. Nothing streams here, so this only has to make the
# durations and "time left" labels believable.
TRACK_SECONDS = 600.0

BOOK_LIBRARY_ID = "lib_books"
PODCAST_LIBRARY_ID = "lib_podcasts"

# The token the rig seeds (capture.sh TOKEN). Not enforced — see do_GET.
DEMO_TOKEN = "demo"

_EPOCH_MS = 1_740_000_000_000
_DAY_MS = 24 * 60 * 60 * 1000

# Distinct, deliberately un-alike covers: the screenshots ARE the deliverable,
# and six tiles of the same green tell a Play reviewer nothing.
BOOKS = [
    {
        "id": "li_book_1",
        "title": "The Salt Road",
        "author": "Mariam Okonkwo",
        "author_id": "aut_1",
        "narrator": "Ada Bell",
        "series": {"id": "ser_salt", "name": "The Salt Road", "sequence": "1"},
        "tracks": 6,
        "color": (32, 96, 84),
        "progress": 0.35,
    },
    {
        "id": "li_book_2",
        "title": "Winter Harbour",
        "author": "Jonas Vik",
        "author_id": "aut_2",
        "narrator": "Erik Sand",
        "tracks": 5,
        "color": (38, 66, 112),
        "progress": None,
    },
    {
        "id": "li_book_3",
        "title": "A Field Guide to Falling",
        "author": "Priya Raman",
        "author_id": "aut_3",
        "narrator": "Nila Rao",
        "tracks": 7,
        "color": (120, 62, 40),
        "progress": 0.70,
    },
    {
        "id": "li_book_4",
        "title": "The Lantern Keepers",
        "author": "Helena Frost",
        "author_id": "aut_4",
        "narrator": "Kit Moore",
        "tracks": 4,
        "color": (86, 44, 104),
        "progress": None,
    },
    {
        "id": "li_book_5",
        "title": "Salt and Ashes",
        "author": "Mariam Okonkwo",
        "author_id": "aut_1",
        "narrator": "Ada Bell",
        "series": {"id": "ser_salt", "name": "The Salt Road", "sequence": "2"},
        "tracks": 8,
        "color": (24, 84, 112),
        "progress": None,
    },
    {
        "id": "li_book_6",
        "title": "Every Quiet Thing",
        "author": "Tomás Reyes",
        "author_id": "aut_6",
        "narrator": "Lena Cruz",
        "tracks": 5,
        "color": (110, 88, 28),
        # Finished: this is the row Listen Again exists for, and the one that
        # proves the "✓ Title" display-title branch renders on a head unit.
        "progress": 1.0,
        "finished": True,
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

COLLECTION = {
    "id": "col_road_trip",
    "name": "Road Trip",
    "books": ["li_book_1", "li_book_4", "li_book_6"],
}

BOOKS_BY_ID = {b["id"]: b for b in BOOKS}
EPISODES_BY_ID = {e["id"]: e for e in PODCAST["episodes"]}

# Continue Listening: started but not finished. A finished book has progress
# but belongs in Listen Again, not here.
IN_PROGRESS_IDS = [
    b["id"] for b in BOOKS if b["progress"] is not None and not b.get("finished")
]


# --------------------------------------------------------------------------
# JSON shapes — one builder per reader in BrowseTree.kt / Models.kt
# --------------------------------------------------------------------------

def _duration(track_count):
    return round(track_count * TRACK_SECONDS, 3)


def _added_at(book):
    """Newest first in Recently Added: li_book_1 is the most recent."""
    return _EPOCH_MS - BOOKS.index(book) * 3 * _DAY_MS


def _metadata(book):
    """`media.metadata` — the keys BrowseTree actually reads.

    `seriesName` carries the "Name #3" suffix (that is the shape a MINIFIED row
    has), and `series` carries the object a series-FILTERED row has. Both are
    real ABS shapes, and BrowseTree.sequenceLabel reads whichever is present.
    """
    md = {
        "title": book["title"],
        "authorName": book["author"],
        "narratorName": book["narrator"],
    }
    series = book.get("series")
    if series is not None:
        md["seriesName"] = "%s #%s" % (series["name"], series["sequence"])
        md["series"] = {
            "id": series["id"],
            "name": series["name"],
            "sequence": series["sequence"],
        }
    return md


def minified_row(book):
    """A `results` / `libraryItems` row, as ABS serves it with `minified=1`.

    `numTracks`/`numAudioFiles` are load-bearing: BrowseTree.hasAudio filters
    out every row that has neither them nor a `tracks` array nor a duration, so
    a row without them is invisible in every category of the tree.
    """
    return {
        "id": book["id"],
        "libraryId": BOOK_LIBRARY_ID,
        "mediaType": "book",
        "addedAt": _added_at(book),
        "media": {
            "metadata": _metadata(book),
            "duration": _duration(book["tracks"]),
            "numTracks": book["tracks"],
            "numAudioFiles": book["tracks"],
        },
    }


def podcast_row():
    return {
        "id": PODCAST["id"],
        "libraryId": PODCAST_LIBRARY_ID,
        "mediaType": "podcast",
        "media": {
            # Podcasts carry `author`; BrowseTree.podcastBrowsable reads exactly
            # that key for the subtitle under a show's tile.
            "metadata": {"title": PODCAST["title"], "author": PODCAST["author"]},
            "duration": _duration(sum(e["tracks"] for e in PODCAST["episodes"])),
            "numEpisodes": len(PODCAST["episodes"]),
            "numAudioFiles": len(PODCAST["episodes"]),
        },
    }


def progress_row(book):
    """One `/api/me` mediaProgress entry, or None for an untouched book."""
    fraction = book["progress"]
    if fraction is None:
        return None
    total = _duration(book["tracks"])
    return {
        "id": "mp_%s" % book["id"],
        "libraryItemId": book["id"],
        # EXPLICIT null, not omitted: BrowseTree splits its items map from its
        # episodes map on `isNull("episodeId")`, and the donor's bug was reading
        # this back as the STRING "null" — which emptied the items map and took
        # every percentage, checkmark and "time left" in the tree with it.
        "episodeId": None,
        "duration": total,
        "currentTime": round(total * fraction, 3),
        "progress": fraction,
        "isFinished": bool(book.get("finished")),
        "lastUpdate": _EPOCH_MS,
    }


def episode_progress_row():
    """One episode-scoped row, so the `{itemId}-{episodeId}` map is non-empty."""
    episode = PODCAST["episodes"][0]
    total = _duration(episode["tracks"])
    return {
        "id": "mp_%s" % episode["id"],
        "libraryItemId": PODCAST["id"],
        "episodeId": episode["id"],
        "duration": total,
        "currentTime": round(total * 0.4, 3),
        "progress": 0.4,
        "isFinished": False,
        "lastUpdate": _EPOCH_MS,
    }


def media_progress():
    rows = [p for p in (progress_row(b) for b in BOOKS) if p is not None]
    rows.append(episode_progress_row())
    return rows


def authors():
    """`/api/libraries/{id}/authors` -> `authors`: name + numBooks + id."""
    seen = {}
    for book in BOOKS:
        entry = seen.setdefault(
            book["author_id"],
            {"id": book["author_id"], "name": book["author"], "numBooks": 0},
        )
        entry["numBooks"] += 1
    return sorted(seen.values(), key=lambda a: a["name"].lower())


def series_rows():
    """`/api/libraries/{id}/series` -> `results`.

    Minified, but the rows still carry `books` — which is where seriesList()
    gets the author it appends to each row's title.
    """
    grouped = {}
    for book in BOOKS:
        series = book.get("series")
        if series is None:
            continue
        entry = grouped.setdefault(
            series["id"], {"id": series["id"], "name": series["name"], "books": []}
        )
        entry["books"].append(minified_row(book))
    for entry in grouped.values():
        entry["numBooks"] = len(entry["books"])
    return sorted(grouped.values(), key=lambda s: s["name"].lower())


def collection_rows():
    return [{"id": COLLECTION["id"], "name": COLLECTION["name"], "libraryId": BOOK_LIBRARY_ID}]


def _tracks(item_id, track_count):
    """`media.tracks` / a session's `audioTracks` — AudioTrack.fromJson."""
    return [
        {
            "index": i + 1,
            "startOffset": round(i * TRACK_SECONDS, 3),
            "duration": TRACK_SECONDS,
            "title": "track_%d.mp3" % (i + 1),
            # Server-relative, exactly like ABS: AbsClient.resolve() joins it
            # onto the server origin and streams it with the Bearer header.
            "contentUrl": "/audio/%s.mp3" % item_id,
            "mimeType": "audio/mpeg",
            "codec": "mp3",
            "metadata": {"filename": "track_%d.mp3" % (i + 1), "ext": ".mp3"},
        }
        for i in range(track_count)
    ]


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


def book_detail(book):
    """`GET /api/items/{id}?expanded=1` — ItemDetail.fromJson."""
    total = _duration(book["tracks"])
    detail = {
        "id": book["id"],
        "libraryId": BOOK_LIBRARY_ID,
        "mediaType": "book",
        "media": {
            "id": "media_%s" % book["id"],
            "metadata": dict(
                _metadata(book),
                description="A demo item served by native/automotive/screenshots/mock_abs.py.",
            ),
            "duration": total,
            "chapters": _chapters(total),
            "tracks": _tracks(book["id"], book["tracks"]),
        },
    }
    progress = progress_row(book)
    if progress is not None:
        detail["userMediaProgress"] = progress
    return detail


def podcast_detail():
    episodes = []
    for i, episode in enumerate(PODCAST["episodes"]):
        episodes.append(
            {
                "id": episode["id"],
                "title": episode["title"],
                # Newest first: one week apart, counting back from _EPOCH_MS.
                # BrowseTree sorts on publishedAt descending, so this decides
                # the order the episode list is photographed in.
                "publishedAt": _EPOCH_MS - i * 7 * _DAY_MS,
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
        "media": {
            "id": "media_%s" % PODCAST["id"],
            "metadata": {"title": PODCAST["title"], "author": PODCAST["author"]},
            "duration": total,
            "episodes": episodes,
        },
    }


def play_session(item_id, episode_id):
    """`POST /api/items/{id}/play[/{episodeId}]` — PlaySession.fromJson.

    `libraryItemId` is REQUIRED: without it (or a nested `libraryItem.id`) the
    parser returns null and the car reports the book unplayable. Nothing in the
    capture sequence opens a session, but a hand-driven emulator does the moment
    someone taps a tile, and a 404 there is a confusing way to learn that.
    """
    if episode_id is not None:
        episode = EPISODES_BY_ID[episode_id]
        track_count, title, author, media_type = (
            episode["tracks"], episode["title"], PODCAST["author"], "podcast"
        )
    else:
        book = BOOKS_BY_ID[item_id]
        track_count, title, author, media_type = (
            book["tracks"], book["title"], book["author"], "book"
        )
    total = _duration(track_count)
    session = {
        "id": "play_%s_%d" % (episode_id or item_id, int(time.time())),
        "userId": "usr_demo",
        "libraryItemId": item_id,
        "mediaType": media_type,
        "displayTitle": title,
        "displayAuthor": author,
        "duration": total,
        "currentTime": 1234.0,
        "playMethod": 0,
        "mediaPlayer": "exo-player",
        "audioTracks": _tracks(episode_id or item_id, track_count),
        "chapters": _chapters(total),
        "startedAt": _EPOCH_MS,
        "updatedAt": _EPOCH_MS,
    }
    if episode_id is not None:
        session["episodeId"] = episode_id
    return session


def login_body():
    """`POST /login` — AbsApi.parseLogin/loginSuccess read `user.accessToken`."""
    return {
        "user": {
            "id": "usr_demo",
            "username": "demo",
            "accessToken": DEMO_TOKEN,
            "refreshToken": "demo-refresh",
        }
    }


# --------------------------------------------------------------------------
# Covers — a PNG encoder in ~20 lines, because PIL is not in the stdlib
# --------------------------------------------------------------------------
#
# These matter more on the car than on the watch: a cover URL becomes a
# MediaItem's artworkUri and is fetched by the MEDIA CENTER's process (which is
# why AbsApi puts the token in the query string, ARCHITECTURE.md §4.4). A cover
# that 404s is a browse grid full of grey placeholders — a wasted screenshot run.

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
    # Anything unexpected still gets its own stable colour rather than a 404, so
    # a mistyped id shows up as a wrong cover instead of an empty tile.
    digest = zlib.crc32(item_id.encode("utf-8"))
    return (40 + (digest & 0x7F), 40 + ((digest >> 8) & 0x7F), 40 + ((digest >> 16) & 0x7F))


def cover_png(item_id, size=COVER_SIZE):
    """A per-item vertical gradient as a 24-bit PNG. Cached — the car asks often."""
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
# Filters and sorts — AbsApi.itemRows' query string, decoded
# --------------------------------------------------------------------------

def decode_filter(raw):
    """`progress.ZmluaXNoZWQ%3D` -> ("progress", "finished").

    AbsApi.absB64 is standard base64 (NO_WRAP) of the raw value, then
    url-encoded; http.server has already url-decoded the query for us, so only
    the base64 layer is left. Padding is re-added because some clients strip it.
    """
    if not raw or "." not in raw:
        return None, None
    filter_type, _, encoded = raw.partition(".")
    padded = unquote(encoded)
    padded += "=" * (-len(padded) % 4)
    try:
        value = base64.b64decode(padded).decode("utf-8")
    except Exception:
        return filter_type, None
    return filter_type, value


def filtered_books(filter_type, value):
    if filter_type is None:
        return list(BOOKS)
    if filter_type == "progress":
        if value == "finished":
            return [b for b in BOOKS if b.get("finished")]
        if value in ("in-progress", "in_progress"):
            return [b for b in BOOKS if b["id"] in IN_PROGRESS_IDS]
        return []
    if filter_type == "authors":
        return [b for b in BOOKS if b["author_id"] == value]
    if filter_type == "series":
        return [b for b in BOOKS if (b.get("series") or {}).get("id") == value]
    # An unknown filter is a bug in the app or in this file — say so rather than
    # answering with the whole library, which reads as a working screen.
    return []


def sorted_books(books, sort, desc):
    if sort == "addedAt":
        out = sorted(books, key=_added_at)
    elif sort == "media.metadata.series.sequence":
        out = sorted(books, key=lambda b: float((b.get("series") or {}).get("sequence") or 0))
    else:  # media.metadata.title, and anything unrecognised
        out = sorted(books, key=lambda b: b["title"].lower())
    return list(reversed(out)) if desc else out


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

RE_LIBRARY_ITEMS = re.compile(r"^/api/libraries/([^/]+)/items$")
RE_LIBRARY_AUTHORS = re.compile(r"^/api/libraries/([^/]+)/authors$")
RE_LIBRARY_SERIES = re.compile(r"^/api/libraries/([^/]+)/series$")
RE_LIBRARY_COLLECTIONS = re.compile(r"^/api/libraries/([^/]+)/collections$")
RE_LIBRARY_PERSONALIZED = re.compile(r"^/api/libraries/([^/]+)/personalized$")
RE_LIBRARY_SEARCH = re.compile(r"^/api/libraries/([^/]+)/search$")
RE_COLLECTION = re.compile(r"^/api/collections/([^/]+)$")
RE_ITEM = re.compile(r"^/api/items/([^/]+)$")
RE_COVER = re.compile(r"^/api/items/([^/]+)/cover$")
RE_PLAY = re.compile(r"^/api/items/([^/]+)/play(?:/([^/]+))?$")
RE_SESSION = re.compile(r"^/api/session/([^/]+)/(sync|close)$")
RE_AUDIO = re.compile(r"^/audio/([^/]+)\.mp3$")


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 keep-alive: the browse tree fans out several requests per folder
    # (items + /api/me) and the Media Center fetches every cover, so a fresh TCP
    # handshake each time is a slower, flakier capture. Every reply below
    # therefore sets Content-Length.
    protocol_version = "HTTP/1.1"
    server_version = "MockABS/1.0"

    # -- helpers ----------------------------------------------------------

    def log_message(self, fmt, *args):
        # stdout, not stderr, and flushed: the workflow tees this into an
        # artifact and it is the first place to look when a folder comes back
        # empty (a 404 here is a shape the app wanted and did not get).
        sys.stdout.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()

    def _send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
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

    def _query(self):
        return parse_qs(urlparse(self.path).query)

    def _one(self, query, key, default=None):
        values = query.get(key)
        return values[0] if values else default

    # -- routes -----------------------------------------------------------

    def do_GET(self):
        # Authorization is deliberately NOT enforced: the car always sends a
        # Bearer header (and a `token=` query param on covers), and rejecting a
        # wrong one would only turn a screenshot run into a debugging session
        # about a fake token.
        path = urlparse(self.path).path
        query = self._query()

        if path == "/api/libraries":
            return self._json(
                {
                    "libraries": [
                        {
                            "id": BOOK_LIBRARY_ID,
                            "name": "Audiobooks",
                            "mediaType": "book",
                            # BrowseStyles.libraryIconRes maps this to
                            # @drawable/aa_library. An unmapped name silently
                            # falls back by media type.
                            "icon": "audiobookshelf",
                        },
                        {
                            "id": PODCAST_LIBRARY_ID,
                            "name": "Podcasts",
                            "mediaType": "podcast",
                            "icon": "podcast",
                        },
                    ]
                }
            )

        match = RE_LIBRARY_ITEMS.match(path)
        if match:
            library_id = match.group(1)
            if library_id == PODCAST_LIBRARY_ID:
                rows = [podcast_row()]
            elif library_id == BOOK_LIBRARY_ID:
                filter_type, value = decode_filter(self._one(query, "filter"))
                books = filtered_books(filter_type, value)
                books = sorted_books(
                    books, self._one(query, "sort"), self._one(query, "desc") is not None
                )
                try:
                    limit = int(self._one(query, "limit", "200") or 200)
                except ValueError:
                    limit = 200
                rows = [minified_row(b) for b in books[:limit]]
                if filter_type is not None:
                    self.log_message("filter %s=%s -> %d rows", filter_type, value, len(rows))
            else:
                rows = []
            # BrowsePagination treats a short page as the end, so one page of
            # everything is exactly right.
            return self._json({"results": rows, "total": len(rows), "page": 0, "limit": len(rows)})

        match = RE_LIBRARY_AUTHORS.match(path)
        if match:
            rows = authors() if match.group(1) == BOOK_LIBRARY_ID else []
            return self._json({"authors": rows})

        match = RE_LIBRARY_SERIES.match(path)
        if match:
            rows = series_rows() if match.group(1) == BOOK_LIBRARY_ID else []
            return self._json({"results": rows, "total": len(rows)})

        match = RE_LIBRARY_COLLECTIONS.match(path)
        if match:
            rows = collection_rows() if match.group(1) == BOOK_LIBRARY_ID else []
            return self._json({"results": rows, "total": len(rows)})

        match = RE_LIBRARY_PERSONALIZED.match(path)
        if match:
            # A BARE array, and empty on purpose — see the module docstring.
            return self._json([])

        match = RE_LIBRARY_SEARCH.match(path)
        if match:
            needle = (self._one(query, "q", "") or "").lower()
            hits = [b for b in BOOKS if needle and needle in b["title"].lower()]
            # `{"book": [{"libraryItem": {...}}]}` — AbsApi.searchAll reads the
            # `book` array and pulls `libraryItem` out of each entry.
            return self._json(
                {
                    "book": [{"libraryItem": minified_row(b)} for b in hits],
                    "podcast": [],
                }
            )

        match = RE_COLLECTION.match(path)
        if match:
            if match.group(1) != COLLECTION["id"]:
                return self._not_found()
            # NOT a `results` envelope: a collection answers `books`.
            return self._json(
                {
                    "id": COLLECTION["id"],
                    "name": COLLECTION["name"],
                    "books": [minified_row(BOOKS_BY_ID[i]) for i in COLLECTION["books"]],
                }
            )

        if path == "/api/me":
            return self._json(
                {"id": "usr_demo", "username": "demo", "mediaProgress": media_progress()}
            )

        if path == "/api/me/items-in-progress":
            return self._json(
                {"libraryItems": [minified_row(BOOKS_BY_ID[i]) for i in IN_PROGRESS_IDS]}
            )

        match = RE_COVER.match(path)
        if match:
            return self._send(200, cover_png(match.group(1)), "image/png")

        match = RE_ITEM.match(path)
        if match:
            item_id = match.group(1)
            if item_id in BOOKS_BY_ID:
                return self._json(book_detail(BOOKS_BY_ID[item_id]))
            if item_id == PODCAST["id"]:
                return self._json(podcast_detail())
            return self._not_found()

        if RE_AUDIO.match(path):
            return self._serve_audio()

        return self._not_found()

    def do_POST(self):
        body = self._read_body()
        path = urlparse(self.path).path

        if path == "/login":
            self.log_message("login <- %s", body.decode("utf-8", "replace")[:120])
            return self._json(login_body())

        if path == "/auth/refresh":
            # Rotation-optional, exactly like ABS: the same envelope /login uses.
            return self._json(login_body())

        match = RE_PLAY.match(path)
        if match:
            item_id, episode_id = match.group(1), match.group(2)
            known = item_id in BOOKS_BY_ID or item_id == PODCAST["id"]
            if not known or (episode_id is not None and episode_id not in EPISODES_BY_ID):
                return self._not_found()
            self.log_message("play %s episode=%s", item_id, episode_id)
            return self._json(play_session(item_id, episode_id))

        if RE_SESSION.match(path) or path == "/api/session/local":
            # The car only checks for a non-null body (AbsApi.syncSession).
            self.log_message("session %s <- %s", path, body.decode("utf-8", "replace")[:200])
            return self._json({})

        return self._not_found()

    def do_PATCH(self):
        body = self._read_body()
        if urlparse(self.path).path == "/api/me/progress/batch/update":
            # OfflineProgressQueue flushes here on app start.
            self.log_message("batch progress <- %s", body.decode("utf-8", "replace")[:200])
            return self._json({})
        return self._not_found()

    # -- audio ------------------------------------------------------------

    def _serve_audio(self):
        """The optional silence fixture. Absent by default — see the docstring."""
        if not os.path.exists(AUDIO_FILE):
            self.log_message(
                "NO AUDIO FIXTURE (%s): the car rig photographs browse and never "
                "streams. Generate one with ffmpeg and set MOCK_ABS_AUDIO to "
                "capture a player screen.",
                AUDIO_FILE,
            )
            return self._json({"error": "no audio fixture"}, status=404)
        with open(AUDIO_FILE, "rb") as handle:
            data = handle.read()
        return self._send(200, data, "audio/mpeg")


def main():
    print("mock ABS on http://%s:%d" % (HOST, PORT))
    print("libraries: %s (book), %s (podcast)" % (BOOK_LIBRARY_ID, PODCAST_LIBRARY_ID))
    print("books: %s" % ", ".join(b["id"] for b in BOOKS))
    print("in progress: %s" % ", ".join(IN_PROGRESS_IDS))
    print("finished: %s" % ", ".join(b["id"] for b in BOOKS if b.get("finished")))
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
