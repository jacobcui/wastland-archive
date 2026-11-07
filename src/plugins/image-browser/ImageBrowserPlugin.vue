<script setup>
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, toRaw } from "vue";
import { idbDelete, idbGet, idbGetAll, idbPut } from "@/lib/idb";
import { formatBytes } from "@/lib/format";
import { goHome } from "@/lib/navigation";
import { notify } from "@/stores/ui";
import { t } from "@/i18n";

const images = ref([]);
const folderLabel = ref("");
const sortOrder = ref("name-asc");
const loading = ref(true);
const dragging = ref(false);
const persistedFolders = ref([]);
const sessionFolders = ref([]);
const activeFolderId = ref(null);
const removeCandidate = ref(null);
const fileInput = ref(null);
const dirInput = ref(null);
const viewer = reactive({ open: false, index: 0, zoom: 1 });

const canPickDirectory = typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
let objectUrls = [];
let removeTimer = null;

const allFolders = computed(() => [...sessionFolders.value, ...persistedFolders.value]);
const sortedImages = computed(() => {
  const rows = [...images.value];
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), "zh-CN", { numeric: true, sensitivity: "base" });
  if (sortOrder.value.startsWith("date")) {
    rows.sort((a, b) => (Number(a.lastModified) || 0) - (Number(b.lastModified) || 0) || byName(a, b));
    if (sortOrder.value === "date-desc") rows.reverse();
  } else {
    rows.sort(byName);
    if (sortOrder.value === "name-desc") rows.reverse();
  }
  return rows;
});
const current = computed(() => (viewer.open ? sortedImages.value[viewer.index] || null : null));
const totalBytes = computed(() => images.value.reduce((sum, image) => sum + (image.size || 0), 0));

function uid(prefix) {
  if (window.crypto && window.crypto.randomUUID) return prefix + "-" + window.crypto.randomUUID();
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name || "");
}

function compareFolders(a, b) {
  return (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0);
}

function sortFolderLists() {
  persistedFolders.value.sort(compareFolders);
  sessionFolders.value.sort(compareFolders);
}

function revokeAll() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
}

function clearImages({ keepActive = false } = {}) {
  viewer.open = false;
  viewer.index = 0;
  viewer.zoom = 1;
  revokeAll();
  images.value = [];
  folderLabel.value = "";
  if (!keepActive) activeFolderId.value = null;
}

function normalizeEntries(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (!entry) continue;
    const file = entry.file || entry;
    if (!isImageFile(file)) continue;
    const path = entry.path || file.webkitRelativePath || file.name;
    out.push({ file, path });
  }
  return out;
}

function showFiles(entries, label, folderId) {
  const accepted = normalizeEntries(entries);
  if (!accepted.length) return 0;
  clearImages({ keepActive: true });
  images.value = accepted.map(({ file, path }) => ({
    name: path,
    label: file.name,
    size: file.size,
    type: file.type,
    lastModified: Number(file.lastModified) || 0,
    url: URL.createObjectURL(file),
  }));
  objectUrls = images.value.map((image) => image.url);
  folderLabel.value = label || "本地图片";
  activeFolderId.value = folderId || null;
  return images.value.length;
}

async function saveFolder(entry) {
  try {
    await idbPut("imageFolders", toRaw(entry), entry.id);
  } catch (error) {
    notify("目录授权保存失败: " + error.message, "error");
  }
}

async function collectDirectory(handle) {
  const out = [];
  async function walk(dir, prefix, depth) {
    for await (const entry of dir.values()) {
      if (entry.kind === "file") {
        const file = await entry.getFile();
        if (isImageFile(file)) out.push({ file, path: prefix + file.name });
      } else if (entry.kind === "directory" && depth < 3) {
        await walk(entry, prefix + entry.name + "/", depth + 1);
      }
    }
  }
  await walk(handle, "", 0);
  return out;
}

