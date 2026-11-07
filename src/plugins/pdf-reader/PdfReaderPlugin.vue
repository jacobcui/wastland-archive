<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { idbDelete, idbGetAll, idbPut } from "@/lib/idb";
import { formatBytes, formatDate } from "@/lib/format";
import { goHome } from "@/lib/navigation";
import { hasModifier, modKeyLabel, platformLabel } from "@/lib/platform";
import { notify } from "@/stores/ui";
import { t } from "@/i18n";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const docs = ref([]);
const loading = ref(true);
const importing = ref(false);
const dragging = ref(false);
const active = ref(null);
const deleteCandidate = ref(null);
const fileInput = ref(null);
const canvasRef = ref(null);
const stageRef = ref(null);

const pdf = reactive({
  loading: false,
  rendering: false,
  error: null,
  page: 1,
  pageCount: 0,
  zoom: 1,
  fit: "page",
  scalePercent: 100,
  askResume: false,
  resumePage: 1,
});

const panDrag = reactive({ active: false, startX: 0, startY: 0, left: 0, top: 0 });

let deleteTimer = null;
let saveTimer = null;
let renderTimer = null;
let renderTask = null;
let pdfDoc = null;
let observer = null;

const totalBytes = computed(() => docs.value.reduce((sum, doc) => sum + (doc.size || 0), 0));
const canPrev = computed(() => pdf.page > 1);
const canNext = computed(() => pdf.page < pdf.pageCount);
const pageLabel = computed(() => String(pdf.page).padStart(2, "0"));
const pageCountLabel = computed(() => String(pdf.pageCount).padStart(2, "0"));

function uid() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return "pdf-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function progressLabel(doc) {
  if (!doc.pageCount) return "未打开";
  if (doc.lastPage && doc.lastPage > 1) return "读至 " + doc.lastPage + " / " + doc.pageCount + " 页";
  return doc.pageCount + " 页 · 未读";
}

function progressPercent(doc) {
  if (!doc.pageCount || !doc.lastPage) return 0;
  return Math.min(100, Math.round((doc.lastPage / doc.pageCount) * 100));
}

async function refresh() {
  loading.value = true;
  try {
    const rows = await idbGetAll("pdfs");
    docs.value = rows.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
  } catch (error) {
    notify("PDF 档案柜不可用: " + error.message, "error");
  } finally {
    loading.value = false;
  }
}

async function importFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
  if (!files.length) {
    notify("没有发现 PDF 文件", "info");
    return;
  }
  importing.value = true;
  let added = 0;
  try {
    for (const file of files) {
      const data = await file.arrayBuffer();
      await idbPut(
        "pdfs",
        {
          id: uid(),
          name: file.name,
          size: file.size,
          type: file.type || "application/pdf",
          addedAt: Date.now(),
          lastPage: 0,
          pageCount: 0,
          lastReadAt: 0,
          data,
        },
      );
      added += 1;
    }
    await refresh();
    notify("已导入 " + added + " 份 PDF", "success");
  } catch (error) {
    notify("导入失败: " + error.message, "error");
  } finally {
    importing.value = false;
  }
}

function pickFile() {
  if (fileInput.value) fileInput.value.click();
}

function onFileChange(event) {
  importFiles(event.target.files);
  event.target.value = "";
}

function onDrop(event) {
  dragging.value = false;
  importFiles(event.dataTransfer && event.dataTransfer.files);
}

function cleanupPdf() {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {}
    renderTask = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (stageRef.value) stageRef.value.removeEventListener("wheel", onWheel);
  if (pdfDoc) {
    const doc = pdfDoc;
    pdfDoc = null;
    doc.destroy().catch(() => {});
  }
}

async function openDoc(row) {
  if (!row || (!row.data && !row.blob)) return;
  cleanupPdf();
  active.value = row;
  pdf.loading = true;
  pdf.rendering = false;
  pdf.error = null;
  pdf.page = 1;
  pdf.pageCount = row.pageCount || 0;
  pdf.zoom = 1;
  pdf.fit = "page";
  pdf.scalePercent = 100;
  pdf.askResume = false;
  pdf.resumePage = 1;
  try {
    let buffer = row.data || null;
    if (!buffer && row.blob) buffer = await row.blob.arrayBuffer();
    if (!buffer) throw new Error("PDF 数据缺失");
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(buffer).slice(),
      cMapUrl: "/vendor/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    });
    pdfDoc = await task.promise;
    pdf.pageCount = pdfDoc.numPages;
    const saved = Math.min(pdf.pageCount, Math.max(1, Number(row.lastPage) || 1));
    pdf.resumePage = saved;
    pdf.page = saved;
    pdf.askResume = saved > 1;
    await nextTick();
    attachStage();
    await renderPage();
  } catch (error) {
    pdf.error = "PDF 打开失败: " + error.message;
  } finally {
    pdf.loading = false;
  }
}

