<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { openEpub } from "@/lib/epub";
import { idbDelete, idbGetAll, idbPut } from "@/lib/idb";
import { formatBytes, formatDate } from "@/lib/format";
import { goHome } from "@/lib/navigation";
import { hasModifier } from "@/lib/platform";
import { notify } from "@/stores/ui";
import { locale, t } from "@/i18n";

const ACCENT = "#b06ae0";

const books = ref([]);
const loading = ref(true);
const importing = ref(false);
const dragging = ref(false);
const active = ref(null);
const deleteCandidate = ref(null);
const fileInput = ref(null);
const frameRef = ref(null);
const stageRef = ref(null);

const view = reactive({
  phase: "idle", // idle | opening | rendering | ready | error
  error: null,
  chapter: 0,
  progress: 0,
  zoom: 1,
  fontScale: 1,
  theme: "paper",
  width: "normal",
  tocOpen: false,
  askResume: false,
  resumeChapter: 0,
  loadedName: "",
});
const drag = reactive({ active: false, x: 0, y: 0, left: 0, top: 0 });

let book = null;
const bookVersion = ref(0);
let scrollTimer = null;
let saveTimer = null;
let deleteTimer = null;
let loadToken = 0;
let objectUrls = [];

const canPrev = computed(() => view.chapter > 0);
const canNext = computed(() => Boolean(active.value) && view.chapter < totalChapters.value - 1);
const totalChapters = computed(() => (active.value ? active.value.chapterCount || 0 : 0));
const chapterName = computed(() => {
  void bookVersion.value; // book 是普通变量，必须显式建立依赖
  const current = book?.chapters?.[view.chapter];
  if (!current) return "";
  const entries = book.toc.filter((item) => item.chapter === view.chapter);
  // 同一章可能有多个目录项（含子条目），优先用不带片段的一级标题
  const primary = entries.find((item) => !item.fragment) || entries[0];
  return (primary && primary.label) || tocLabel(current.name) || current.name;
});
// book 只是普通变量，用 bookVersion 触发依赖这些值的 computed 重新求值
const toc = computed(() => {
  void bookVersion.value;
  return book ? book.toc : [];
});
const shelfBytes = computed(() => books.value.reduce((sum, item) => sum + (item.size || 0), 0));
const themeLabel = computed(() => t("epub.theme." + view.theme));

function uid() {
  if (window.crypto && window.crypto.randomUUID) return "epub-" + window.crypto.randomUUID();
  return "epub-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function tocLabel(name) {
  return String(name || "").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
}

function isEpubFile(file) {
  if (!file) return false;
  return (file.type && /epub\+zip/i.test(file.type)) || /\.epub$/i.test(file.name || "");
}

function progressLabel(row) {
  if (!row.chapterCount) return t("epub.progressUnread");
  const percent = Math.min(100, Math.round(((Number(row.lastChapter) || 0) / row.chapterCount) * 100));
  return t("epub.progressAt", { chapter: (Number(row.lastChapter) || 0) + 1, total: row.chapterCount, percent });
}

function progressPercent(row) {
  if (!row.chapterCount) return 0;
  return Math.min(100, Math.round(((Number(row.lastChapter) || 0) / row.chapterCount) * 100));
}

/* ---------------- shelf ---------------- */

async function refresh() {
  loading.value = true;
  try {
    const rows = await idbGetAll("epubs");
    // 书架列表不带书体，正文按需读取，避免一次性把整柜书载入内存
    books.value = rows
      .map(({ data, blob, ...meta }) => meta)
      .sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
  } catch (error) {
    notify(t("epub.shelfError", { error: error.message }), "error");
  } finally {
    loading.value = false;
  }
}