async function activateFolder(entry, { silent = false } = {}) {
  if (!entry) return;
  if (entry.session) {
    const entries = (entry.files || []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    const count = showFiles(entries, entry.name, entry.id);
    if (!count) {
      clearImages({ keepActive: true });
      activeFolderId.value = entry.id;
      folderLabel.value = entry.name;
      if (!silent) notify("这个目录里没有图片", "info");
    }
    entry.lastCount = count;
    entry.lastOpenedAt = Date.now();
    sortFolderLists();
    return;
  }

  loading.value = true;
  try {
    let permission = "granted";
    if (typeof entry.handle.queryPermission === "function") permission = await entry.handle.queryPermission({ mode: "read" });
    if (permission !== "granted" && typeof entry.handle.requestPermission === "function") {
      permission = await entry.handle.requestPermission({ mode: "read" });
    }
    if (permission !== "granted") {
      if (!silent) notify("文件夹读取权限未授予", "info");
      return;
    }
    const entries = await collectDirectory(entry.handle);
    const count = showFiles(entries, entry.name, entry.id);
    if (!count) {
      clearImages({ keepActive: true });
      activeFolderId.value = entry.id;
      folderLabel.value = entry.name;
      if (!silent) notify("这个目录里没有图片", "info");
    }
    entry.lastCount = count;
    entry.lastOpenedAt = Date.now();
    await saveFolder(entry);
    sortFolderLists();
  } catch (error) {
    if (!silent) notify("无法读取文件夹: " + error.message, "error");
  } finally {
    loading.value = false;
  }
}

async function addDirectory() {
  if (!canPickDirectory) {
    if (dirInput.value) dirInput.value.click();
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "read" });
    const entry = {
      id: uid("dir"),
      name: handle.name || "本地文件夹",
      handle: markRaw(handle),
      addedAt: Date.now(),
      lastOpenedAt: 0,
      lastCount: null,
    };
    persistedFolders.value.unshift(entry);
    await saveFolder(entry);
    await activateFolder(entry);
  } catch (error) {
    if (error && error.name === "AbortError") return;
    notify("系统不允许授权该目录，改用文件选择器读取（非图片文件会自动忽略）", "info");
    if (dirInput.value) dirInput.value.click();
  }
}

function pickFolder() {
  if (canPickDirectory) addDirectory();
  else if (dirInput.value) dirInput.value.click();
}

function pickFolderFallback() {
  if (dirInput.value) dirInput.value.click();
}

function onFolderInput(event) {
  const files = [...(event.target.files || [])].filter(isImageFile);
  event.target.value = "";
  if (!files.length) {
    notify("没有发现图片", "info");
    return;
  }
  const root = files[0] && files[0].webkitRelativePath ? files[0].webkitRelativePath.split("/")[0] : "本地文件夹";
  const entry = {
    id: uid("tmp"),
    name: root,
    files,
    session: true,
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
    lastCount: files.length,
  };
  sessionFolders.value.unshift(entry);
  activateFolder(entry);
}

function pickImages() {
  if (fileInput.value) fileInput.value.click();
}

function onImageInput(event) {
  const files = [...(event.target.files || [])].filter(isImageFile);
  event.target.value = "";
  if (!files.length) {
    notify("没有发现图片", "info");
    return;
  }
  const entry = {
    id: uid("tmp"),
    name: "手动选择的图片",
    files,
    session: true,
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
    lastCount: files.length,
  };
  sessionFolders.value.unshift(entry);
  activateFolder(entry);
}

function onDrop(event) {
  dragging.value = false;
  const files = [...((event.dataTransfer && event.dataTransfer.files) || [])].filter(isImageFile);
  if (!files.length) {
    notify("没有发现图片", "info");
    return;
  }
  const entry = {
    id: uid("tmp"),
    name: "拖入的图片",
    files,
    session: true,
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
    lastCount: files.length,
  };
  sessionFolders.value.unshift(entry);
  activateFolder(entry);
}

function askRemoveFolder(entry) {
  if (removeCandidate.value === entry.id) {
    removeFolder(entry);
    return;
  }
  removeCandidate.value = entry.id;
  clearTimeout(removeTimer);
  removeTimer = setTimeout(() => {
    removeCandidate.value = null;
  }, 3200);
}

async function removeFolder(entry) {
  removeCandidate.value = null;
  clearTimeout(removeTimer);
  if (entry.session) {
    sessionFolders.value = sessionFolders.value.filter((item) => item.id !== entry.id);
  } else {
    try {
      await idbDelete("imageFolders", entry.id);
    } catch (error) {
      notify("取关目录失败: " + error.message, "error");
      return;
    }
    persistedFolders.value = persistedFolders.value.filter((item) => item.id !== entry.id);
  }
  if (activeFolderId.value === entry.id) clearImages();
  notify("已取关目录 · " + entry.name, "info");
}

