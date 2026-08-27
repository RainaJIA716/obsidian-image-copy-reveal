"use strict";

const { Plugin, Notice, Platform, setIcon, setTooltip, FileSystemAdapter } = require("obsidian");
const fs = require("fs");
const zlib = require("zlib");
const { Buffer } = require("buffer");

const MARK = "imageCopyRevealAdded";

/* ── strings ─────────────────────────────────────────────────────────── */

const REVEAL_LABEL = {
  en: Platform.isMacOS ? "Reveal in Finder" : Platform.isWin ? "Show in Explorer" : "Show in file manager",
  zh: Platform.isMacOS ? "在访达中显示" : "在文件管理器中显示",
};

const STRINGS = {
  en: {
    copy: "Copy image",
    reveal: REVEAL_LABEL.en,
    compress: "Compress losslessly",
    rename: "Rename after this note",

    copyCommand: "Copy image under cursor",
    revealCommand: `${REVEAL_LABEL.en}: image under cursor`,
    compressCommand: "Compress image under cursor losslessly",
    renameCommand: "Rename image under cursor after this note",

    copied: "Image copied",
    copyFailed: "Could not copy the image",
    notFound: "Could not find the image file",
    revealFailed: "Could not open the containing folder",
    notInVault: "This only works on images stored in the vault",
    noNote: "Could not tell which note this image belongs to",

    unsupported: "Lossless compression only works on PNG and JPEG",
    alreadySmall: "Already as small as it gets, left untouched",
    compressed: (pct, from, to) => `Compressed ${pct}% (${from} → ${to}). Original moved to the trash.`,
    compressFailed: "Could not compress the image",

    renameSame: "Already named after this note",
    renamed: (name) => `Renamed to ${name}`,
    renameFailed: "Could not rename the image",
  },
  zh: {
    copy: "复制图片",
    reveal: REVEAL_LABEL.zh,
    compress: "无损压缩",
    rename: "重命名为笔记名",

    copyCommand: "复制鼠标下的图片",
    revealCommand: `${REVEAL_LABEL.zh}：鼠标下的图片`,
    compressCommand: "无损压缩鼠标下的图片",
    renameCommand: "把鼠标下的图片重命名为笔记名",

    copied: "已复制图片",
    copyFailed: "复制图片失败",
    notFound: "没有找到图片文件",
    revealFailed: "无法打开所在文件夹",
    notInVault: "只能处理库内的图片",
    noNote: "无法确定图片所在的笔记",

    unsupported: "无损压缩只支持 PNG 和 JPEG",
    alreadySmall: "已经是最小体积，未做改动",
    compressed: (pct, from, to) => `已压缩 ${pct}%（${from} → ${to}），原图已移到废纸篓`,
    compressFailed: "压缩失败",

    renameSame: "文件名已经和笔记一致",
    renamed: (name) => `已重命名为 ${name}`,
    renameFailed: "重命名失败",
  },
};

function t(key) {
  const lang = window.localStorage.getItem("language") || "en";
  const table = lang.startsWith("zh") ? STRINGS.zh : STRINGS.en;
  return table[key];
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
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

/** Which note is this embed rendered in? The active file is only a fallback. */
function noteForEmbed(app, embedEl) {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view?.containerEl?.contains(embedEl)) return leaf.view.file;
  }
  return app.workspace.getActiveFile();
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

/** Absolute path, for the actions that hand a path to the operating system. */
function resolvePath(app, embedEl) {
  const img = embedEl.querySelector("img");
  const fromSrc = pathFromSrc(img?.getAttribute("src") || img?.src);
  if (fromSrc && fs.existsSync(fromSrc)) return fromSrc;

  const file = resolveFile(app, embedEl);
  const adapter = app.vault.adapter;
  if (file && adapter instanceof FileSystemAdapter) {
    const full = adapter.getFullPath(file.path);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

const joinPath = (dir, name) => (dir && dir !== "/" ? `${dir}/${name}` : name);

/* ── lossless optimisers ─────────────────────────────────────────────── */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Below this, a rewrite costs more than it saves.
const MIN_SAVING_BYTES = 1024;
const MIN_SAVING_RATIO = 0.01;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Chunks that affect how the pixels are decoded or displayed. Everything else
// is metadata (text, timestamps, EXIF) and is dropped.
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs"]);

/**
 * Re-deflate the pixel data at maximum effort. The decoded pixels are
 * bit-for-bit identical; only the compression of them changes.
 */
function optimizePng(input) {
  if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  const kept = [];
  const idat = [];
  let offset = 8;
  let sawEnd = false;

  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const data = input.subarray(offset + 8, offset + 8 + length);

    if (type === "acTL" || type === "fcTL" || type === "fdAT") return null; // animated PNG, leave alone
    if (type === "IDAT") idat.push(data);
    else if (type === "IEND") { sawEnd = true; break; }
    else if (PNG_KEEP.has(type)) kept.push({ type, data });

    offset += 12 + length;
  }
  if (!sawEnd || idat.length === 0) return null;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  let best = null;
  for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED, zlib.constants.Z_RLE]) {
    const candidate = zlib.deflateSync(raw, { level: 9, memLevel: 9, strategy });
    if (!best || candidate.length < best.length) best = candidate;
  }

  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };

  const parts = [PNG_SIGNATURE];
  for (const { type, data } of kept) parts.push(chunk(type, data));
  parts.push(chunk("IDAT", best));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * Drop EXIF, XMP and IPTC blocks. The compressed scan data is copied over
 * untouched, so the image itself is unchanged.
 */
