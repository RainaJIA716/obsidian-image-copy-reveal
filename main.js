"use strict";

const { Plugin, Notice, Platform, setIcon, setTooltip, FileSystemAdapter } = require("obsidian");
const fs = require("fs");

const MARK = "imageActionsAdded";

const STRINGS = {
  en: {
    copy: "Copy image",
    reveal: Platform.isMacOS ? "Reveal in Finder" : Platform.isWin ? "Show in Explorer" : "Show in file manager",
    copyCommand: "Copy image under cursor",
    revealCommand: Platform.isMacOS
      ? "Reveal image under cursor in Finder"
      : Platform.isWin
        ? "Show image under cursor in Explorer"
        : "Show image under cursor in file manager",
    copied: "Image copied",
    copyFailed: "Could not copy the image",
    notFound: "Could not find the image file",
    revealFailed: "Could not open the containing folder",
  },
  zh: {
    copy: "复制图片",
    reveal: Platform.isMacOS ? "在访达中显示" : "在文件管理器中显示",
    copyCommand: "复制鼠标下的图片",
    revealCommand: Platform.isMacOS ? "在访达中显示鼠标下的图片" : "在文件管理器中显示鼠标下的图片",
    copied: "已复制图片",
    copyFailed: "复制图片失败",
    notFound: "没有找到图片文件",
    revealFailed: "无法打开所在文件夹",
  },
};

function t(key) {
  const lang = window.localStorage.getItem("language") || "en";
  const table = lang.startsWith("zh") ? STRINGS.zh : STRINGS.en;
  return table[key];
}

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

/** Fall back to resolving the embed's link target through the metadata cache. */
function pathFromLink(app, embedEl) {
  const linkpath = embedEl.getAttribute("src");
  if (!linkpath) return null;
  const sourcePath = app.workspace.getActiveFile()?.path ?? "";
  const file = app.metadataCache.getFirstLinkpathDest(linkpath.split("#")[0], sourcePath);
  if (!file) return null;
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return null;
  return adapter.getFullPath(file.path);
}

function resolveImagePath(app, embedEl) {
  const img = embedEl.querySelector("img");
  const fromSrc = pathFromSrc(img?.getAttribute("src") || img?.src);
  if (fromSrc && fs.existsSync(fromSrc)) return fromSrc;
  const fromLink = pathFromLink(app, embedEl);
  if (fromLink && fs.existsSync(fromLink)) return fromLink;
  return null;
}

/** Put the image on the system clipboard, preferring the lossless Electron path. */
async function copyImage(app, embedEl) {
  const path = resolveImagePath(app, embedEl);
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
  const path = resolveImagePath(app, embedEl);
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

module.exports = class ImageCopyRevealPlugin extends Plugin {
  onload() {
    this.app.workspace.onLayoutReady(() => {
      this.decorateAll();
      this.observe();
    });

    this.addCommand({
      id: "copy-image-under-cursor",
      name: t("copyCommand"),
      checkCallback: (checking) => {
        const embedEl = this.hoveredEmbed();
        if (!embedEl) return false;
        if (!checking) copyImage(this.app, embedEl);
        return true;
      },
    });

    this.addCommand({
      id: "reveal-image-under-cursor",
      name: t("revealCommand"),
      checkCallback: (checking) => {
        const embedEl = this.hoveredEmbed();
        if (!embedEl) return false;
        if (!checking) revealImage(this.app, embedEl);
        return true;
      },
    });
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

    this.addButton(actionsEl, "copy", t("copy"), () => copyImage(this.app, embedEl));
    this.addButton(actionsEl, "folder-open", t("reveal"), () => revealImage(this.app, embedEl));
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
