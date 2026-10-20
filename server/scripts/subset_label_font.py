"""Rebuild the bundled disclosure subset (requires fontTools, not a runtime dependency)."""

import argparse
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="upstream NotoSansCJKsc-Medium.otf")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    font = TTFont(args.source, recalcTimestamp=False)
    options = subset.Options()
    options.notdef_outline = True
    options.layout_features = []
    options.name_IDs = ["*"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text="AI生成")
    subsetter.subset(font)
    names = {
        1: "Outfit Disclosure",
        2: "Medium",
        3: "OutfitDisclosure-Medium-Subset-1",
        4: "Outfit Disclosure Medium",
        6: "OutfitDisclosure-Medium",
        16: "Outfit Disclosure",
        17: "Medium",
    }
    # Give the modified font its own family and PostScript names. Preserve the
    # original copyright, trademark, and license records in both font tables.
    for record in list(font["name"].names):
        if record.nameID in names:
            font["name"].setName(
                names[record.nameID], record.nameID, record.platformID,
                record.platEncID, record.langID,
            )
    cff = font["CFF "].cff
    cff.fontNames = ["OutfitDisclosure-Medium"]
    cff.topDictIndex[0].FamilyName = "Outfit Disclosure"
    cff.topDictIndex[0].FullName = "Outfit Disclosure Medium"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    font.save(args.output)
    print(f"{args.output}: {args.output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