function clearView() {
  clearImages();
  notify("已清空当前图片视图", "info");
}

function folderCount(entry) {
  if (activeFolderId.value === entry.id && images.value.length) return images.value.length;
  return entry.lastCount != null ? entry.lastCount : null;
}

async function loadFolders() {
  loading.value = true;
  try {
    const rows = await idbGetAll("imageFolders");
    persistedFolders.value = rows
      .filter((row) => row && row.handle && row.handle.kind === "directory")
      .map((row) => ({ ...row, handle: markRaw(row.handle) }))
      .sort(compareFolders);

    try {
      const legacy = await idbGet("folders", "images");
      if (legacy && legacy.kind === "directory") {
        const exists = persistedFolders.value.some((item) => item.name === legacy.name);
        if (!exists) {
          const entry = {
            id: uid("dir"),
            name: legacy.name,
            handle: markRaw(legacy),
            addedAt: Date.now(),
            lastOpenedAt: 0,
            lastCount: null,
          };
          persistedFolders.value.unshift(entry);
          await saveFolder(entry);
        }
        await idbDelete("folders", "images");
      }
    } catch {}

    const recent = persistedFolders.value[0];
    if (recent) {
      try {
        const permission = typeof recent.handle.queryPermission === "function" ? await recent.handle.queryPermission({ mode: "read" }) : "granted";
        if (permission === "granted") await activateFolder(recent, { silent: true });
      } catch {}
    }
  } catch (error) {
    notify("无法读取目录列表: " + error.message, "error");
  } finally {
    loading.value = false;
  }
}

function openViewer(index) {
  viewer.index = index;
  viewer.zoom = 1;
  viewer.open = true;
  preloadNeighbours(index);
}

function closeViewer() {
  viewer.open = false;
  viewer.zoom = 1;
}

function prev() {
  if (viewer.index > 0) {
    viewer.index -= 1;
    viewer.zoom = 1;
    preloadNeighbours(viewer.index);
  }
}

function next() {
  if (viewer.index < sortedImages.value.length - 1) {
    viewer.index += 1;
    viewer.zoom = 1;
    preloadNeighbours(viewer.index);
  }
}

function preloadNeighbours(index) {
  for (const offset of [1, -1]) {
    const row = sortedImages.value[index + offset];
    if (row) {
      const preload = new Image();
      preload.src = row.url;
    }
  }
}

function zoomIn() {
  viewer.zoom = Math.min(4, Math.round((viewer.zoom + 0.15) * 100) / 100);
}

function zoomOut() {
  viewer.zoom = Math.max(1, Math.round((viewer.zoom - 0.15) * 100) / 100);
}

function onKey(event) {
  if (!viewer.open) return;
  if (event.key === "Escape") closeViewer();
  else if (event.key === "ArrowRight" || event.key === " ") {
    event.preventDefault();
    next();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    prev();
  } else if (event.key === "=" || event.key === "+") zoomIn();
  else if (event.key === "-") zoomOut();
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  loadFolders();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  clearTimeout(removeTimer);
  revokeAll();
});
</script>

