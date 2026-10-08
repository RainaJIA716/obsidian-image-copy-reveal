"use strict";

const { Plugin, Notice, Menu, Platform, setIcon, setTooltip, FileSystemAdapter } = require("obsidian");

const MARK = "imageCopyRevealAdded";
// Set on toolbars that got the mobile "more" button; styles.css hides the
// native edit button only there, so it never disappears without a replacement.
const MENU_MARK = "imageCopyRevealMenu";

/* ── strings ─────────────────────────────────────────────────────────── */

const REVEAL_LABEL = {
  en: Platform.isMacOS ? "Reveal in Finder" : Platform.isWin ? "Show in Explorer" : "Show in file manager",
  zh: Platform.isMacOS ? "在访达中显示" : "在文件管理器中显示",
};

const STRINGS = {
  en: {
    copy: "Copy image",
    reveal: REVEAL_LABEL.en,
    rename: "Rename after this note",
    edit: "Edit link",
    resize: "Resize",
    delete: "Delete image",
    more: "Image actions",

    copyCommand: "Copy image under cursor",
    revealCommand: `${REVEAL_LABEL.en}: image under cursor`,
    renameCommand: "Rename image under cursor after this note",
    resizeCommand: "Resize image under cursor",
    deleteCommand: "Delete image under cursor",

    copied: "Image copied",
    copyFailed: "Could not copy the image",
    notFound: "Could not find the image file",
    revealFailed: "Could not open the containing folder",
    notInVault: "This only works on images stored in the vault",
    noNote: "Could not tell which note this image belongs to",

    renameSame: "Already named after this note",
    renamed: (name) => `Renamed to ${name}`,
    renameFailed: "Could not rename the image",

    original: "Original",
    notLocated: "Could not find this image's link in the note",
    deletedLink: "Image removed",
    deletedFile: "Image removed, and its file deleted",
    keptInUse: (n) => `Image removed. The file is used in ${n} more place${n === 1 ? "" : "s"}, so it was kept`,
    keptCancelled: "Image removed, file kept",
    deleteFailed: "Image removed, but its file could not be deleted",
  },
  zh: {
    copy: "复制图片",
    reveal: REVEAL_LABEL.zh,
    rename: "重命名为笔记名",
    edit: "编辑链接",
    resize: "调整大小",
    delete: "删除图片",
    more: "图片操作",

    copyCommand: "复制鼠标下的图片",
    revealCommand: `${REVEAL_LABEL.zh}：鼠标下的图片`,
    renameCommand: "把鼠标下的图片重命名为笔记名",
    resizeCommand: "调整鼠标下图片的大小",
    deleteCommand: "删除鼠标下的图片",

    copied: "已复制图片",
    copyFailed: "复制图片失败",
    notFound: "没有找到图片文件",
    revealFailed: "无法打开所在文件夹",
    notInVault: "只能处理库内的图片",
    noNote: "无法确定图片所在的笔记",

    renameSame: "文件名已经和笔记一致",
    renamed: (name) => `已重命名为 ${name}`,
    renameFailed: "重命名失败",

    original: "原始",
    notLocated: "在笔记里找不到这张图片的链接",
    deletedLink: "已删除图片",
    deletedFile: "已删除图片和图片文件",
    keptInUse: (n) => `已删除图片；还有 ${n} 处在用这个文件，文件保留`,
    keptCancelled: "已删除图片，图片文件保留",
    deleteFailed: "已删除图片，但图片文件没能删掉",
  },
};

function t(key) {
  const lang = window.localStorage.getItem("language") || "en";
  const table = lang.startsWith("zh") ? STRINGS.zh : STRINGS.en;
  return table[key];
}

/* ── locating the file behind an embed ───────────────────────────────── */

/** Recover the on-disk path from the app:// URL of a rendered <img>. */
function pathFromSrc(src) {
  if (!src) return null;
  try {
    const url = new URL(src);
    if (url.protocol !== "app:") return null;
    const path = decodeURIComponent(url.pathname);
    return path.startsWith("/") ? path : "/" + path;
  } catch (error) {
    return null;
  }
}