function optimizeJpeg(input) {
  if (input[0] !== 0xff || input[1] !== 0xd8) return null;

  const parts = [input.subarray(0, 2)];
  let offset = 2;

  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) return null; // not a segment boundary, give up
    const marker = input[offset + 1];

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(input.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (marker === 0xda) { // start of scan: the rest is entropy-coded data
      parts.push(input.subarray(offset));
      return Buffer.concat(parts);
    }

    const length = input.readUInt16BE(offset + 2);
    const segment = input.subarray(offset, offset + 2 + length);
    const isMetadata = marker === 0xe1 || marker === 0xed || marker === 0xfe; // APP1, APP13, comment
    if (!isMetadata) parts.push(segment);
    offset += 2 + length;
  }
  return null;
}

/* ── actions ─────────────────────────────────────────────────────────── */

async function copyImage(app, embedEl) {
  const path = resolvePath(app, embedEl);
  if (path) {
    try {
      const { clipboard, nativeImage } = require("electron");
      const image = nativeImage.createFromPath(path);
      if (!image.isEmpty()) {
        clipboard.writeImage(image);
        new Notice(t("copied"));
        return;
      }
    } catch (error) {
      console.error("Image Copy & Reveal: writing to the Electron clipboard failed", error);
    }
  }

  // Fallback: repaint the rendered <img> onto a canvas, which only yields PNG.
  const img = embedEl.querySelector("img");
  if (!img) {
    new Notice(t("notFound"));
    return;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    new Notice(t("copied"));
  } catch (error) {
    console.error("Image Copy & Reveal: writing the canvas to the clipboard failed", error);
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
    console.error("Image Copy & Reveal: showItemInFolder failed", error);
    new Notice(t("revealFailed"));
  }
}

async function compressImage(app, embedEl) {
  const file = resolveFile(app, embedEl);
  if (!file) {
    new Notice(t("notInVault"));
    return;
  }

  const extension = file.extension.toLowerCase();
  if (!["png", "jpg", "jpeg"].includes(extension)) {
    new Notice(t("unsupported"));
    return;
  }

  try {
    const before = Buffer.from(await app.vault.readBinary(file));
    const after = extension === "png" ? optimizePng(before) : optimizeJpeg(before);

    const saved = after ? before.length - after.length : 0;
    if (saved < MIN_SAVING_BYTES || saved / before.length < MIN_SAVING_RATIO) {
      // Rewriting the file and sending the original to the trash is not worth
      // it for a handful of bytes.
      new Notice(t("alreadySmall"));
      return;
    }

    // Write the smaller file next to the original, send the original to the
    // system trash, then move the new one into its place. The note keeps
    // pointing at the same name throughout.
    const dir = file.parent?.path ?? "";
    const targetPath = file.path;
    const tempPath = joinPath(dir, `${file.basename}.recompressed.${file.extension}`);

    // A Node Buffer is a window onto a shared pool, so its .buffer is not the
    // bytes we mean. Copy into an ArrayBuffer of exactly the right size.
    const bytes = new Uint8Array(after);
    const temp = await app.vault.createBinary(tempPath, bytes.buffer);
    await app.vault.trash(file, true);
    await app.fileManager.renameFile(temp, targetPath);

    const percent = Math.round((1 - after.length / before.length) * 100);
    new Notice(t("compressed")(percent, formatSize(before.length), formatSize(after.length)));
  } catch (error) {
    console.error("Image Copy & Reveal: compression failed", error);
    new Notice(t("compressFailed"));
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
    console.error("Image Copy & Reveal: rename failed", error);
    new Notice(t("renameFailed"));
  }
}

/* ── plugin ──────────────────────────────────────────────────────────── */

const ACTIONS = [
  { id: "copy-image-under-cursor", icon: "copy", label: "copy", command: "copyCommand", run: copyImage },
  { id: "reveal-image-under-cursor", icon: "folder-open", label: "reveal", command: "revealCommand", run: revealImage },
  { id: "compress-image-under-cursor", icon: "shrink", label: "compress", command: "compressCommand", run: compressImage },
  { id: "rename-image-under-cursor", icon: "text-cursor-input", label: "rename", command: "renameCommand", run: renameAfterNote },
];

module.exports = class ImageCopyRevealPlugin extends Plugin {
  onload() {
    this.app.workspace.onLayoutReady(() => {
      this.decorateAll();
      this.observe();
    });

    for (const action of ACTIONS) {
      this.addCommand({
        id: action.id,
        name: t(action.command),
        checkCallback: (checking) => {
          const embedEl = this.hoveredEmbed();
          if (!embedEl) return false;
          if (!checking) action.run(this.app, embedEl);
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

  hoveredEmbed() {
    return this.app.workspace.containerEl.querySelector(".image-embed:hover");
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

    for (const action of ACTIONS) {
      this.addButton(actionsEl, action.icon, t(action.label), () => action.run(this.app, embedEl));
    }
  }

  addButton(actionsEl, icon, tooltip, handler) {
    const el = actionsEl.createDiv("embed-action");
    setIcon(el, icon);
    setTooltip(el, tooltip, { placement: "top" });
    // Plain listener on purpose: these buttons are created and thrown away
    // constantly, and registerDomEvent would hold a reference to every one of
    // them until unload.
    el.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler();
    });
    return el;
  }
};
