# Disclosure font

`OutfitDisclosure-Medium.otf` is a 4,180-byte subset of **Noto Sans CJK SC Medium**,
renamed **Outfit Disclosure Medium**. It contains only `A`, `I`, `生`, `成`
(U+0041, U+0049, U+751F, U+6210) and the required `.notdef` glyph.

Copyright © 2014–2021 Adobe (http://www.adobe.com/).
Distributed under the **SIL Open Font License, Version 1.1**; the complete original
license is in [OFL.txt](OFL.txt). The subset retains the upstream copyright,
license, and trademark font metadata. Its family, full, and PostScript names are
changed so the modified font is distinct from the original font.

- [Upstream font at the pinned revision](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Medium.otf)
- [Upstream license at the pinned revision](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE)
- Source SHA-256: `ca094f6b0001fb048ca39ddd797a0cdb0179e1e55c6561e111c49c3e6a61d7b7`
- Subset SHA-256: `d4dfe5a94c4df1f127004a4405c5627cdc2922b9374d8aaf5948131e469bb702`

To reproduce from the downloaded, unmodified source font, run from `server/`:

```sh
uv run --no-project --with 'fonttools==4.60.1' python scripts/subset_label_font.py path/to/NotoSansCJKsc-Medium.otf app/fonts/OutfitDisclosure-Medium.otf
```

fontTools is needed only to rebuild the asset. The application uses Pillow's
FreeType renderer; it does not depend on an installed system font or a network
font download. `Dockerfile` copies the complete `app/` directory, including this
font, its source notice, and its license.
