// Generates a small multi-chapter EPUB fixture for the reader Playwright
// suite. An EPUB is just a zip; every entry is written STORED (no
// compression), which is valid zip AND satisfies the EPUB rule that the
// `mimetype` entry comes first and uncompressed — so no zip library is
// needed, only a CRC32 and some header bookkeeping.
//
// Each chapter carries deterministic paragraph markers ("c2p013") so tests
// can measure WHERE a TTS text extraction starts/ends and detect page
// overlap regressions numerically instead of string-guessing.
//
// Usage:
//   node build-epub.mjs [outFile]           (CLI)
//   import { buildEpubBuffer } from "./build-epub.mjs"  (programmatic)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Minimal STORED-entry zip writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name: string, data: Buffer|string }] — order preserved. */
export function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: STORED
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: STORED
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    localParts.push(local, nameBuf, data);
    centralParts.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// EPUB content
// ---------------------------------------------------------------------------

export const CHAPTER_COUNT = 4;
export const PARAGRAPHS_PER_CHAPTER = 60;

// A varied filler sentence pool so hyphenation/justification doesn't produce
// degenerate identical pages.
const FILLER = [
  "The lighthouse keeper counted the waves as they broke against the rocks below.",
  "Every morning the market square filled with carts, canvas awnings, and shouting.",
  "A narrow path wound up through the pines toward the ridge and the old fire tower.",
  "She kept the letters in a tin box under the floorboard beside the stove.",
  "Rain moved across the valley in long grey curtains that erased the far hills.",
  "The clockmaker adjusted the escapement with a screwdriver no bigger than a pin.",
];

function paragraph(chapter, para) {
  // Marker token first: "c2p013". Three fillers per paragraph ≈ 240 chars, so
  // a 60-paragraph chapter (~15k chars) paginates into several pages at
  // 600x800 / 100% font size.
  const marker = `c${chapter}p${String(para).padStart(3, "0")}`;
  const f = (i) => FILLER[(chapter * 7 + para * 3 + i) % FILLER.length];
  return `<p>Marker ${marker}. ${f(0)} ${f(1)} ${f(2)}</p>`;
}

function chapterXhtml(n) {
  const paras = [];
  for (let p = 1; p <= PARAGRAPHS_PER_CHAPTER; p++) paras.push(paragraph(n, p));
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Chapter ${n}</title></head>
<body>
<section epub:type="chapter">
<h1>Chapter ${n}</h1>
${paras.join("\n")}
</section>
</body>
</html>`;
}

function navXhtml() {
  const items = [];
  for (let n = 1; n <= CHAPTER_COUNT; n++) {
    items.push(`<li><a href="ch${n}.xhtml">Chapter ${n}</a></li>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc"><h1>Contents</h1><ol>
${items.join("\n")}
</ol></nav>
</body>
</html>`;
}

function contentOpf() {
  const manifest = [];
  const spine = [];
  for (let n = 1; n <= CHAPTER_COUNT; n++) {
    manifest.push(`<item id="ch${n}" href="ch${n}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${n}"/>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:e2e-reader-fixture-0001</dc:identifier>
    <dc:title>Reader E2E Fixture</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifest.join("\n    ")}
  </manifest>
  <spine>
    ${spine.join("\n    ")}
  </spine>
</package>`;
}

export function buildEpubBuffer() {
  const entries = [
    // MUST be first and STORED, per the EPUB OCF spec.
    { name: "mimetype", data: "application/epub+zip" },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    },
    { name: "OEBPS/content.opf", data: contentOpf() },
    { name: "OEBPS/nav.xhtml", data: navXhtml() },
  ];
  for (let n = 1; n <= CHAPTER_COUNT; n++) {
    entries.push({ name: `OEBPS/ch${n}.xhtml`, data: chapterXhtml(n) });
  }
  return buildStoredZip(entries);
}

// CLI: node build-epub.mjs [outFile]
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture.epub");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildEpubBuffer());
  console.log(`wrote ${out}`);
}
