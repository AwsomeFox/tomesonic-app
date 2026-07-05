#!/usr/bin/env python3
"""Generate a minimal valid EPUB 3 for the E2E reader flow.

Usage: make-epub.py <output.epub>

The book ("The Test Ebook" by Test Author) has a nav + two chapters with
enough paragraphs to paginate, so foliate produces real page counts and
location events.
"""
import sys
import zipfile

OUT = sys.argv[1]

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:e2e-test-ebook-0001</dc:identifier>
    <dc:title>The Test Ebook</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>
"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc"><h1>Contents</h1>
    <ol>
      <li><a href="chapter1.xhtml">Part One</a></li>
      <li><a href="chapter2.xhtml">Part Two</a></li>
    </ol>
  </nav>
</body>
</html>
"""


def chapter(title: str, seed: str) -> str:
    paras = "\n".join(
        f"<p>{seed} Paragraph {i} keeps the page count honest with enough "
        f"prose to spill across several rendered pages on a phone-sized "
        f"viewport, because a single-screen chapter would give the pagination "
        f"logic nothing to do.</p>"
        for i in range(1, 41)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml">\n'
        f"<head><title>{title}</title></head>\n"
        f"<body><h1>{title}</h1>\n{paras}\n</body>\n</html>\n"
    )


with zipfile.ZipFile(OUT, "w") as z:
    # mimetype MUST be first and stored uncompressed.
    z.writestr(
        zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED
    )
    z.writestr("META-INF/container.xml", CONTAINER)
    z.writestr("OEBPS/content.opf", OPF)
    z.writestr("OEBPS/nav.xhtml", NAV)
    z.writestr("OEBPS/chapter1.xhtml", chapter("Part One", "Opening movement."))
    z.writestr("OEBPS/chapter2.xhtml", chapter("Part Two", "Closing movement."))

print(f"wrote {OUT}")