async function importFiles(fileList) {
  const files = [...(fileList || [])].filter(isEpubFile);
  if (!files.length) {
    notify(t("epub.noFiles"), "info");
    return 0;
  }
  importing.value = true;
  let added = 0;
  try {
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      let meta = null;
      try {
        meta = await openEpub(buffer, null);
      } catch (error) {
        notify(t("epub.importFailed", { name: file.name, error: error.message }), "error");
        continue;
      }
      const info = meta.metadata;
      const cover = await coverDataUrl(meta.coverUrl);
      meta.revoke();
      await idbPut("epubs", {
        id: uid(),
        name: file.name,
        size: file.size,
        type: file.type || "application/epub+zip",
        addedAt: Date.now(),
        lastReadAt: 0,
        lastChapter: 0,
        lastProgress: 0,
        chapterCount: meta.chapters.length,
        title: info.title || tocLabel(file.name),
        author: info.creator || "",
        publisher: info.publisher || "",
        language: info.language || "",
        cover,
        data: buffer,
      });
      added += 1;
    }
    await refresh();
    if (added) notify(t("epub.imported", { count: added }), "success");
  } catch (error) {
    notify(t("epub.importFailedShort", { error: error.message }), "error");
  } finally {
    importing.value = false;
  }
  return added;
}

/** 封面在导入时转成 data URL 存进书架，下次打开无需重新解析 EPUB */
async function coverDataUrl(url) {
  if (!url) return "";
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    if (blob.size > 3 * 1024 * 1024) return "";
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  } catch {
    return "";
  }
}

function pickFile() {
  if (fileInput.value) fileInput.value.click();
}

async function onFileChange(event) {
  const files = event.target.files;
  event.target.value = "";
  await importFiles(files);
}

async function onDrop(event) {
  dragging.value = false;
  const transfer = event.dataTransfer;
  if (!transfer) return;
  if (transfer.files && transfer.files.length) {
    await importFiles(transfer.files);
    return;
  }
  await importPaths(transfer);
}

// 桌面端从 Finder 拖进来的目录会走 items，逐项取文件
async function importPaths(transfer) {
  const entries = transfer.items ? [...transfer.items].filter((item) => item.kind === "file") : [];
  if (!entries.length) {
    notify(t("epub.noFiles"), "info");
    return;
  }
  const files = [];
  for (const item of entries) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry && entry.isDirectory) files.push(...(await readDirectory(entry)));
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  await importFiles(files);
}

function readDirectory(entry, prefix = "", depth = 0) {
  return new Promise((resolve) => {
    if (depth > 3) {
      resolve([]);
      return;
    }
    const reader = entry.createReader();
    const files = [];
    const readBatch = () => {
      reader.readEntries(async (batch) => {
        if (!batch.length) {
          resolve(files);
          return;
        }
        for (const child of batch) {
          if (child.isFile) {
            const file = await new Promise((done) => child.file(done, () => done(null)));
            if (file) files.push(file);
          } else if (child.isDirectory) {
            files.push(...(await readDirectory(child, prefix + child.name + "/", depth + 1)));
          }
        }
        readBatch();
      }, () => resolve(files));
    };
    readBatch();
  });
}

function askDelete(row) {
  if (deleteCandidate.value === row.id) {
    removeBook(row);
    return;
  }
  deleteCandidate.value = row.id;
  clearTimeout(deleteTimer);
  deleteTimer = setTimeout(() => {
    deleteCandidate.value = null;
  }, 3200);
}

async function removeBook(row) {
  deleteCandidate.value = null;
  clearTimeout(deleteTimer);
  try {
    await idbDelete("epubs", row.id);
    await refresh();
    notify(t("epub.deleted", { name: row.title || row.name }), "info");
  } catch (error) {
    notify(t("epub.deleteFailed", { error: error.message }), "error");
  }
}

/* ---------------- reader ---------------- */

function releaseBook() {
  if (book) {
    book.revoke();
    book = null;
    bookVersion.value += 1;
  }
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
}

function cleanupReader() {
  if (scrollTimer) {
    clearTimeout(scrollTimer);
    scrollTimer = null;
  }
  const stage = stageRef.value;
  if (stage) stage.removeEventListener("scroll", onScroll);
  releaseBook();
}