<template>
  <div
    class="plugin plugin--images"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <header class="pluginbar">
      <button class="pluginbar__back" @click="goHome">← {{ t("common.back") }}</button>
      <div class="pluginbar__divider" />
      <div class="pluginbar__brand">
        <div class="pluginbar__mark" style="border-color: var(--tox); color: var(--tox)">IMG</div>
        <div>
          <div class="pluginbar__title">{{ t("plugins.image.name") }}</div>
          <div class="pluginbar__sub">IMAGE BROWSER · DIRECTORY DECK</div>
        </div>
      </div>
      <div class="pluginbar__spacer" />
      <div class="image-stat">
        <span class="eyebrow">FILES</span>
        <b>{{ images.length }}</b>
        <span class="eyebrow">{{ formatBytes(totalBytes) }}</span>
      </div>
      <button class="btn-hazard" :disabled="loading" @click="pickFolder">
        {{ loading ? "读取中…" : canPickDirectory ? "添加目录" : "选择文件夹" }}
      </button>
      <button class="btn-ghost" @click="pickFolderFallback">选择文件夹</button>
      <button class="btn-ghost" @click="pickImages">选择图片</button>
      <button v-if="images.length" class="btn-ghost" @click="clearView">清空</button>
    </header>

    <div class="hazard" />

    <section class="image-shelf">
      <div class="image-layout">
        <div class="image-main">
          <div v-if="!images.length" class="image-drop panel panel--cut" :class="{ 'is-hot': dragging }" @click="pickFolder">
            <div class="image-drop__glyph">IMG</div>
            <div class="image-drop__body">
              <div class="eyebrow" style="color: var(--tox)">DIRECTORY DECK · 图片目录</div>
              <h2 class="image-drop__title">从右侧目录进入，或添加一个图片文件夹</h2>
              <p class="image-drop__hint">
                每个目录都会保留在右侧列表里，可以随时进入、继续授权或取关。也可以直接选择图片，或把图片拖进窗口。
              </p>
              <div class="image-drop__actions">
                <button class="btn-hazard" @click.stop="pickFolder">添加目录</button>
                <button class="btn-ghost" @click.stop="pickFolderFallback">选择文件夹</button>
                <button class="btn-ghost" @click.stop="pickImages">选择图片</button>
              </div>
            </div>
          </div>

          <template v-else>
            <div class="image-toolbar">
              <div>
                <div class="eyebrow">CURRENT DIRECTORY · 当前目录</div>
                <div class="image-toolbar__title">{{ folderLabel }}</div>
                <div class="image-toolbar__meta">{{ images.length }} 张 · {{ formatBytes(totalBytes) }} · 点击任意图片进入灯箱</div>
              </div>
              <div class="image-toolbar__actions">
                <select v-model="sortOrder" class="image-select">
                  <option value="name-asc">文件名 A→Z</option>
                  <option value="name-desc">文件名 Z→A</option>
                  <option value="date-desc">文件时间 新→旧</option>
                  <option value="date-asc">文件时间 旧→新</option>
                </select>
                <button class="btn-ghost" @click="pickFolder">添加目录</button>
                <button class="btn-ghost" @click="pickImages">加图片</button>
              </div>
            </div>

            <div class="image-grid">
              <button
                v-for="(image, index) in sortedImages"
                :key="image.url"
                class="image-card"
                :title="image.name + (image.lastModified ? ' · ' + new Date(image.lastModified).toLocaleString('zh-CN') : '')"
                @click="openViewer(index)"
              >
                <img :src="image.url" :alt="image.label" loading="lazy" draggable="false" />
                <span class="image-card__index">{{ String(index + 1).padStart(2, "0") }}</span>
                <span class="image-card__name" :title="image.name">{{ image.label }}</span>
              </button>
            </div>
          </template>
        </div>

        <aside class="image-folders panel">
          <div class="image-folders__head">
            <div>
              <div class="eyebrow">FOLDERS · 目录</div>
              <h3 class="image-folders__title">浏览目录</h3>
            </div>
            <button class="mini-btn is-primary" style="flex: 0 0 auto; padding: 7px 10px" :disabled="loading" @click="pickFolder">
              ＋ 添加
            </button>
          </div>

          <div class="hazard" style="opacity: 0.45; margin: 12px 0"></div>

          <div v-if="!allFolders.length" class="image-folders__empty">
            还没有目录。<br />
            添加一个本地文件夹，或选择图片。
          </div>
          <div v-else class="image-folders__list">
            <article
              v-for="entry in allFolders"
              :key="entry.id"
              class="folder-item"
              :class="{ 'is-active': activeFolderId === entry.id }"
              @click="activateFolder(entry)"
            >
              <div class="folder-item__icon">DIR</div>
              <div class="folder-item__body">
                <div class="folder-item__name" :title="entry.name">{{ entry.name }}</div>
                <div class="folder-item__meta">
                  {{ folderCount(entry) != null ? folderCount(entry) + " 张" : "未读取" }}
                  <span v-if="entry.session"> · 临时</span>
                </div>
              </div>
              <button
                class="folder-item__remove"
                :class="{ 'is-confirm': removeCandidate === entry.id }"
                :title="removeCandidate === entry.id ? '再次点击确认取关' : '取关目录'"
                @click.stop="askRemoveFolder(entry)"
              >
                {{ removeCandidate === entry.id ? "确认" : "取关" }}
              </button>
            </article>
          </div>

          <button class="btn-ghost" style="width: 100%; margin-top: 12px" @click="pickFolderFallback">选择文件夹（兼容模式）</button>
          <p class="image-folders__note">取关只从列表移除，不会删除磁盘上的文件。Chrome 拒绝授权系统目录时，会自动改用文件选择器；非图片文件会被忽略。</p>
        </aside>
      </div>

      <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onImageInput" />
      <input ref="dirInput" type="file" webkitdirectory multiple accept="image/*" hidden @change="onFolderInput" />
      <p class="image-note">
        图片直接从本机读取，不会上传。Chrome 的文件夹授权保存在本浏览器；文件本身仍留在你的磁盘上。
      </p>
    </section>

    <div v-if="viewer.open && current" class="image-viewer">
      <header class="image-viewer__bar">
        <button class="btn-ghost" @click="closeViewer">✕ 关闭</button>
        <div class="image-viewer__title" :title="current.name">{{ current.label }}</div>
        <div style="flex: 1" />
        <span class="eyebrow">{{ viewer.index + 1 }} / {{ sortedImages.length }}</span>
        <button class="btn-ghost" @click="zoomOut">－</button>
        <span class="eyebrow">{{ Math.round(viewer.zoom * 100) }}%</span>
        <button class="btn-ghost" @click="zoomIn">＋</button>
        <button class="btn-ghost" @click="viewer.zoom = 1">适应</button>
      </header>
      <div class="image-viewer__stage">
        <button class="image-viewer__nav image-viewer__nav--prev" :disabled="viewer.index <= 0" @click="prev">←</button>
        <div class="image-viewer__canvas">
          <img :src="current.url" :alt="current.label" :style="{ zoom: viewer.zoom }" draggable="false" />
        </div>
        <button class="image-viewer__nav image-viewer__nav--next" :disabled="viewer.index >= sortedImages.length - 1" @click="next">→</button>
      </div>
      <footer class="image-viewer__foot">
        <span>{{ current.name }}</span>
        <span>{{ formatBytes(current.size) }} · ← / → 翻页 · Esc 关闭</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.plugin--images { flex: 1; display: flex; flex-direction: column; min-height: calc(100vh - 70px); }