function attachStage() {
  if (!stageRef.value) return;
  stageRef.value.addEventListener("wheel", onWheel, { passive: false });
  observer = new ResizeObserver(() => scheduleRender());
  observer.observe(stageRef.value);
}

function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderPage();
  }, 80);
}

async function renderPage() {
  if (!pdfDoc || !active.value) return;
  const canvas = canvasRef.value;
  if (!canvas) return;
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {}
    renderTask = null;
  }
  try {
    const page = await pdfDoc.getPage(Math.min(Math.max(1, pdf.page), pdf.pageCount || 1));
    const base = page.getViewport({ scale: 1 });
    const stage = stageRef.value;
    const availW = Math.max(240, (stage ? stage.clientWidth : 900) - 44);
    const availH = Math.max(240, (stage ? stage.clientHeight : 700) - 44);
    const fitPage = Math.min(availW / base.width, availH / base.height);
    let fitScale = fitPage;
    if (pdf.fit === "width") fitScale = availW / base.width;
    else if (pdf.fit === "height") fitScale = availH / base.height;
    const scale = Math.max(0.15, fitScale * pdf.zoom);
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = Math.floor(viewport.width) + "px";
    canvas.style.height = Math.floor(viewport.height) + "px";
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    pdf.rendering = true;
    const task = page.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
    renderTask = task;
    await task.promise;
    if (renderTask === task) renderTask = null;
    pdf.scalePercent = Math.round(scale * 100);
  } catch (error) {
    if (!/cancel/i.test(String(error && error.message))) {
      pdf.error = "PDF 渲染失败: " + (error && error.message ? error.message : "未知错误");
    }
  } finally {
    pdf.rendering = false;
  }
}

function goPage(page) {
  if (!pdf.pageCount) return;
  const next = Math.min(Math.max(1, page), pdf.pageCount);
  if (next === pdf.page) return;
  pdf.page = next;
  pdf.askResume = false;
  queueSave();
  renderPage();
}

function nextPage() {
  goPage(pdf.page + 1);
}

function prevPage() {
  goPage(pdf.page - 1);
}

function onPageInput(event) {
  goPage(Number(event.target.value) || 1);
}

function queueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveProgress();
  }, 350);
}

async function saveProgress() {
  const doc = active.value;
  if (!doc || !pdf.pageCount) return;
  const updated = {
    ...doc,
    pageCount: pdf.pageCount,
    lastPage: pdf.page,
    lastReadAt: Date.now(),
  };
  active.value = updated;
  const row = docs.value.find((item) => item.id === updated.id);
  if (row) {
    row.pageCount = updated.pageCount;
    row.lastPage = updated.lastPage;
    row.lastReadAt = updated.lastReadAt;
  }
  try {
    await idbPut("pdfs", updated, updated.id);
  } catch {}
}

function saveProgressNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return saveProgress();
}

function resumePdf() {
  pdf.askResume = false;
  saveProgressNow();
}

function restartPdf() {
  pdf.askResume = false;
  pdf.page = 1;
  renderPage();
  saveProgressNow();
}

async function backToDeck() {
  await saveProgressNow();
  goHome();
}

async function closeViewer() {
  await saveProgressNow();
  cleanupPdf();
  active.value = null;
  pdf.askResume = false;
  pdf.loading = false;
  pdf.rendering = false;
  pdf.error = null;
  refresh();
}

function zoomBy(delta) {
  pdf.zoom = Math.min(4, Math.max(0.5, Math.round((pdf.zoom + delta) * 100) / 100));
}

function setFit(mode) {
  pdf.fit = mode;
  pdf.zoom = 1;
}

function onWheel(event) {
  if (!hasModifier(event)) return;
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 0.12 : -0.12);
}

function onPointerDown(event) {
  if (!active.value || pdf.askResume) return;
  if (event.button !== 0) return;
  const stage = stageRef.value;
  if (!stage) return;
  panDrag.active = true;
  panDrag.startX = event.clientX;
  panDrag.startY = event.clientY;
  panDrag.left = stage.scrollLeft;
  panDrag.top = stage.scrollTop;
  stage.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  if (!panDrag.active) return;
  const stage = stageRef.value;
  if (!stage) return;
  stage.scrollLeft = panDrag.left - (event.clientX - panDrag.startX);
  stage.scrollTop = panDrag.top - (event.clientY - panDrag.startY);
}

