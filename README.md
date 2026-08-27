# Image Copy & Reveal

![Copy image and reveal in Finder buttons added to Obsidian's built-in image toolbar](docs/hero.svg)

Copy an image to the clipboard, or reveal it in Finder or Explorer, without leaving Obsidian and without the right-click menu.

Unlike other image plugins, this one does not draw a toolbar of its own. It adds its two buttons to the **built-in** hover toolbar that Obsidian itself shows in the top-right corner of an embedded image, next to the native zoom and edit buttons:

| Button | What it does |
| --- | --- |
| Copy image | Puts the image itself on the system clipboard, so it can be pasted into any other app |
| Reveal in file explorer | Opens the containing folder and selects the file (Finder on macOS, Explorer on Windows) |

Both actions are also available from the command palette, so they can be bound to hotkeys and triggered while hovering over an image. Button labels and commands follow the Obsidian interface language (English and Chinese are included).

## Requirements

- Obsidian 1.13.0 or later (the hover toolbar this plugin extends is built in from that version)
- Desktop only — the clipboard and file-explorer integrations use Electron APIs that do not exist on mobile

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