.image-stat { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--bone-dim); }
.image-stat b { color: var(--tox); font-size: 18px; }
.image-shelf { width: 100%; max-width: 1560px; margin: 0 auto; padding: 24px 26px 70px; }
.image-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
.image-main { min-width: 0; }

.image-folders {
  position: sticky;
  top: 18px;
  padding: 16px;
  max-height: calc(100vh - 36px);
  overflow: auto;
}
.image-folders__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.image-folders__title { margin: 4px 0 0; font-family: var(--display); font-size: 24px; letter-spacing: 0.05em; color: var(--bone); }
.image-folders__empty { border: 1px dashed var(--line); padding: 18px 12px; font-size: 12px; line-height: 1.8; color: var(--muted); text-align: center; }
.image-folders__list { display: flex; flex-direction: column; gap: 7px; }
.folder-item {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  padding: 8px;
  border: 1px solid var(--line-soft);
  background: #0e0c09;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.folder-item:hover { border-color: var(--tox); background: rgba(158, 203, 59, 0.05); }
.folder-item.is-active { border-color: var(--tox); box-shadow: inset 2px 0 0 var(--tox); }
.folder-item__icon {
  width: 34px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  color: var(--tox);
  font-size: 9px;
  letter-spacing: 0.08em;
  background: #0b0a08;
}
.folder-item__body { min-width: 0; }
.folder-item__name { font-size: 12px; color: var(--bone); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-item__meta { margin-top: 3px; font-size: 10px; letter-spacing: 0.05em; color: var(--muted); }
.folder-item__remove {
  border: 1px solid var(--line-soft);
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  padding: 4px 5px;
  cursor: pointer;
}
.folder-item__remove:hover { border-color: var(--danger); color: var(--danger); }
.folder-item__remove.is-confirm { border-color: var(--danger); color: var(--danger); }
.image-folders__note { margin: 14px 0 0; padding-top: 10px; border-top: 1px dashed var(--line-soft); font-size: 10.5px; line-height: 1.7; color: var(--muted); }

.image-drop {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 30px;
  cursor: pointer;
  border-style: dashed;
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
}
.image-drop:hover,
.image-drop.is-hot {
  border-color: var(--tox);
  background: linear-gradient(120deg, rgba(158, 203, 59, 0.12), transparent 62%), var(--panel);
  transform: translateY(-2px);
}
.image-drop__glyph {
  flex: 0 0 auto;
  width: 96px;
  height: 96px;
  display: grid;
  place-items: center;
  border: 1px solid var(--tox);
  color: var(--tox);
  font-family: var(--display);
  font-size: 26px;
  letter-spacing: 0.08em;
  background: linear-gradient(155deg, rgba(158, 203, 59, 0.18), transparent);
  clip-path: polygon(0 0, 100% 0, 100% 78%, 78% 100%, 0 100%);
}
.image-drop__title { margin: 6px 0 0; font-family: var(--display); font-size: 26px; letter-spacing: 0.04em; color: var(--bone); }
.image-drop__hint { margin: 8px 0 0; max-width: 720px; font-size: 12.5px; line-height: 1.85; color: var(--muted); }
.image-drop__actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }

.image-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line-soft);
}
.image-toolbar__title { font-family: var(--display); font-size: 26px; letter-spacing: 0.04em; color: var(--bone); }
.image-toolbar__meta { margin-top: 5px; font-size: 11.5px; letter-spacing: 0.06em; color: var(--muted); }
.image-toolbar__actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.image-select {
  background: #0e0c09;
  border: 1px solid var(--line);
  color: var(--bone-dim);
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  padding: 9px 10px;
  outline: none;
}
.image-select:focus { border-color: var(--tox); }