async function openBook(row) {
  if (!row) return;
  cleanupReader();
  const token = ++loadToken;
  active.value = row;
  view.phase = "opening";
  view.error = null;
  view.chapter = Math.min(Math.max(0, Number(row.lastChapter) || 0), Math.max(0, (row.chapterCount || 1) - 1));
  view.progress = Number(row.lastProgress) || 0;
  view.zoom = 1;
  view.fontScale = 1;
  view.theme = view.theme || "paper";
  view.tocOpen = false;
  view.askResume = false;
  view.resumeChapter = view.chapter;
  view.loadedName = "";

  try {
    const stored = await readBook(row.id);
    if (token !== loadToken) return;
    if (!stored) throw new Error(t("epub.missingData"));
    const payload = stored instanceof ArrayBuffer ? stored : await stored.arrayBuffer();
    const parsed = await openEpub(payload, null);
    if (token !== loadToken) {
      parsed.revoke();
      return;
    }
    book = parsed;
    bookVersion.value += 1;
    if (!book.chapters.length) throw new Error(t("epub.noChapters"));
    view.phase = "rendering";
    view.askResume = view.chapter > 0 || view.progress > 0;
    await nextTick();
    attachStage();
    await renderChapter(view.chapter, view.progress);
    view.phase = "ready";
  } catch (error) {
    if (token !== loadToken) return;
    view.phase = "error";
    view.error = t("epub.openFailed", { error: (error && (error.message || String(error))) || "unknown error" });
  }
}

async function readBook(id) {
  const rows = await idbGetAll("epubs");
  const row = rows.find((item) => item.id === id);
  if (!row) return null;
  if (row.data) return row.data;
  if (row.blob) return row.blob;
  return null;
}

function attachStage() {
  const stage = stageRef.value;
  if (!stage) return;
  stage.removeEventListener("scroll", onScroll);
  stage.addEventListener("scroll", onScroll, { passive: true });
}

async function renderChapter(index, scrollProgress = 0) {
  const stage = stageRef.value;
  const frame = frameRef.value;
  if (!stage || !frame || !book) return;
  const chapter = book.chapters[index];
  if (!chapter) return;
  const resource = book.resources.get(chapter.path);
  view.loadedName = chapter.name;
  if (!resource) {
    frame.removeAttribute("src");
    view.error = t("epub.missingChapter", { name: chapter.name });
    view.phase = "error";
    return;
  }
  view.error = null;
  frame.setAttribute("src", resource.url);
  await nextTick();
  // 文档换掉后需要重新绑定滚动监听
  attachStage();
  requestAnimationFrame(() => {
    const max = Math.max(0, stage.scrollHeight - stage.clientHeight);
    stage.scrollTop = Math.max(0, Math.min(max, Math.round(max * (Number(scrollProgress) || 0))));
  });
}

function onScroll() {
  const stage = stageRef.value;
  if (!stage) return;
  const max = Math.max(1, stage.scrollHeight - stage.clientHeight);
  view.progress = Math.min(1, Math.max(0, stage.scrollTop / max));
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    scrollTimer = null;
    queueSave();
  }, 320);
}

async function goChapter(index, fragment = "") {
  if (!book) return;
  const next = Math.min(Math.max(0, index), book.chapters.length - 1);
  const previous = view.chapter;
  view.chapter = next;
  view.tocOpen = false;
  await renderChapter(next, next === previous ? view.progress : 0);
  if (fragment) {
    const stage = stageRef.value;
    const target = frameRef.value && frameRef.value.contentDocument && frameRef.value.contentDocument.getElementById(fragment);
    if (target && stage) {
      const frameTop = frameRef.value.getBoundingClientRect().top;
      stage.scrollTop += target.getBoundingClientRect().top - frameTop;
    }
  }
  queueSave();
}

function nextChapter() {
  goChapter(view.chapter + 1);
}

function prevChapter() {
  goChapter(view.chapter - 1);
}

function queueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveProgress();
  }, 420);
}

async function saveProgress() {
  const row = active.value;
  if (!row || !book) return;
  const updated = {
    ...row,
    chapterCount: book.chapters.length,
    lastChapter: view.chapter,
    lastProgress: view.progress,
    lastReadAt: Date.now(),
  };
  active.value = updated;
  const shelfRow = books.value.find((item) => item.id === updated.id);
  if (shelfRow) {
    shelfRow.lastChapter = updated.lastChapter;
    shelfRow.lastProgress = updated.lastProgress;
    shelfRow.lastReadAt = updated.lastReadAt;
    shelfRow.chapterCount = updated.chapterCount;
  }
  try {
    // 进度更新必须把书体原样写回，否则会丢正文
    const stored = await readBook(updated.id);
    if (!stored) return;
    await idbPut("epubs", { ...updated, data: stored }, updated.id);
  } catch {}
}

function saveProgressNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return saveProgress();
}

function resumeBook() {
  view.askResume = false;
  saveProgressNow();
}

async function restartBook() {
  view.askResume = false;
  view.chapter = 0;
  view.progress = 0;
  await renderChapter(0, 0);
  saveProgressNow();
}

async function backToDeck() {
  await saveProgressNow();
  goHome();
}

async function closeBook() {
  await saveProgressNow();
  cleanupReader();
  active.value = null;
  view.phase = "idle";
  view.error = null;
  view.askResume = false;
  refresh();
}

/* ---------------- reading controls ---------------- */

function zoomBy(delta) {
  view.zoom = Math.min(2.4, Math.max(0.6, Math.round((view.zoom + delta) * 100) / 100));
}

function fontBy(delta) {
  view.fontScale = Math.min(1.9, Math.max(0.8, Math.round((view.fontScale + delta) * 100) / 100));
}

function cycleTheme() {
  const order = ["paper", "sepia", "night"];
  view.theme = order[(order.indexOf(view.theme) + 1) % order.length];
}

function cycleWidth() {
  const order = ["narrow", "normal", "wide"];
  view.width = order[(order.indexOf(view.width) + 1) % order.length];
}

const frameStyle = computed(() => {
  const widths = { narrow: 620, normal: 720, wide: 900 };
  const themes = {
    paper: { background: "#f6f1e6", color: "#241f18" },
    sepia: { background: "#e8d9bd", color: "#3a2f1d" },
    night: { background: "#14120f", color: "#cdc3b1" },
  };
  const theme = themes[view.theme] || themes.paper;
  return {
    width: widths[view.width] + "px",
    background: theme.background,
    color: theme.color,
    transform: "scale(" + view.zoom + ")",
    "--epub-scale": view.fontScale,
    "--epub-ink": theme.color,
  };
});

/* ---------------- pan + keys ---------------- */

function onPointerDown(event) {
  if (!book || view.askResume || event.button !== 0) return;
  const stage = stageRef.value;
  if (!stage) return;
  drag.active = true;
  drag.x = event.clientX;
  drag.y = event.clientY;
  drag.left = stage.scrollLeft;
  drag.top = stage.scrollTop;
}

function onPointerMove(event) {
  if (!drag.active) return;
  const stage = stageRef.value;
  if (!stage) return;
  stage.scrollLeft = drag.left - (event.clientX - drag.x);
  stage.scrollTop = drag.top - (event.clientY - drag.y);
}

function onPointerUp() {
  drag.active = false;
}

function onWheel(event) {
  if (!hasModifier(event)) return;
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 0.1 : -0.1);
}

function onKey(event) {
  if (!active.value || view.askResume) return;
  const tag = event.target && event.target.tagName ? event.target.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const key = event.key;
  if (key === "ArrowRight" || key === "PageDown") {
    event.preventDefault();
    nextChapter();
  } else if (key === "ArrowLeft" || key === "PageUp") {
    event.preventDefault();
    prevChapter();
  } else if (key === "Home") {
    goChapter(0);
  } else if (key === "End") {
    goChapter(totalChapters.value - 1);
  } else if (key === "Escape") {
    closeBook();
  } else if (key === "t" || key === "T") {
    view.tocOpen = !view.tocOpen;
  } else if (key === "=" || key === "+") {
    fontBy(0.1);
  } else if (key === "-") {
    fontBy(-0.1);
  } else if (key === "0") {
    view.zoom = 1;
    view.fontScale = 1;
  }
}

/* ---------------- lifecycle ---------------- */

function onVisibility() {
  if (document.visibilityState === "hidden") saveProgressNow();
}

