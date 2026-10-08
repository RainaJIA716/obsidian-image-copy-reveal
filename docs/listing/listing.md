# Listing fields (community.obsidian.md)

Kept in the repo so the next update starts from what is live. Fill these in from the plugin's dashboard.

## Why the short description is written this way

Both searches only read the **name and the short description** (checked 2026-10-08):

- In Obsidian: name + author + description are lowercased and joined, the query is split on spaces, and **every word must appear as a substring** somewhere in that text. Matches are then sorted by **downloads**, not relevance. So matching at all is what counts, and long-tail queries with few matches are where a smaller plugin lands near the top.
- On community.obsidian.md: words found only in About or the README do not surface the plugin.

So the description packs distinct words people type, plural where it helps (`images` also matches `image`), and skips words the name already has (image, copy, reveal). Measured against 31 long-tail queries by replaying the in-app search over the registry: the old description was found by 10 and ranked top 5 for 6; this one is found by 27 and top 5 for 18.

## Short description (≤200, also `manifest.json`)

Image toolbar, mobile/iPhone too: resize images, delete them with unused attachment files, convert/compress PNG/JPG screenshots to WebP, rename after note, show in Finder/Explorer, copy to clipboard.

## About (≤1000)

Adds buttons to the image toolbar Obsidian already shows on embedded images. No extra toolbar, no right-click menu.

• Resize images on mobile. Obsidian's drag handle is desktop only; tap an image on iPhone, iPad or Android, choose Resize, and set the width with a slider or 25 / 50 / 75 / 100%.
• Delete an image and its file. Removes the embed from the note, and trashes the attachment only when no other note or canvas still uses it.
• Convert PNG / JPG screenshots to WebP on desktop, usually 80–90% smaller. Links in every note follow; the original goes to the system trash.
• Rename "Pasted image 2026…" after the note it sits in.
• Show the file in Finder or Explorer, or copy the image to paste into chat, email or design apps, WebP included.

Every action is also a command, for hotkeys and the mobile toolbar. English and Chinese.

## Categories (≤3, first is primary)

Images · Attachments · Interface

## Screenshots (1200×800 at 2x, in this order)

1. `1-desktop-toolbar.png`
2. `2-mobile-resize.png`
3. `3-delete-image.png`
4. `4-convert-webp.png`