function leafForEmbed(app, embedEl) {
  return app.workspace.getLeavesOfType("markdown").find((leaf) => leaf.view?.containerEl?.contains(embedEl)) ?? null;
}

/** Which note is this embed rendered in? The active file is only a fallback. */
function noteForEmbed(app, embedEl) {
  return leafForEmbed(app, embedEl)?.view.file ?? app.workspace.getActiveFile();
}

/** The vault file behind the embed, or null for remote images. */
function resolveFile(app, embedEl) {
  const linkpath = embedEl.getAttribute("src");
  const note = noteForEmbed(app, embedEl);
  if (linkpath && !/^https?:/i.test(linkpath)) {
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath.split("#")[0], note?.path ?? "");
    if (dest) return dest;
  }

  const img = embedEl.querySelector("img");
  const abs = pathFromSrc(img?.getAttribute("src") || img?.src);
  const adapter = app.vault.adapter;
  if (abs && adapter instanceof FileSystemAdapter) {
    const base = adapter.getBasePath();
    if (abs.startsWith(base + "/")) {
      const file = app.vault.getFileByPath(abs.slice(base.length + 1));
      if (file) return file;
    }
  }
  return null;
}

/**
 * Absolute path, for the actions that hand a path to the operating system.
 * The vault is asked first: it already knows the file exists, which is why
 * nothing here needs to touch the filesystem to check.
 */
function resolvePath(app, embedEl) {
  const file = resolveFile(app, embedEl);
  const adapter = app.vault.adapter;
  if (file && adapter instanceof FileSystemAdapter) return adapter.getFullPath(file.path);

  // Not a vault file — an absolute link, or one pointing outside the vault.
  const img = embedEl.querySelector("img");
  return pathFromSrc(img?.getAttribute("src") || img?.src);
}

const joinPath = (dir, name) => (dir && dir !== "/" ? `${dir}/${name}` : name);

/* ── the link text behind an embed ───────────────────────────────────── */

// The same two patterns Obsidian uses for a whole embed, wikilink and Markdown.
const WIKI_EMBED = /^(!?\[\[)(.*?)(\|(.*))?(]])$/;
const MD_EMBED = /^(!?\[)(.*?)(]\(\s*)((<[^>]*?>|[^ "]+?)(\s+([^ ]+|"[^"]+"|'[^']+'|\([^']+\)))?)?(\s*\))$/;
// Every embed in a note, for finding the one a rendered image came from.
const ANY_EMBED = /!\[\[[^\]\n]+?\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g;
// Every link of either kind, embedded or not, for counting references.
const ANY_LINK = /\[\[([^\]\n]+?)\]\]|\]\(\s*(<[^>\n]*>|[^)\s]+)[^)\n]*\)/g;

const SIZE = /^\s*[0-9]+\s*(?:x\s*[0-9]+\s*)?$/;

/** Put a width into, or with null take it out of, the alias part of a link. */
function withSize(alias, width) {
  const size = width == null ? "" : String(width);
  if (!alias || SIZE.test(alias)) return size;
  const tail = size ? `|${size}` : "";
  const bar = alias.lastIndexOf("|");
  if (bar !== -1 && SIZE.test(alias.slice(bar + 1))) return alias.slice(0, bar) + tail;
  return alias + tail;
}

/** Rewrite an embed's width the way Obsidian's own resize handle does. */
function setLinkWidth(text, width) {
  let m = text.match(WIKI_EMBED);
  if (m) {
    const alias = withSize(m[4] ?? "", width);
    return `![[${m[2]}${alias ? `|${alias}` : ""}]]`;
  }
  m = text.match(MD_EMBED);
  if (m) return m[1] + withSize(m[2], width) + m[3] + (m[4] ?? "") + m[8];
  return text;
}

/** The width an embed's text asks for, or null when it has none. */
function linkWidth(text) {
  const m = text.match(WIKI_EMBED);
  const alias = m ? m[4] ?? "" : text.match(MD_EMBED)?.[2] ?? "";
  const size = alias.slice(alias.lastIndexOf("|") + 1);
  return SIZE.test(size) ? parseInt(size, 10) : null;
}