.image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.image-card {
  position: relative;
  aspect-ratio: 1 / 1;
  padding: 0;
  border: 1px solid var(--line-soft);
  background: #0c0a08;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
.image-card:hover { transform: translateY(-2px); border-color: var(--tox); box-shadow: 0 14px 30px -24px var(--tox); }
.image-card img { width: 100%; height: 100%; object-fit: cover; display: block; filter: saturate(0.92); }
.image-card:hover img { filter: saturate(1.05); }
.image-card__index {
  position: absolute;
  top: 6px;
  left: 6px;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  color: var(--bone);
  background: rgba(10, 9, 7, 0.72);
  border: 1px solid var(--line);
  padding: 1px 5px;
}
.image-card__name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 4px 6px;
  font-size: 10.5px;
  color: var(--bone-dim);
  background: linear-gradient(to top, rgba(10, 9, 7, 0.92), transparent);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.image-note { margin-top: 24px; font-size: 11px; line-height: 1.8; letter-spacing: 0.06em; color: var(--muted); }

.image-viewer {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: flex;
  flex-direction: column;
  background: rgba(6, 5, 4, 0.985);
}
.image-viewer__bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: rgba(12, 10, 8, 0.94);
}
.image-viewer__title {
  max-width: 42vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  letter-spacing: 0.05em;
  color: var(--bone);
}
.image-viewer__stage { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; padding: 14px 76px; }
.image-viewer__canvas {
  width: 100%;
  height: 100%;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.image-viewer__canvas img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  box-shadow: 0 30px 80px -40px #000;
}
.image-viewer__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 52px;
  height: 100px;
  border: 1px solid var(--line);
  background: rgba(16, 13, 9, 0.82);
  color: var(--bone);
  font-size: 24px;
  cursor: pointer;
  z-index: 2;
}
.image-viewer__nav:hover { background: var(--tox); border-color: var(--tox); color: #10160a; }
.image-viewer__nav:disabled { opacity: 0.25; cursor: not-allowed; }
.image-viewer__nav--prev { left: 14px; }
.image-viewer__nav--next { right: 14px; }
.image-viewer__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 18px 12px;
  border-top: 1px solid var(--line);
  background: rgba(12, 10, 8, 0.94);
  font-size: 11.5px;
  letter-spacing: 0.06em;
  color: var(--muted);
}

@media (max-width: 1080px) {
  .image-layout { grid-template-columns: 1fr; }
  .image-folders { position: static; order: -1; max-height: none; }
}
@media (max-width: 720px) {
  .image-shelf { padding: 18px 14px 60px; }
  .image-drop { flex-direction: column; align-items: flex-start; }
  .image-viewer__bar { flex-wrap: wrap; gap: 8px; }
  .image-viewer__stage { padding: 10px 54px; }
  .image-viewer__nav { width: 38px; height: 70px; }
}
</style>
