"""Build the two Charlier status glyphs from their SVG outlines.

Install the pinned development tool with:
    python -m pip install -r scripts/requirements-icons.txt
Then rebuild with:
    python scripts/build-icon-font.py
The generated WOFF is checked in; packaging does not need Python.
"""

from pathlib import Path
from xml.etree import ElementTree

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "media" / "glyphs"
OUTPUT = ROOT / "media" / "charlier-status-v2.woff"
GLYPHS = {
    "codex-prompt": (SOURCE / "codex-prompt.svg", 0xE001),
    "antigravity-star": (SOURCE / "antigravity-star.svg", 0xE002),
}


def svg_glyph(source: Path):
    pen = TTGlyphPen(None)
    target = TransformPen(pen, (40, 0, 0, -40, 20, 980))
    root = ElementTree.parse(source).getroot()
    for element in root.iter():
        if element.tag.endswith("path"):
            parse_path(element.attrib["d"], target)
    return pen.glyph()


def main():
    order = [".notdef", *GLYPHS]
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    glyphs.update({name: svg_glyph(path) for name, (path, _) in GLYPHS.items()})

    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap({codepoint: name for name, (_, codepoint) in GLYPHS.items()})
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({
        name: (1000, glyphs[name].xMin if name != '.notdef' else 0)
        for name in order
    })
    builder.setupHorizontalHeader(ascent=980, descent=-20)
    builder.setupNameTable({
        "familyName": "Charlier Status v2",
        "styleName": "Regular",
        "uniqueFontIdentifier": "Charlier Status 2.0",
        "fullName": "Charlier Status v2",
        "psName": "CharlierStatusV2-Regular",
        "version": "Version 2.0",
    })
    builder.setupOS2(sTypoAscender=980, sTypoDescender=-20, usWinAscent=980, usWinDescent=20)
    builder.setupPost()
    builder.setupMaxp()
    font = builder.font
    font['head'].created = 3800000001
    font['head'].modified = 3800000001
    font.recalcTimestamp = False
    font.flavor = "woff"
    font.save(OUTPUT)
    print(f"Built {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