/** The link target written in an embed or link, without subpath or size. */
function linkpathOf(text) {
  let m = text.match(WIKI_EMBED);
  if (m) return m[2].split("#")[0];
  m = text.match(MD_EMBED);
  if (!m || !m[5]) return null;
  let url = m[5];
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1).trim();
  try {
    url = decodeURI(url);
  } catch (error) {
    // Leave a malformed escape as it was written.
  }
  return url.split("#")[0];
}

/** What a link points at: the vault file, or the URL itself for remote images. */
function targetOf(app, linkpath, sourcePath) {
  if (!linkpath) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(linkpath)) return linkpath;
  return app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
}

function editorViewFor(app, embedEl) {
  try {
    const view = require("@codemirror/view").EditorView.findFromDOM(embedEl);
    if (view) return view;
  } catch (error) {
    // Fall through to the editor that owns the leaf.
  }
  return leafForEmbed(app, embedEl)?.view.editor?.cm ?? null;
}

/**
 * Where in the note's text this rendered image comes from. Of the embeds that
 * point at the same file, the one nearest the widget's position wins; that is
 * the widget itself, unless it is drawn inside something larger like a callout.
 */
function locateLink(app, embedEl) {
  const view = editorViewFor(app, embedEl);
  if (!view || !embedEl.isConnected) return null;
  const note = noteForEmbed(app, embedEl);
  const sourcePath = note?.path ?? "";
  const file = resolveFile(app, embedEl);
  const want = file ?? embedEl.getAttribute("src");
  if (!want) return null;

  let pos = 0;
  try {
    pos = view.posAtDOM(embedEl);
  } catch (error) {
    // Unknown position: any embed of the same file will be judged by distance from the top.
  }

  const doc = view.state.doc.toString();
  let best = null;
  let bestDistance = Infinity;
  for (const m of doc.matchAll(ANY_EMBED)) {
    const from = m.index;
    const to = from + m[0].length;
    if (targetOf(app, linkpathOf(m[0]), sourcePath) !== want) continue;
    const distance = pos < from ? from - pos : pos > to ? pos - to : 0;
    if (distance < bestDistance) {
      best = { from, to, text: m[0] };
      bestDistance = distance;
    }
  }
  return best && { view, file, note, ...best };
}

/** The rendered embed for the link at [from, to], after the editor has redrawn it. */
function embedAt(view, from, to) {
  for (const el of view.contentDOM.querySelectorAll(".image-embed")) {
    try {
      const pos = view.posAtDOM(el);
      if (pos >= from && pos <= to) return el;
    } catch (error) {
      // Not part of this editor's document.
    }
  }
  return null;
}

/** How many links in a piece of note text point at `file`. */
function countLinksIn(app, text, file, sourcePath) {
  let count = 0;
  for (const m of text.matchAll(ANY_LINK)) {
    let linkpath = m[1] !== undefined ? m[1].split("|")[0] : m[2];
    if (m[2] !== undefined) {
      if (linkpath.startsWith("<") && linkpath.endsWith(">")) linkpath = linkpath.slice(1, -1).trim();
      try {
        linkpath = decodeURI(linkpath);
      } catch (error) {
        // Keep it as written.
      }
    }
    if (targetOf(app, linkpath.split("#")[0], sourcePath) === file) count += 1;
  }
  return count;
}

/**
 * How many places other than this one still use `file`. Whenever there is
 * doubt the answer leans towards "still used", because the cost of a wrong
 * guess is a deleted file rather than a stray one.
 */
async function otherReferences(app, file, note, noteText) {
  const notePath = note?.path ?? "";
  // This note is read from the editor, not the cache, which may not have
  // caught up with the last few keystrokes yet.
  let count = Math.max(countLinksIn(app, noteText, file, notePath) - 1, 0);

  const resolved = app.metadataCache.resolvedLinks;
  for (const source in resolved) {
    if (source !== notePath) count += resolved[source][file.path] ?? 0;
  }

  // Other notes open in an editor may hold edits the cache has not seen.
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const path = leaf.view?.file?.path;
    if (!path || path === notePath || resolved[path]?.[file.path]) continue;
    if ((leaf.view.editor?.getValue() ?? "").includes(file.name)) count += 1;
  }

  // Recent versions index canvases; for any the cache has not credited with
  // this file, look inside directly.
  for (const canvas of app.vault.getFiles()) {
    if (canvas.extension !== "canvas" || resolved[canvas.path]?.[file.path]) continue;
    if ((await app.vault.cachedRead(canvas)).includes(file.name)) count += 1;
  }
  return count;
}