function onFrameLoad() {
  const frame = frameRef.value;
  if (!frame) return;
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    // 章节内链接：同书内跳转直接翻章，外链交给系统浏览器
    doc.addEventListener("click", (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest("a") : null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (!href || /^(https?:|mailto:|tel:)/i.test(href)) {
        if (href) window.open(href, "_blank", "noreferrer");
        event.preventDefault();
        return;
      }
      const parts = href.split("#");
      const file = parts[0];
      const fragment = parts[1] || "";
      event.preventDefault();
      if (!file) {
        goChapter(view.chapter, fragment);
        return;
      }
      const base = book && book.chapters[view.chapter] ? book.chapters[view.chapter].path : "";
      const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
      const resolved = normalizeRelative(dir ? dir + "/" + file : file);
      const target = book ? book.chapters.findIndex((chapter) => chapter.path === resolved) : -1;
      if (target >= 0) goChapter(target, fragment);
    });
  } catch {
    // 跨源/沙箱环境读不到文档时静默降级
  }
}

function normalizeRelative(path) {
  const out = [];
  for (const part of String(path).split("#")[0].split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

watch(() => [view.zoom, view.fontScale, view.theme, view.width], () => {
  const stage = stageRef.value;
  if (stage) stage.scrollTop = stage.scrollTop;
});

onMounted(() => {
  window.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisibility);
  refresh();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("visibilitychange", onVisibility);
  clearTimeout(deleteTimer);
  saveProgressNow();
  cleanupReader();
});
</script>

<template>
  <div
    class="plugin plugin--epub"
    :style="{ '--accent': ACCENT }"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <header class="pluginbar">
      <button class="pluginbar__back" @click="backToDeck">← {{ t("common.back") }}</button>
      <div class="pluginbar__divider" />
      <div class="pluginbar__brand">
        <div class="pluginbar__mark pluginbar__mark--word" style="border-color: #b06ae0; color: #b06ae0">EPUB</div>
        <div>
          <div class="pluginbar__title">{{ t("plugins.epub.name") }}</div>
          <div class="pluginbar__sub">EPUB READER · LOCAL BOOKSHELF</div>
        </div>
      </div>
      <div class="pluginbar__spacer" />
      <div class="epub-stat">
        <span class="eyebrow">{{ t("epub.shelfLabel") }}</span>
        <b>{{ books.length }}</b>
        <span class="eyebrow">{{ formatBytes(shelfBytes) }}</span>
      </div>
      <button class="btn-hazard epub-accent" :disabled="importing" @click="pickFile">
        {{ importing ? t("epub.importing") : t("epub.import") }}
      </button>
    </header>

    <div class="hazard" />

    <section v-if="!active" class="epub-shelf">
      <div class="epub-drop panel panel--cut" :class="{ 'is-hot': dragging }" @click="pickFile">
        <div class="epub-drop__glyph">EPUB</div>
        <div>
          <div class="eyebrow" style="color: #b06ae0">{{ t("epub.dropEyebrow") }}</div>
          <h2 class="epub-drop__title">{{ t("epub.dropTitle") }}</h2>
          <p class="epub-drop__hint">{{ t("epub.dropHint") }}</p>
        </div>
      </div>

      <div class="epub-list-head">
        <div>
          <div class="eyebrow">{{ t("epub.shelfEyebrow") }}</div>
          <h2 class="section-title" style="font-size: 26px">
            {{ t("epub.shelfCountA") }}<em>{{ books.length }}</em>{{ t("epub.shelfCountB") }}
          </h2>
        </div>
        <span class="eyebrow">{{ formatBytes(shelfBytes) }} · IndexedDB</span>
      </div>

      <div v-if="loading" class="empty"><span class="led led--amber"><i />{{ t("epub.loading") }}</span></div>
      <div v-else-if="!books.length" class="empty">
        {{ t("epub.emptyShelf") }}
        <div style="font-size: 12px; margin-top: 8px">{{ t("epub.emptyShelfHint") }}</div>
      </div>
      <div v-else class="epub-grid">
        <article v-for="row in books" :key="row.id" class="epub-card panel">
          <div class="epub-card__cover">
            <img v-if="row.cover" :src="row.cover" alt="" loading="lazy" />
            <span v-else>EPUB</span>
          </div>
          <div class="epub-card__body">
            <div class="epub-card__name" :title="row.title || row.name">{{ row.title || row.name }}</div>
            <div class="epub-card__byline">{{ row.author || t("epub.unknownAuthor") }}</div>
            <div class="epub-card__meta">
              {{ formatBytes(row.size) }} · {{ row.chapterCount || 0 }} {{ t("epub.chaptersUnit") }} ·
              {{ formatDate(row.addedAt, { withTime: true }) }}
            </div>
            <div class="epub-card__progress">
              <span>{{ progressLabel(row) }}</span>
              <i :style="{ width: progressPercent(row) + '%' }"></i>
            </div>
          </div>
          <div class="epub-card__actions">
            <button class="mini-btn is-primary" @click="openBook(row)">
              {{ row.lastReadAt ? t("epub.continue") : t("epub.open") }}
            </button>
            <button class="mini-btn" :class="{ 'is-danger': deleteCandidate === row.id }" @click="askDelete(row)">
              {{ deleteCandidate === row.id ? t("epub.confirmDelete") : t("epub.delete") }}
            </button>
          </div>
        </article>
      </div>

      <input ref="fileInput" type="file" accept="application/epub+zip,.epub" multiple hidden @change="onFileChange" />
      <p class="epub-note">{{ t("epub.shelfNote") }}</p>
    </section>

    <section v-else class="epub-viewer">
      <div class="epub-viewer__bar">
        <button class="btn-ghost" @click="closeBook">← {{ t("epub.backToShelf") }}</button>
        <div class="epub-viewer__name" :title="active.title || active.name">{{ active.title || active.name }}</div>
        <div style="flex: 1" />
        <button class="btn-ghost" :disabled="!canPrev" @click="prevChapter">←</button>
        <span class="epub-chapter-readout">
          {{ view.chapter + 1 }} / {{ totalChapters }}
        </span>
        <button class="btn-ghost" :disabled="!canNext" @click="nextChapter">→</button>
        <div class="epub-viewer__divider" />
        <button class="btn-ghost" :class="{ 'is-active': view.tocOpen }" @click="view.tocOpen = !view.tocOpen">
          {{ t("epub.toc") }}
        </button>
        <button class="btn-ghost" @click="cycleTheme">{{ themeLabel }}</button>
        <button class="btn-ghost" @click="cycleWidth">{{ t("epub.width." + view.width) }}</button>
        <div class="epub-viewer__divider" />
        <button class="btn-ghost" @click="fontBy(-0.1)">A－</button>
        <span class="eyebrow">{{ Math.round(view.fontScale * 100) }}%</span>
        <button class="btn-ghost" @click="fontBy(0.1)">A＋</button>
        <button class="btn-ghost" @click="zoomBy(-0.1)">－</button>
        <span class="eyebrow">{{ Math.round(view.zoom * 100) }}%</span>
        <button class="btn-ghost" @click="zoomBy(0.1)">＋</button>
      </div>

      <div class="epub-stage-wrap">
        <aside v-if="view.tocOpen" class="epub-toc panel">
          <div class="epub-toc__head">
            <span class="eyebrow">{{ t("epub.toc") }}</span>
            <button class="epub-toc__close" @click="view.tocOpen = false">×</button>
          </div>
          <div class="epub-toc__list">
            <button
              v-for="(item, index) in toc"
              :key="item.path + '#' + item.fragment + index"
              class="epub-toc__item"
              :class="{ 'is-active': item.chapter === view.chapter }"
              :style="{ paddingLeft: 12 + item.depth * 14 + 'px' }"
              @click="goChapter(item.chapter, item.fragment)"
            >
              {{ item.label }}
            </button>
          </div>
          <div class="epub-toc__meta">
            <div v-if="active.author">{{ active.author }}</div>
            <div v-if="active.publisher">{{ active.publisher }}</div>
            <div v-if="active.language">{{ active.language }}</div>
            <div>{{ t("epub.chapterNow") }} {{ view.chapter + 1 }} / {{ totalChapters }}</div>
          </div>
        </aside>

        <div
          ref="stageRef"
          class="epub-stage"
          :class="{ 'is-panning': drag.active }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @wheel="onWheel"
        >
          <div class="epub-page" :style="frameStyle">
            <iframe
              ref="frameRef"
              class="epub-frame"
              sandbox="allow-same-origin"
              referrerpolicy="no-referrer"
              title="epub chapter"
              @load="onFrameLoad"
            ></iframe>
          </div>
        </div>

        <div v-if="view.phase === 'opening'" class="epub-overlay">
          <div class="led led--amber"><i />{{ t("epub.opening") }}</div>
        </div>
        <div v-else-if="view.phase === 'error'" class="epub-overlay epub-overlay--error">
          <div>⚠ {{ view.error }}</div>
          <button class="btn-ghost" @click="closeBook">{{ t("epub.backToShelf") }}</button>
        </div>
        <div v-else-if="view.askResume" class="epub-overlay epub-overlay--resume">
          <div class="panel panel--cut" style="padding: 24px; max-width: 440px">
            <div class="eyebrow" style="margin-bottom: 10px">{{ t("epub.resumeEyebrow") }}</div>
            <div style="font-size: 15px; color: var(--bone)">
              {{ t("epub.resumeTextA") }}<b style="color: #b06ae0">{{ view.resumeChapter + 1 }}</b>{{ t("epub.resumeTextB") }}
            </div>
            <p style="font-size: 12px; line-height: 1.9; color: var(--muted); margin: 10px 0 0">
              {{ t("epub.resumeHint") }}
            </p>
            <div class="hazard" style="margin: 18px 0"></div>
            <div style="display: flex; gap: 10px; justify-content: flex-end">
              <button class="btn-ghost" @click="restartBook">{{ t("epub.restart") }}</button>
              <button class="btn-hazard epub-accent" @click="resumeBook">{{ t("epub.resume") }}</button>
            </div>
          </div>
        </div>
      </div>

      <footer class="epub-viewer__foot">
        <span class="epub-foot__chapter" :title="chapterName || view.loadedName">
          {{ t("epub.chapterNow") }} {{ view.chapter + 1 }}<template v-if="chapterName"> · {{ chapterName }}</template>
        </span>
        <span>{{ t("epub.shortcuts") }}</span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.plugin--epub { flex: 1; display: flex; flex-direction: column; min-height: calc(100vh - 70px); }
.epub-stat { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--bone-dim); }
.epub-stat b { color: #b06ae0; font-size: 18px; }
.btn-hazard.epub-accent { background: #b06ae0; border-color: #b06ae0; color: #140f1a; }
.btn-hazard.epub-accent:hover { background: #c489ec; box-shadow: 0 0 26px -8px #b06ae0; }

.epub-shelf { width: 100%; max-width: 1180px; margin: 0 auto; padding: 26px 26px 70px; }

.epub-drop {
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 26px 28px;
  cursor: pointer;
  border-style: dashed;
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
}
.epub-drop:hover,
.epub-drop.is-hot {
  border-color: #b06ae0;
  background: linear-gradient(120deg, rgba(176, 106, 224, 0.14), transparent 62%), var(--panel);
  transform: translateY(-2px);
}
.epub-drop__glyph {
  flex: 0 0 auto;
  width: 86px;
  height: 108px;
  display: grid;
  place-items: center;
  border: 1px solid #b06ae0;
  color: #b06ae0;
  font-family: var(--display);
  font-size: 21px;
  letter-spacing: 0.08em;
  background: linear-gradient(155deg, rgba(176, 106, 224, 0.2), transparent);
  clip-path: polygon(0 0, 100% 0, 100% 78%, 78% 100%, 0 100%);
}
.epub-drop__title { margin: 6px 0 0; font-family: var(--display); font-size: 24px; letter-spacing: 0.04em; color: var(--bone); }
.epub-drop__hint { margin: 8px 0 0; font-size: 12.5px; line-height: 1.8; color: var(--muted); max-width: 680px; }

.epub-list-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin: 30px 0 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line-soft);
}
.epub-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.epub-card {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  gap: 12px;
  padding: 14px;
  border-color: var(--line-soft);
}
.epub-card__cover {
  width: 62px;
  height: 86px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--line);
  background: #0f0c09;
  color: #b06ae0;
  font-family: var(--display);
  font-size: 15px;
  letter-spacing: 0.06em;
}
.epub-card__cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.epub-card__body { min-width: 0; align-self: center; }
.epub-card__name {
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--bone);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.epub-card__byline { margin-top: 4px; font-size: 11.5px; color: #b06ae0; letter-spacing: 0.04em; }
.epub-card__meta { margin-top: 6px; font-size: 11px; letter-spacing: 0.05em; color: var(--muted); }
.epub-card__progress {
  position: relative;
  margin-top: 9px;
  height: 16px;
  border-bottom: 2px solid #2a241b;
  font-size: 10.5px;
  color: #b06ae0;
  letter-spacing: 0.05em;
}
.epub-card__progress i {
  position: absolute;
  left: 0;
  bottom: -2px;
  height: 2px;
  background: #b06ae0;
  box-shadow: 0 0 8px -2px #b06ae0;
}
.epub-card__actions { grid-column: 1 / -1; display: flex; gap: 6px; }
.mini-btn.is-danger { border-color: var(--danger); color: var(--danger); }
.epub-note { margin-top: 26px; font-size: 11px; line-height: 1.8; letter-spacing: 0.06em; color: var(--muted); }

.epub-viewer { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 14px 18px 0; }
.epub-viewer__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 0 12px;
  border-bottom: 1px solid var(--line-soft);
  margin-bottom: 12px;
}
.epub-viewer__name {
  font-size: 13px;
  color: var(--bone);
  max-width: 30vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.epub-viewer__divider { width: 1px; height: 22px; background: var(--line); margin: 0 4px; }
.epub-chapter-readout { font-size: 12px; color: var(--muted); letter-spacing: 0.08em; min-width: 58px; text-align: center; }

.epub-stage-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
.epub-stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 22px;
  background:
    radial-gradient(60% 50% at 50% 0%, rgba(176, 106, 224, 0.06), transparent 62%),
    #16130f;
  border: 1px solid var(--line);
  cursor: grab;
}
.epub-stage.is-panning { cursor: grabbing; }
.epub-page {
  flex: 0 0 auto;
  margin: 0 auto;
  transform-origin: top center;
  padding: 26px 30px;
  box-shadow: 0 30px 80px -46px #000;
}
.epub-frame { width: 100%; height: 72vh; border: 0; display: block; background: transparent; }