function onPointerUp() {
  panDrag.active = false;
}

function onKey(event) {
  if (!active.value || pdf.askResume) return;
  const tag = event.target && event.target.tagName ? event.target.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const key = event.key;
  if (key === "ArrowRight" || key === "PageDown" || key === " ") {
    event.preventDefault();
    nextPage();
  } else if (key === "ArrowLeft" || key === "PageUp") {
    event.preventDefault();
    prevPage();
  } else if (key === "Home") {
    goPage(1);
  } else if (key === "End") {
    goPage(pdf.pageCount);
  } else if (key === "Escape") {
    closeViewer();
  } else if (key === "=" || key === "+") {
    zoomBy(0.15);
  } else if (key === "-") {
    zoomBy(-0.15);
  } else if (key === "0") {
    setFit("page");
  }
}

watch([() => pdf.zoom, () => pdf.fit], () => scheduleRender());

function askDelete(doc) {
  if (deleteCandidate.value === doc.id) {
    removeDoc(doc);
    return;
  }
  deleteCandidate.value = doc.id;
  clearTimeout(deleteTimer);
  deleteTimer = setTimeout(() => {
    deleteCandidate.value = null;
  }, 3200);
}

async function removeDoc(doc) {
  deleteCandidate.value = null;
  clearTimeout(deleteTimer);
  try {
    await idbDelete("pdfs", doc.id);
    await refresh();
    notify("已从档案柜删除 · " + doc.name, "info");
  } catch (error) {
    notify("删除失败: " + error.message, "error");
  }
}

function onVisibility() {
  if (document.visibilityState === "hidden") saveProgressNow();
}

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
  cleanupPdf();
});
</script>