/* ── actions ─────────────────────────────────────────────────────────── */

/**
 * Re-encode an image as PNG bytes, for formats nativeImage cannot read.
 *
 * Decoded from the file's own bytes rather than painted from the <img> on the
 * page: that one is served from an app://<hash>/ origin, which taints the
 * canvas and makes it refuse to export.
 */
async function renderToPng(app, embedEl) {
  const file = resolveFile(app, embedEl);
  const img = embedEl.querySelector("img");
  let source;
  if (file) source = await createImageBitmap(new Blob([await app.vault.readBinary(file)]));
  else if (img) source = img; // Outside the vault: may be refused, and is reported if so.
  else return null;

  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth || source.width;
  canvas.height = source.naturalHeight || source.height;
  canvas.getContext("2d").drawImage(source, 0, 0);
  if (source !== img) source.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  // Loaded here rather than at the top: Node modules do not exist on mobile,
  // and only the desktop copy path needs a Buffer.
  const { Buffer } = require("buffer");
  return blob ? Buffer.from(await blob.arrayBuffer()) : null;
}

async function copyImage(app, embedEl) {
  const { clipboard, nativeImage } = require("electron");
  const path = resolvePath(app, embedEl);

  // The clipboard carries decoded pixels, never the file's own bytes, so a
  // compressed source still arrives at the far end as a full-size bitmap.
  let image = null;
  if (path) {
    const fromFile = nativeImage.createFromPath(path);
    if (!fromFile.isEmpty()) image = fromFile;
  }
  if (!image) {
    // nativeImage reads only PNG and JPEG, so WebP and friends go via canvas.
    try {
      const png = await renderToPng(app, embedEl);
      if (png) image = nativeImage.createFromBuffer(png);
    } catch (error) {
      console.error("Image Copy and Reveal: re-encoding for the clipboard failed", error);
    }
  }
  if (!image || image.isEmpty()) {
    new Notice(t("copyFailed"));
    return;
  }

  try {
    // Only the bitmap. A file reference would let a paste land as the small
    // file, but on macOS writing a custom pasteboard type clears the
    // pasteboard, so the two displace each other — and the bitmap is what
    // every target understands.
    clipboard.writeImage(image);
    new Notice(t("copied"));
  } catch (error) {
    console.error("Image Copy and Reveal: writing to the clipboard failed", error);
    new Notice(t("copyFailed"));
  }
}

function revealImage(app, embedEl) {
  const path = resolvePath(app, embedEl);
  if (!path) {
    new Notice(t("notFound"));
    return;
  }
  try {
    require("electron").shell.showItemInFolder(path);
  } catch (error) {
    console.error("Image Copy and Reveal: showItemInFolder failed", error);
    new Notice(t("revealFailed"));
  }
}

