# Image Copy & Reveal

![Four buttons added to Obsidian's built-in image toolbar](docs/hero.svg)

Copy an image to the clipboard, reveal it in Finder or Explorer, shrink it losslessly, or rename it after the note it sits in — without leaving Obsidian and without the right-click menu.

Unlike other image plugins, this one does not draw a toolbar of its own. It adds its buttons to the **built-in** hover toolbar that Obsidian itself shows in the top-right corner of an embedded image, next to the native zoom and edit buttons:

| Button | What it does |
| --- | --- |
| Copy image | Puts the image itself on the system clipboard, so it can be pasted into any other app |
| Reveal in file explorer | Opens the containing folder and selects the file (Finder on macOS, Explorer on Windows) |
| Compress losslessly | Rewrites the file smaller without touching a single pixel, and sends the original to the system trash |
| Rename after this note | Renames the image to match the note it is embedded in, numbering repeats automatically |

Every action is also a command, so it can be bound to a hotkey and fired while hovering over an image. Labels follow the Obsidian interface language (English and Chinese are included).

## Lossless compression

Lossless here means exactly that: the decoded pixels are bit-for-bit identical before and after. Nothing is re-sampled, re-quantised or re-encoded at a lower quality.

- **PNG** — the pixel data is re-deflated at maximum effort, trying several compression strategies and keeping the smallest. Colour-critical chunks (`IHDR`, `PLTE`, `tRNS`, `gAMA`, `cHRM`, `sRGB`, `iCCP`, `sBIT`, `bKGD`, `pHYs`) are preserved; text, timestamp and EXIF chunks are dropped.
- **JPEG** — EXIF, XMP and IPTC blocks are removed. The compressed scan data is copied across untouched.
- Other formats are refused rather than guessed at.

Expect roughly **8–35% off PNG screenshots** and **close to nothing off JPEG photos**, whose Huffman tables are usually already optimal. When the saving would be under 1 KB or under 1%, the file is left alone and the plugin says so — a rewrite plus a trip to the trash is not worth a handful of bytes.

The original always goes to the **system trash**, never straight to deletion, so a bad result is one restore away. Animated PNGs are skipped.

## Renaming

The first image takes the note's own name; later ones get `-1`, `-2` and so on, and the counter skips over names that are already taken. Links are updated through Obsidian's own rename machinery, so every note that points at the image follows along.

## Requirements

- Obsidian 1.13.0 or later (the hover toolbar this plugin extends is built in from that version)
- Desktop only — the clipboard, file-explorer and compression code uses Node and Electron APIs that do not exist on mobile

## Installation

### From the community plugin store

Settings → Community plugins → Browse → search for "Image Copy & Reveal" → Install → Enable.

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](../../releases/latest).
2. Put them in `<vault>/.obsidian/plugins/image-copy-reveal/`.
3. Reload Obsidian and enable the plugin under Settings → Community plugins.

## How it works

Obsidian renders its own action toolbar as `.embed-actions` inside `.image-embed`. The plugin watches for that element and appends its two buttons to it, so they sit alongside the built-in zoom and edit buttons and inherit their styling.

The image file is located from the `app://` URL on the rendered `<img>`, falling back to resolving the embed's link target through the metadata cache.

That toolbar is an internal part of Obsidian rather than a public API, so a future redesign of it could stop the buttons from appearing. Nothing else breaks if that happens, and the two commands keep working. Toolbars inside hover popovers are not covered, because the plugin only watches the workspace container.

## License

MIT — see [LICENSE](LICENSE).
