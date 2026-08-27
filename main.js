"use strict";

const { Plugin, PluginSettingTab, Setting, Notice, Platform, setIcon, setTooltip, FileSystemAdapter } = require("obsidian");
const fs = require("fs");

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
    compress: "Convert to WebP",
    rename: "Rename after this note",

    copyCommand: "Copy image under cursor",
    revealCommand: `${REVEAL_LABEL.en}: image under cursor`,
    compressCommand: "Convert image under cursor to WebP",
    renameCommand: "Rename image under cursor after this note",

    copied: "Image copied",
    copyFailed: "Could not copy the image",
    notFound: "Could not find the image file",
    revealFailed: "Could not open the containing folder",
    notInVault: "This only works on images stored in the vault",
    noNote: "Could not tell which note this image belongs to",

    unsupported: "Only PNG, JPEG and BMP can be converted",
    alreadyWebp: "Already a WebP, not compressing it again",
    working: "Converting…",
    alreadySmall: "WebP would not be smaller, left untouched",
    compressed: (pct, from, to) => `Compressed ${pct}% (${from} → ${to}). Original moved to the trash.`,
    compressFailed: "Could not convert the image",
    qualityName: "WebP quality",
    qualityDesc: "Higher keeps more detail and produces bigger files. 90 is a good starting point for screenshots.",

    renameSame: "Already named after this note",
    renamed: (name) => `Renamed to ${name}`,
    renameFailed: "Could not rename the image",
  },
  zh: {
    copy: "复制图片",
    reveal: REVEAL_LABEL.zh,
    compress: "转为 WebP",
    rename: "重命名为笔记名",

    copyCommand: "复制鼠标下的图片",
    revealCommand: `${REVEAL_LABEL.zh}：鼠标下的图片`,
    compressCommand: "把鼠标下的图片转为 WebP",
    renameCommand: "把鼠标下的图片重命名为笔记名",

    copied: "已复制图片",
    copyFailed: "复制图片失败",
    notFound: "没有找到图片文件",
    revealFailed: "无法打开所在文件夹",
    notInVault: "只能处理库内的图片",
    noNote: "无法确定图片所在的笔记",

    unsupported: "只支持 PNG、JPEG、BMP 转 WebP",
    alreadyWebp: "已经是 WebP，不重复有损压缩",
    working: "正在压缩…",
    alreadySmall: "转成 WebP 反而更大，未做改动",
    compressed: (pct, from, to) => `已压缩 ${pct}%（${from} → ${to}），原图已移到废纸篓`,
    compressFailed: "压缩失败",
    qualityName: "WebP 质量",
    qualityDesc: "越高越清晰，文件也越大。截图建议 90。",

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

const WEBP_SOURCES = ["png", "jpg", "jpeg", "bmp"];

// Below this, a rewrite costs more than it saves.
const MIN_SAVING_BYTES = 1024;
const MIN_SAVING_RATIO = 0.01;

/** Re-encode through the WebP encoder Chromium already ships with. */
async function encodeWebp(app, file, quality) {
  const source = await app.vault.readBinary(file);
  const bitmap = await createImageBitmap(new Blob([source]));

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality / 100));
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), sourceBytes: new Uint8Array(source) };
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

async function compressImage(app, embedEl, settings) {
  const file = resolveFile(app, embedEl);
  if (!file) {
    new Notice(t("notInVault"));
    return;
  }

  const extension = file.extension.toLowerCase();
  if (extension === "webp") {
    // Re-encoding an already lossy file only throws away more detail.
    new Notice(t("alreadyWebp"));
    return;
  }
  if (!WEBP_SOURCES.includes(extension)) {
    new Notice(t("unsupported"));
    return;
  }

  const notice = new Notice(t("working"), 0);
  try {
    const encoded = await encodeWebp(app, file, settings.quality);
    if (!encoded) {
      notice.hide();
      new Notice(t("compressFailed"));
      return;
    }

    const { bytes, sourceBytes } = encoded;
    const saved = sourceBytes.length - bytes.length;
    if (saved < MIN_SAVING_BYTES || saved / sourceBytes.length < MIN_SAVING_RATIO) {
      notice.hide();
      new Notice(t("alreadySmall"));
      return;
    }

    const dir = file.parent?.path ?? "";
    const sourcePath = file.path;
    let target = joinPath(dir, `${file.basename}.webp`);
    let suffix = 0;
    while (app.vault.getAbstractFileByPath(target)) {
      suffix += 1;
      target = joinPath(dir, `${file.basename}-${suffix}.webp`);
    }

    // Rename first, so every note that embeds this image follows the file to
    // its new extension. The bytes are still the old ones at this point.
    await app.fileManager.renameFile(file, target);
    await app.vault.modifyBinary(file, bytes.buffer);

    // Put the untouched original back under its old name purely so it can go
    // to the trash looking like itself, rather than as a stray temp file.
    const original = await app.vault.createBinary(sourcePath, sourceBytes.buffer);
    await app.vault.trash(original, true);

    notice.hide();
    const percent = Math.round((saved / sourceBytes.length) * 100);
    new Notice(t("compressed")(percent, formatSize(sourceBytes.length), formatSize(bytes.length)));
  } catch (error) {
    notice.hide();
    console.error("Image Copy & Reveal: WebP conversion failed", error);
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

const DEFAULT_SETTINGS = { quality: 90 };

// Left to right, following the two buttons Obsidian draws itself.
const ACTIONS = [
  { id: "rename-image-under-cursor", icon: "text-cursor-input", label: "rename", command: "renameCommand",
    run: (plugin, el) => renameAfterNote(plugin.app, el) },
  { id: "compress-image-under-cursor", icon: "shrink", label: "compress", command: "compressCommand",
    run: (plugin, el) => compressImage(plugin.app, el, plugin.settings) },
  { id: "reveal-image-under-cursor", icon: "folder-open", label: "reveal", command: "revealCommand",
    run: (plugin, el) => revealImage(plugin.app, el) },
  { id: "copy-image-under-cursor", icon: "copy", label: "copy", command: "copyCommand",
    run: (plugin, el) => copyImage(plugin.app, el) },
];

class ImageCopyRevealSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName(t("qualityName"))
      .setDesc(t("qualityDesc"))
      .addSlider((slider) =>
        slider
          .setLimits(50, 100, 1)
          .setValue(this.plugin.settings.quality)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.quality = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = class ImageCopyRevealPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new ImageCopyRevealSettingTab(this.app, this));

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
          if (!checking) action.run(this, embedEl);
          return true;
        },
      });
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
      this.addButton(actionsEl, action.icon, t(action.label), () => action.run(this, embedEl));
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