// Obsidian forbids these in file names; # ^ [ ] additionally break wikilinks.
const ILLEGAL_IN_FILENAME = /[*"\\/<>:|?#^[\]]/g;

async function renameAfterNote(app, embedEl) {
  const file = resolveFile(app, embedEl);
  if (!file) {
    new Notice(t("notInVault"));
    return;
  }
  const note = noteForEmbed(app, embedEl);
  if (!note) {
    new Notice(t("noNote"));
    return;
  }

  const base = note.basename.replace(ILLEGAL_IN_FILENAME, "").trim();
  const dir = file.parent?.path ?? "";

  // First image of a note takes the bare note name; the ones after it get
  // -1, -2, … and the counter skips over names that are already taken.
  let suffix = 0;
  let target = joinPath(dir, `${base}.${file.extension}`);
  while (target !== file.path && app.vault.getAbstractFileByPath(target)) {
    suffix += 1;
    target = joinPath(dir, `${base}-${suffix}.${file.extension}`);
  }
  if (target === file.path) {
    new Notice(t("renameSame"));
    return;
  }

  try {
    await app.fileManager.renameFile(file, target);
    new Notice(t("renamed")(target.split("/").pop()));
  } catch (error) {
    console.error("Image Copy and Reveal: rename failed", error);
    new Notice(t("renameFailed"));
  }
}

/**
 * Remove the embed from the note, then the file too when nothing else uses
 * it. The undoable step goes first; the file is touched last, and only
 * through Obsidian's own deletion, so the user's confirm-before-deleting and
 * trash settings decide what happens to it.
 */
async function deleteImage(app, embedEl) {
  const found = locateLink(app, embedEl);
  if (!found) {
    new Notice(t("notLocated"));
    return;
  }
  const { view, file, note, text } = found;

  let others = 0;
  if (file) {
    const noteText = leafForEmbed(app, embedEl)?.view.editor?.getValue() ?? view.state.doc.toString();
    others = await otherReferences(app, file, note, noteText);
  }

  // Counting may have waited on disk reads; the link must still be where it was.
  const again = locateLink(app, embedEl);
  if (!again || again.text !== text) {
    new Notice(t("notLocated"));
    return;
  }
  let { from, to } = again;
  const line = view.state.doc.lineAt(from);
  // An image on a line of its own takes its line break with it.
  if (line.text.trim() === text && line.number < view.state.doc.lines) {
    from = line.from;
    to = line.to + 1;
  }
  view.dispatch({ changes: { from, to, insert: "" }, userEvent: "delete.selection" });

  if (!file) {
    new Notice(t("deletedLink"));
    return;
  }
  if (others > 0) {
    new Notice(t("keptInUse")(others));
    return;
  }
  try {
    const deleted = await app.fileManager.promptForDeletion(file);
    new Notice(t(deleted ? "deletedFile" : "keptCancelled"));
  } catch (error) {
    console.error("Image Copy and Reveal: deleting the file failed", error);
    new Notice(t("deleteFailed"));
  }
}

/* ── resize panel (mobile, where Obsidian draws no resize handle) ─────── */

const MIN_WIDTH = 20; // Obsidian's own handle stops here too.
const PRESETS = [25, 50, 75, 100];

class ResizePanel {
  constructor(found, onClose) {
    this.view = found.view;
    this.from = found.from;
    this.text = found.text;
    this.onClose = onClose;
    this.embedEl = embedAt(this.view, found.from, found.to);
    // Same ceiling as the resize handle: the width of the editor's text column.
    this.max = Math.max(MIN_WIDTH, this.view.contentDOM.offsetWidth);

    const el = (this.el = document.body.createDiv("image-copy-reveal-resize"));
    const row = el.createDiv("image-copy-reveal-resize-row");
    this.slider = row.createEl("input", { type: "range" });
    this.slider.min = String(MIN_WIDTH);
    this.slider.max = String(this.max);
    this.valueEl = row.createSpan("image-copy-reveal-resize-value");

    const presets = el.createDiv("image-copy-reveal-resize-presets");
    for (const pct of PRESETS) {
      presets.createEl("button", { text: `${pct}%` }).addEventListener("click", () =>
        this.apply(Math.max(MIN_WIDTH, Math.round((this.max * pct) / 100)))
      );
    }
    presets.createEl("button", { text: t("original") }).addEventListener("click", () => this.apply(null));

    // Dragging only repaints; the note changes once, on release.
    this.slider.addEventListener("input", () => this.preview(Number(this.slider.value)));
    this.slider.addEventListener("change", () => this.apply(Number(this.slider.value)));

    this.showValue(linkWidth(this.text));
    this.place();

    this.onPointerDown = (event) => {
      if (!el.contains(event.target)) this.close();
    };
    this.onKeyDown = (event) => {
      if (event.key === "Escape") this.close();
    };
    this.onScroll = () => this.place();
    // Next tick, so the tap that opened the panel does not also close it.
    window.setTimeout(() => {
      if (!this.el) return;
      document.addEventListener("pointerdown", this.onPointerDown, true);
      document.addEventListener("keydown", this.onKeyDown, true);
      this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    }, 0);
  }

  img() {
    if (!this.embedEl?.isConnected) this.embedEl = embedAt(this.view, this.from, this.from + this.text.length);
    return this.embedEl?.querySelector("img") ?? null;
  }

  showValue(width) {
    const shown = width ?? this.img()?.clientWidth ?? this.max;
    this.slider.value = String(Math.min(Math.max(shown, MIN_WIDTH), this.max));
    this.valueEl.setText(width == null ? t("original") : `${width}px`);
  }

  preview(width) {
    const img = this.img();
    if (img) img.width = width;
    this.valueEl.setText(`${width}px`);
  }

  apply(width) {
    const doc = this.view.state.doc;
    const to = this.from + this.text.length;
    // The note may have been edited elsewhere since the panel opened.
    if (to > doc.length || doc.sliceString(this.from, to) !== this.text) {
      new Notice(t("notLocated"));
      this.close();
      return;
    }
    const next = setLinkWidth(this.text, width);
    if (next !== this.text) {
      this.view.dispatch({ changes: { from: this.from, to, insert: next }, scrollIntoView: false });
      this.text = next;
    }
    const img = this.img();
    if (img) {
      if (width == null) img.removeAttribute("width");
      else img.width = width;
    }
    this.showValue(width);
    this.place();
  }

  /** Below the image, kept on screen; above it when there is no room below. */
  place() {
    const anchor = (this.img() ?? this.embedEl)?.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = this.el;
    const margin = 8;
    let top = anchor ? anchor.bottom + margin : (window.innerHeight - h) / 2;
    if (anchor && top + h > window.innerHeight - margin) top = anchor.top - h - margin;
    top = Math.min(Math.max(top, margin), window.innerHeight - h - margin);
    const left = Math.min(Math.max(anchor ? anchor.left : margin, margin), window.innerWidth - w - margin);
    this.el.setCssStyles({ top: `${top}px`, left: `${Math.max(left, margin)}px` });
  }

  close() {
    if (!this.el) return;
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.el.remove();
    this.el = null;
    this.onClose(this);
  }
}

/** Obsidian's own edit button in this toolbar, when there is one. */
const nativeEditButton = (embedEl) => embedEl.querySelector(".embed-actions .edit-block-button");

/* ── plugin ──────────────────────────────────────────────────────────── */

// One table drives the desktop buttons, the mobile menu and the commands.
//   button: shown in the desktop toolbar, left to right after Obsidian's own two
//   menu:   listed in the mobile "more" menu, top to bottom
//   electron: needs the desktop app, so it is neither shown nor registered on mobile
const ACTIONS = [
  { id: "edit-image-link", icon: "code-2", label: "edit", menu: true,
    available: (el) => !!nativeEditButton(el),
    run: (plugin, el) => nativeEditButton(el)?.click() },
  { id: "resize-image-under-cursor", icon: "scaling", label: "resize", command: "resizeCommand", menu: true,
    run: (plugin, el) => plugin.openResizePanel(el) },
  { id: "rename-image-under-cursor", icon: "text-cursor-input", label: "rename", command: "renameCommand",
    button: true, menu: true,
    run: (plugin, el) => renameAfterNote(plugin.app, el) },
  { id: "reveal-image-under-cursor", icon: "folder-open", label: "reveal", command: "revealCommand",
    button: true, electron: true,
    run: (plugin, el) => revealImage(plugin.app, el) },
  { id: "copy-image-under-cursor", icon: "copy", label: "copy", command: "copyCommand",
    button: true, electron: true,
    run: (plugin, el) => copyImage(plugin.app, el) },
  { id: "delete-image-under-cursor", icon: "trash-2", label: "delete", command: "deleteCommand",
    button: true, menu: true, warning: true,
    run: (plugin, el) => deleteImage(plugin.app, el) },
];

module.exports = class ImageCopyRevealPlugin extends Plugin {
  async onload() {
    this.panel = null;
    this.register(() => this.panel?.close());
    // Toolbars outlive the plugin, so take back everything added to them;
    // otherwise a reload leaves buttons wired to the old code behind.
    this.register(() => {
      const container = this.app.workspace.containerEl;
      container.querySelectorAll(".image-copy-reveal-action").forEach((el) => el.remove());
      container.querySelectorAll("[data-image-copy-reveal-added]").forEach((el) => {
        delete el.dataset[MARK];
        delete el.dataset[MENU_MARK];
      });
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.panel?.close()));

    this.app.workspace.onLayoutReady(() => {
      this.decorateAll();
      this.observe();
    });

    for (const action of ACTIONS) {
      if (!action.command || (action.electron && !Platform.isDesktopApp)) continue;
      this.addCommand({
        id: action.id,
        name: t(action.command),
        icon: action.icon,
        checkCallback: (checking) => {
          const embedEl = this.targetEmbed();
          if (!embedEl) return false;
          if (!checking) action.run(this, embedEl);
          return true;
        },
      });
    }
  }

  /** Obsidian builds its toolbar lazily, so watch the workspace for it appearing. */
  observe() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.classList.contains("embed-actions")) this.decorate(node);
          node.querySelectorAll(".embed-actions").forEach((el) => this.decorate(el));
        }
      }
    });
    observer.observe(this.app.workspace.containerEl, { childList: true, subtree: true });
    this.register(() => observer.disconnect());
  }

  /** The image under the mouse, or on mobile, the one tapped to select it. */
  targetEmbed() {
    const container = this.app.workspace.containerEl;
    return container.querySelector(".image-embed:hover") ?? container.querySelector(".image-embed.is-selected");
  }

  decorateAll() {
    this.app.workspace.containerEl
      .querySelectorAll(".image-embed .embed-actions")
      .forEach((el) => this.decorate(el));
  }

  decorate(actionsEl) {
    if (actionsEl.dataset[MARK]) return;
    // Only images: the same toolbar is used for PDF and Mermaid embeds.
    const embedEl = actionsEl.closest(".image-embed");
    if (!embedEl) return;
    actionsEl.dataset[MARK] = "1";

    if (Platform.isMobile) {
      // A phone has room for one button, so everything, Obsidian's own edit
      // button included, goes into a menu behind it.
      actionsEl.dataset[MENU_MARK] = "1";
      this.addButton(actionsEl, "more-horizontal", t("more"), (buttonEl) => this.showMenu(embedEl, buttonEl));
      return;
    }
    for (const action of ACTIONS) {
      if (!action.button || (action.electron && !Platform.isDesktopApp)) continue;
      this.addButton(actionsEl, action.icon, t(action.label), () => action.run(this, embedEl));
    }
  }

  showMenu(embedEl, buttonEl) {
    const menu = new Menu();
    for (const action of ACTIONS) {
      if (!action.menu || (action.electron && !Platform.isDesktopApp)) continue;
      if (action.available && !action.available(embedEl)) continue;
      menu.addItem((item) => {
        item.setTitle(t(action.label)).setIcon(action.icon).onClick(() => action.run(this, embedEl));
        if (action.warning) item.setWarning(true);
      });
    }
    // Anchored to the button rather than the tap, the way Obsidian's own view
    // actions do it. On a phone the menu becomes a bottom sheet either way.
    const rect = buttonEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom, width: rect.width, overlap: true, left: true });
  }

  openResizePanel(embedEl) {
    this.panel?.close();
    const found = locateLink(this.app, embedEl);
    if (!found) {
      new Notice(t("notLocated"));
      return;
    }
    this.panel = new ResizePanel(found, (panel) => {
      if (this.panel === panel) this.panel = null;
    });
  }

  addButton(actionsEl, icon, tooltip, handler) {
    const el = actionsEl.createDiv("embed-action image-copy-reveal-action");
    setIcon(el, icon);
    setTooltip(el, tooltip, { placement: "top" });
    // Plain listeners on purpose: these buttons are created and thrown away
    // constantly, and registerDomEvent would hold a reference to every one of
    // them until unload.
    // Keep the editor's focus, so a tap does not bring up the keyboard.
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler(el);
    });
    return el;
  }
};