.epub-toc {
  flex: 0 0 268px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-right: 12px;
  padding: 12px 10px;
  background: #0f0d0a;
}
.epub-toc__head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 8px; border-bottom: 1px solid var(--line-soft); }
.epub-toc__close { width: 24px; height: 24px; border: 1px solid var(--line-soft); background: transparent; color: var(--muted); font-size: 16px; line-height: 1; cursor: pointer; }
.epub-toc__close:hover { border-color: #b06ae0; color: #b06ae0; }
.epub-toc__list { flex: 1; min-height: 0; overflow: auto; padding: 8px 0; }
.epub-toc__item {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--bone-dim);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  padding: 6px 10px 6px 12px;
  cursor: pointer;
}
.epub-toc__item:hover { background: rgba(176, 106, 224, 0.09); color: var(--bone); }
.epub-toc__item.is-active { border-left-color: #b06ae0; color: #b06ae0; background: rgba(176, 106, 224, 0.12); }
.epub-toc__meta { border-top: 1px solid var(--line-soft); padding: 8px 4px 0; font-size: 10.5px; line-height: 1.9; letter-spacing: 0.06em; color: var(--muted); }

.epub-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 7, 5, 0.72);
  z-index: 3;
}
.epub-overlay--error { flex-direction: column; gap: 14px; color: #e9c2f5; font-size: 13px; }
.epub-overlay--resume { background: rgba(8, 7, 5, 0.6); }
.epub-viewer__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 8px 2px 12px;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.epub-foot__chapter { max-width: 46vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bone-dim); }

@media (max-width: 860px) {
  .epub-viewer__name { max-width: 50vw; }
  .epub-stage-wrap { flex-direction: column; }
  .epub-toc { flex: 0 0 auto; max-height: 34vh; margin: 0 0 10px; }
  .epub-stage { padding: 12px; }
  .epub-page { padding: 16px; }
  .epub-frame { height: 60vh; }
}
</style>