<template>
  <div
    class="plugin plugin--pdf"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <header class="pluginbar">
      <button class="pluginbar__back" @click="backToDeck">← {{ t("common.back") }}</button>
      <div class="pluginbar__divider" />
      <div class="pluginbar__brand">
        <div class="pluginbar__mark" style="border-color: var(--rust); color: var(--rust)">PDF</div>
        <div>
          <div class="pluginbar__title">{{ t("plugins.pdf.name") }}</div>
          <div class="pluginbar__sub">PDF READER · LOCAL BROWSER SHELF</div>
        </div>
      </div>
      <div class="pluginbar__spacer" />
      <div class="pdf-stat">
        <span class="eyebrow">SHELF</span>
        <b>{{ docs.length }}</b>
        <span class="eyebrow">{{ formatBytes(totalBytes) }}</span>
      </div>
      <button class="btn-hazard" :disabled="importing" @click="pickFile">{{ importing ? "导入中…" : "导入 PDF" }}</button>
    </header>

    <div class="hazard" />

    <section v-if="!active" class="pdf-shelf">
      <div class="pdf-drop panel panel--cut" :class="{ 'is-hot': dragging }" @click="pickFile">
        <div class="pdf-drop__glyph">PDF</div>
        <div>
          <div class="eyebrow" style="color: var(--amber)">DROP ZONE · 导入本地 PDF</div>
          <h2 class="pdf-drop__title">把 PDF 拖进来，或点击选择文件</h2>
          <p class="pdf-drop__hint">
            文件会存进本浏览器的 IndexedDB，之后即使断网也能从这台机器重新翻开。不会上传到任何服务器。
          </p>
        </div>
      </div>

      <div class="pdf-list-head">
        <div>
          <div class="eyebrow">BROWSER SHELF · 本机 PDF 档案柜</div>
          <h2 class="section-title" style="font-size: 26px">已导入 <em>{{ docs.length }}</em> 份</h2>
        </div>
        <span class="eyebrow">{{ formatBytes(totalBytes) }} · IndexedDB</span>
      </div>

      <div v-if="loading" class="empty"><span class="led led--amber"><i />读取本机档案柜 …</span></div>
      <div v-else-if="!docs.length" class="empty">
        NO PDF IN THIS SHELF
        <div style="font-size: 12px; margin-top: 8px">导入一份 PDF，废土馆藏会替你记住它。</div>
      </div>
      <div v-else class="pdf-grid">
        <article v-for="doc in docs" :key="doc.id" class="pdf-card panel">
          <div class="pdf-card__icon">PDF</div>
          <div class="pdf-card__body">
            <div class="pdf-card__name" :title="doc.name">{{ doc.name }}</div>
            <div class="pdf-card__meta">{{ formatBytes(doc.size) }} · {{ formatDate(doc.addedAt, { withTime: true }) }}</div>
            <div class="pdf-card__progress">
              <span>{{ progressLabel(doc) }}</span>
              <i :style="{ width: progressPercent(doc) + '%' }"></i>
            </div>
          </div>
          <div class="pdf-card__actions">
            <button class="mini-btn is-primary" @click="openDoc(doc)">{{ doc.lastPage > 1 ? "继续" : "翻开" }}</button>
            <button class="mini-btn" :class="{ 'is-danger': deleteCandidate === doc.id }" @click="askDelete(doc)">
              {{ deleteCandidate === doc.id ? "确认删除" : "删除" }}
            </button>
          </div>
        </article>
      </div>

      <input ref="fileInput" type="file" accept="application/pdf,.pdf" multiple hidden @change="onFileChange" />
      <p class="pdf-note">PDF 会记住上次读到的页码；再次打开时可以选择继续或从头开始。</p>
    </section>

    <section v-else class="pdf-viewer">
      <div class="pdf-viewer__bar">
        <button class="btn-ghost" @click="closeViewer">← 返回书架</button>
        <div class="pdf-viewer__name" :title="active.name">{{ active.name }}</div>
        <div style="flex: 1" />
        <button class="btn-ghost" :disabled="!canPrev" @click="prevPage">←</button>
        <span class="pdf-page-readout">
          <input class="pdf-page-input" type="number" :min="1" :max="pdf.pageCount" :value="pdf.page" @change="onPageInput" />
          / {{ pageCountLabel }}
        </span>
        <button class="btn-ghost" :disabled="!canNext" @click="nextPage">→</button>
        <div class="pdf-viewer__divider" />
        <button class="btn-ghost" @click="zoomBy(-0.15)">－</button>
        <span class="eyebrow">{{ pdf.scalePercent }}%</span>
        <button class="btn-ghost" @click="zoomBy(0.15)">＋</button>
        <button class="btn-ghost" :class="{ 'is-active': pdf.fit === 'page' }" @click="setFit('page')">适应页</button>
        <button class="btn-ghost" :class="{ 'is-active': pdf.fit === 'width' }" @click="setFit('width')">适应宽</button>
      </div>

      <div class="pdf-stage-wrap">
        <div
          ref="stageRef"
          class="pdf-stage"
          :class="{ 'is-panning': panDrag.active }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <canvas ref="canvasRef" class="pdf-canvas"></canvas>
        </div>

        <div v-if="pdf.loading" class="pdf-overlay">
          <div class="led led--amber"><i />正在解析 PDF …</div>
        </div>
        <div v-else-if="pdf.error" class="pdf-overlay pdf-overlay--error">
          <div>⚠ {{ pdf.error }}</div>
          <button class="btn-ghost" @click="closeViewer">返回书架</button>
        </div>
        <div v-else-if="pdf.askResume" class="pdf-overlay pdf-overlay--resume">
          <div class="panel panel--cut" style="padding: 24px; max-width: 440px">
            <div class="eyebrow" style="margin-bottom: 10px">RESUME PDF · 阅读进度</div>
            <div style="font-size: 15px; color: var(--bone)">
              上次读到第 <b style="color: var(--amber)">{{ pdf.resumePage }}</b> 页 / 共 {{ pdf.pageCount }} 页
            </div>
            <p style="font-size: 12px; line-height: 1.9; color: var(--muted); margin: 10px 0 0">
              要从上次停下的位置继续，还是从第一页重新开始？
            </p>
            <div class="hazard" style="margin: 18px 0"></div>
            <div style="display: flex; gap: 10px; justify-content: flex-end">
              <button class="btn-ghost" @click="restartPdf">从头开始</button>
              <button class="btn-hazard" @click="resumePdf">继续阅读</button>
            </div>
          </div>
        </div>
      </div>

      <footer class="pdf-viewer__foot">
        <span>第 {{ pageLabel }} / {{ pageCountLabel }} 页 · {{ platformLabel }} 快捷键</span>
        <span>←/→ 翻页 · <kbd class="keycap">{{ modKeyLabel }}</kbd> + 滚轮 缩放 · 拖动平移</span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.plugin--pdf { flex: 1; display: flex; flex-direction: column; min-height: calc(100vh - 70px); }
.pdf-stat { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--bone-dim); }
.pdf-stat b { color: var(--rust); font-size: 18px; }

.pdf-shelf { width: 100%; max-width: 1180px; margin: 0 auto; padding: 26px 26px 70px; }

.pdf-drop {
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 26px 28px;
  cursor: pointer;
  border-style: dashed;
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
}
.pdf-drop:hover,
.pdf-drop.is-hot {
  border-color: var(--rust);
  background: linear-gradient(120deg, rgba(194, 84, 42, 0.14), transparent 62%), var(--panel);
  transform: translateY(-2px);
}
.pdf-drop__glyph {
  flex: 0 0 auto;
  width: 86px;
  height: 108px;
  display: grid;
  place-items: center;
  border: 1px solid var(--rust);
  color: var(--rust);
  font-family: var(--display);
  font-size: 25px;
  letter-spacing: 0.08em;
  background: linear-gradient(155deg, rgba(194, 84, 42, 0.2), transparent);
  clip-path: polygon(0 0, 100% 0, 100% 78%, 78% 100%, 0 100%);
}
.pdf-drop__title { margin: 6px 0 0; font-family: var(--display); font-size: 24px; letter-spacing: 0.04em; color: var(--bone); }
.pdf-drop__hint { margin: 8px 0 0; font-size: 12.5px; line-height: 1.8; color: var(--muted); max-width: 680px; }

.pdf-list-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin: 30px 0 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line-soft);
}
.pdf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 14px; }
.pdf-card {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  gap: 12px;
  padding: 14px;
  border-color: var(--line-soft);
}
.pdf-card__icon {
  width: 58px;
  height: 74px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  background: #0f0c09;
  color: var(--rust);
  font-family: var(--display);
  font-size: 19px;
  letter-spacing: 0.06em;
}
.pdf-card__body { min-width: 0; align-self: center; }
.pdf-card__name {
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--bone);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-card__meta { margin-top: 6px; font-size: 11px; letter-spacing: 0.05em; color: var(--muted); }
.pdf-card__progress {
  position: relative;
  margin-top: 9px;
  height: 16px;
  border-bottom: 2px solid #2a241b;
  font-size: 10.5px;
  color: var(--rust);
  letter-spacing: 0.05em;
}
.pdf-card__progress i {
  position: absolute;
  left: 0;
  bottom: -2px;
  height: 2px;
  background: var(--rust);
  box-shadow: 0 0 8px -2px var(--rust);
}
.pdf-card__actions { grid-column: 1 / -1; display: flex; gap: 6px; }
.mini-btn.is-danger { border-color: var(--danger); color: var(--danger); }
.pdf-note { margin-top: 26px; font-size: 11px; line-height: 1.8; letter-spacing: 0.06em; color: var(--muted); }

.pdf-viewer { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 14px 18px 0; }
.pdf-viewer__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 0 12px;
  border-bottom: 1px solid var(--line-soft);
  margin-bottom: 12px;
}
.pdf-viewer__name {
  font-size: 13px;
  color: var(--bone);
  max-width: 36vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-viewer__divider { width: 1px; height: 22px; background: var(--line); margin: 0 4px; }
.pdf-page-readout { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); letter-spacing: 0.06em; }
.pdf-page-input {
  width: 46px;
  border: 1px solid var(--line);
  background: #0e0c09;
  color: var(--bone);
  font-family: var(--mono);
  font-size: 12px;
  padding: 5px 4px;
  text-align: center;
  outline: none;
}
.pdf-page-input:focus { border-color: var(--rust); }

.pdf-stage-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
.pdf-stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 18px;
  background:
    radial-gradient(60% 50% at 50% 0%, rgba(194, 84, 42, 0.06), transparent 62%),
    #16130f;
  border: 1px solid var(--line);
  cursor: grab;
}
.pdf-stage.is-panning { cursor: grabbing; }
.pdf-canvas { background: #fff; box-shadow: 0 30px 80px -46px #000; display: block; flex: 0 0 auto; margin: auto; }

.pdf-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 7, 5, 0.72);
  z-index: 3;
}
.pdf-overlay--error { flex-direction: column; gap: 14px; color: #f0b3a8; font-size: 13px; }
.pdf-overlay--resume { background: rgba(8, 7, 5, 0.6); }
.pdf-viewer__foot {
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
.keycap {
  display: inline-block;
  min-width: 18px;
  padding: 1px 5px;
  border: 1px solid rgba(255, 176, 0, 0.45);
  background: rgba(255, 176, 0, 0.08);
  color: var(--amber);
  font-family: var(--mono);
  font-size: 10px;
  line-height: 1.4;
  text-align: center;
  letter-spacing: 0;
}

@media (max-width: 720px) {
  .pdf-viewer__name { max-width: 55vw; }
  .pdf-drop { flex-direction: column; align-items: flex-start; }
  .pdf-stage { padding: 10px; }
}
</style>
