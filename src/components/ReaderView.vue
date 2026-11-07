<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  state,
  closeReader,
  goToPage,
  stepPage,
  toggleSpread,
  resumeReading,
  restartReading,
  flushProgress,
} from "@/stores/archive";
import { hasModifier, modKeyLabel, platformLabel } from "@/lib/platform";
import { makePaperTexture, getImage, getLeafSource, onImageReady, renderLeaf } from "@/lib/curl";

const reader = computed(() => state.reader);
const total = computed(() => reader.value.pages.length);
const spread = computed(() => reader.value.spread);
const canPrev = computed(() => reader.value.page > 1);
const canNext = computed(() => reader.value.page < total.value);
const pageLabel = computed(() => String(reader.value.page).padStart(2, "0"));
const totalLabel = computed(() => String(total.value).padStart(2, "0"));
const progress = computed(() => (total.value ? (reader.value.page - 1) / Math.max(1, total.value - 1) : 0));

/* ------------------------------------------------------------------ */
/* flip state                                                          */
/* ------------------------------------------------------------------ */
const readerRef = ref(null);
const bookRef = ref(null);
const canvasRef = ref(null);
const flip = reactive({ active: false, dir: "next", progress: 0 });
const drag = reactive({ active: false, startX: 0, moved: false });
const pan = reactive({ x: 0, y: 0 });
const panDrag = reactive({ active: false, startX: 0, startY: 0, baseX: 0, baseY: 0 });
const stageRef = ref(null);
const metrics = reactive({ w: 0, h: 0, expand: 0, bookW: 0, bookH: 0, dpr: 1 });

/* Explicit page geometry: images get a fixed pixel size so swapping the base
 * image never changes layout (which used to make the canvas stretch/tear). */
const viewport = reactive({ w: window.innerWidth, h: window.innerHeight });
const aspect = ref(2551 / 3437);

const pageSize = computed(() => {
  const zoom = reader.value.zoom;
  const maxW = Math.max(220, viewport.w - 220) * zoom;
  const maxH = Math.max(220, viewport.h - 168) * zoom;
  if (reader.value.fit === "height") {
    let h = maxH;
    let w = h * aspect.value;
    if (spread.value && w * 2 > maxW) {
      w = maxW / 2;
      h = w / aspect.value;
    }
    return { w: Math.round(w), h: Math.round(h) };
  }
  let w = maxW / (spread.value ? 2 : 1);
  let h = w / aspect.value;
  if (h > maxH) {
    h = maxH;
    w = h * aspect.value;
  }
  return { w: Math.round(w), h: Math.round(h) };
});

const bookSize = computed(() => ({
  w: pageSize.value.w * (spread.value ? 2 : 1),
  h: pageSize.value.h,
}));

function refreshAspect() {
  const page = reader.value.pages[reader.value.page - 1];
  if (!page) return;
  const img = getImage(page.url);
  if (img && img.naturalWidth && img.naturalHeight) {
    const next = img.naturalWidth / img.naturalHeight;
    if (Math.abs(next - aspect.value) > 0.001) aspect.value = next;
  } else {
    onImageReady(page.url, refreshAspect);
  }
}

let ctx = null;
let paperTexture = null;
let rafId = 0;
let animId = 0;
let leafCanvas = null;
let leafCtx = null;

const baseImages = computed(() => {
  const page = reader.value.page;
  const pages = reader.value.pages;
  if (!flip.active) {
    return (spread.value ? [pages[page - 1], pages[page]] : [pages[page - 1]]).filter(Boolean);
  }
  if (spread.value) {
    return (flip.dir === "next" ? [pages[page - 1], pages[page + 2]] : [pages[page - 3], pages[page]]).filter(Boolean);
  }
  return [flip.dir === "next" ? pages[page] : pages[page - 1]].filter(Boolean);
});

const flat = computed(() => true);

const flatGeom = computed(() => {
  if (!flip.active || !flat.value || !metrics.bookW) return null;
  const geom = leafGeom.value;
  if (!geom) return null;
  const p = Math.min(1, Math.max(0, flip.progress));
  const theta = geom.theta0 + (geom.theta1 - geom.theta0) * p;
  const deg = (theta * 180) / Math.PI;
  const shade = Math.sin(theta) * 0.32;
  if (spread.value) {
    const W = metrics.bookW / 2;
    if (flip.dir === "next") return { left: W, width: W, origin: "left center", deg: -deg, front: geom.front, back: geom.back, shade };
    return { left: 0, width: W, origin: "right center", deg, front: geom.front, back: geom.back, shade };
  }
  return { left: 0, width: metrics.bookW, origin: "left center", deg: -deg, front: geom.front, back: geom.back, shade };
});

const leafGeom = computed(() => {
  if (!flip.active || !metrics.bookW) return null;
  const page = reader.value.page;
  const pages = reader.value.pages;
  if (spread.value) {
    const W = metrics.bookW / 2;
    if (flip.dir === "next") {
      return { front: pages[page], back: pages[page + 1], hinge: W, dir: 1, theta0: 0, theta1: Math.PI, W, bend: 0.62 };
    }
    return { front: pages[page - 1], back: pages[page - 2], hinge: W, dir: -1, theta0: 0, theta1: Math.PI, W, bend: 0.62 };
  }
  const W = metrics.bookW;
  if (flip.dir === "next") {
    return { front: pages[page - 1], back: null, hinge: 0, dir: 1, theta0: 0, theta1: Math.PI, W, bend: 0.95 };
  }
  return { front: pages[page - 2], back: null, hinge: 0, dir: 1, theta0: Math.PI, theta1: 0, W, bend: 0.95 };
});

/* ------------------------------------------------------------------ */
/* canvas plumbing                                                     */
/* ------------------------------------------------------------------ */
function syncCanvas() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  // never reallocate the drawing surface mid-flip (that would flash the canvas)
  if (flip.active && metrics.w) return;
  const width = bookSize.value.w;
  const height = bookSize.value.h;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  const expand = spread.value ? 0 : width;
  const w = width + expand * 2;
  const h = height;

  const sizeChanged = metrics.w !== w || metrics.h !== h || metrics.dpr !== dpr;
  metrics.expand = expand;
  metrics.bookW = width;
  metrics.bookH = h;

  if (sizeChanged) {
    metrics.w = w;
    metrics.h = h;
    metrics.dpr = dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  canvas.style.left = -expand + "px";
  scheduleRender();
}

function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    render();
  });
}

function ensureLeafCanvas() {
  if (!leafCanvas) {
    leafCanvas = document.createElement("canvas");
    leafCtx = leafCanvas.getContext("2d");
  }
  if (leafCanvas.width !== Math.round(metrics.w * metrics.dpr) || leafCanvas.height !== Math.round(metrics.h * metrics.dpr)) {
    leafCanvas.width = Math.round(metrics.w * metrics.dpr);
    leafCanvas.height = Math.round(metrics.h * metrics.dpr);
    leafCtx = leafCanvas.getContext("2d");
  }
  return leafCtx;
}

function render() {
  if (!ctx) return;
  ctx.clearRect(0, 0, metrics.w, metrics.h);
  if (!flip.active || flat.value) return;
  const geom = leafGeom.value;
  if (!geom || !geom.W) return;

  if (!getImage(geom.front && geom.front.url)) {
    if (geom.front) onImageReady(geom.front.url, scheduleRender);
    return;
  }
  const front = getLeafSource(geom.front.url, geom.W, metrics.dpr);
  let back = paperTexture;
  if (geom.back) {
    back = getLeafSource(geom.back.url, geom.W, metrics.dpr);
    if (!back) {
      onImageReady(geom.back.url, scheduleRender);
      back = paperTexture;
    }
  }

  const p = Math.min(1, Math.max(0, flip.progress));
  const theta = geom.theta0 + (geom.theta1 - geom.theta0) * p;
  const bend = geom.bend * Math.sin(Math.PI * p);

  // Draw the whole leaf into an offscreen buffer first, then blit it in one
  // shot: the compositor never sees a half-drawn sheet (no tearing / stripes).
  const octx = ensureLeafCanvas();
  octx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  octx.clearRect(0, 0, metrics.w, metrics.h);
  renderLeaf(octx, {
    W: geom.W,
    H: metrics.bookH,
    hingeX: metrics.expand + geom.hinge,
    dir: geom.dir,
    theta,
    bend,
    front,
    back,
    centerX: metrics.expand + metrics.bookW / 2,
    centerY: metrics.bookH / 2,
  });
  ctx.drawImage(leafCanvas, 0, 0, metrics.w, metrics.h);
}

let animTimer = 0;

function animateProgress(target, duration, done) {
  cancelAnimationFrame(animId);
  clearTimeout(animTimer);
  const start = flip.progress;
  const t0 = performance.now();
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(animId);
    animId = 0;
    clearTimeout(animTimer);
    flip.progress = target;
    render();
    done && done();
  };

  const step = (now) => {
    if (finished) return;
    const k = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    flip.progress = start + (target - start) * eased;
    render();
    if (k < 1) animId = requestAnimationFrame(step);
    else finish();
  };

  animId = requestAnimationFrame(step);
  // rAF can be throttled (background tab / headless), so guarantee the flip
  // always settles instead of freezing mid-turn.
  animTimer = setTimeout(finish, duration + 160);
}

function beginFlip(dir) {
  cancelAnimationFrame(animId);
  clearTimeout(animTimer);
  flip.active = true;
  flip.dir = dir;
  flip.progress = 0;
  const geom = leafGeom.value;
  if (geom) {
    if (geom.front) getImage(geom.front.url) || onImageReady(geom.front.url, scheduleRender);
    if (geom.back) getImage(geom.back.url) || onImageReady(geom.back.url, scheduleRender);
  }
  scheduleRender();
}

function resetFlip() {
  flip.active = false;
  flip.progress = 0;
  cancelAnimationFrame(animId);
  clearTimeout(animTimer);
  animId = 0;
  scheduleRender();
}

function commitFlip(dir) {
  const step = spread.value ? 2 : 1;
  const target = reader.value.page + (dir === "next" ? step : -step);
  resetFlip();
  goToPage(target);
}

function settle(commit) {
  const dir = flip.dir;
  animateProgress(commit ? 1 : 0, 320, () => {
    if (commit) commitFlip(dir);
    else resetFlip();
  });
}

function animateTurn(dir) {
  if (flip.active) return;
  if (dir === "next" ? !canNext.value : !canPrev.value) return;
  beginFlip(dir);
  nextTick(() => {
    requestAnimationFrame(() => animateProgress(1, 360, () => commitFlip(dir)));
  });
}

/* ------------------------------------------------------------------ */
/* pointer handling                                                    */
/* ------------------------------------------------------------------ */
function onPointerDown(event) {
  if (event.button !== 0) return;
  if (flip.active) return;
  if (hasModifier(event)) {
    event.preventDefault();
    panDrag.active = true;
    panDrag.startX = event.clientX;
    panDrag.startY = event.clientY;
    panDrag.baseX = pan.x;
    panDrag.baseY = pan.y;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    return;
  }
  drag.active = true;
  drag.startX = event.clientX;
  drag.moved = false;
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  if (panDrag.active) {
    pan.x = panDrag.baseX + (event.clientX - panDrag.startX);
    pan.y = panDrag.baseY + (event.clientY - panDrag.startY);
    clampPan();
    return;
  }
  if (!drag.active) return;
  const dx = event.clientX - drag.startX;
  if (!drag.moved) {
    if (Math.abs(dx) < 10) return;
    drag.moved = true;
    beginFlip(dx < 0 ? "next" : "prev");
  }
  const dir = dx < 0 ? "next" : "prev";
  if (flip.dir !== dir) {
    flip.dir = dir;
  }
  const width = metrics.bookW || 700;
  const allowed = dir === "next" ? canNext.value : canPrev.value;
  const span = spread.value ? width / 2 : width;
  let p = Math.min(1, Math.abs(dx) / Math.max(160, span * 0.9));
  if (!allowed) p = Math.min(p, 0.12);
  flip.progress = p;
  scheduleRender();
}

function onPointerUp() {
  if (panDrag.active) {
    panDrag.active = false;
    return;
  }
  if (!drag.active) return;
  const moved = drag.moved;
  drag.active = false;
  drag.moved = false;
  if (flip.active) {
    const dir = flip.dir;
    const allowed = dir === "next" ? canNext.value : canPrev.value;
    settle(allowed && flip.progress > 0.32);
  } else if (!moved) {
    animateTurn("next");
  }
}

/* ------------------------------------------------------------------ */
/* reading helpers                                                     */
/* ------------------------------------------------------------------ */
const railRef = ref(null);
const isFullscreen = ref(false);

function jump(delta) {
  animateTurn(delta > 0 ? "next" : "prev");
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen().catch(() => {});
}

function onFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement);
}

function clampZoom(value) {
  return Math.min(2.4, Math.max(0.5, Number(value.toFixed(2))));
}

function resetPan() {
  pan.x = 0;
  pan.y = 0;
}

function panBounds() {
  const stage = stageRef.value;
  if (!stage) return { x: 0, y: 0 };
  const contentW = Math.max(0, stage.clientWidth - 152);
  const contentH = Math.max(0, stage.clientHeight - 28);
  const overX = Math.max(0, bookSize.value.w - contentW);
  const overY = Math.max(0, bookSize.value.h - contentH);
  return { x: overX > 0 ? overX / 2 + 16 : 0, y: overY > 0 ? overY / 2 + 16 : 0 };
}

function clampPan() {
  const bounds = panBounds();
  pan.x = Math.max(-bounds.x, Math.min(bounds.x, pan.x));
  pan.y = Math.max(-bounds.y, Math.min(bounds.y, pan.y));
}

function onWheel(event) {
  if (!hasModifier(event)) return;
  event.preventDefault();
  if (flip.active) return;
  const delta = event.deltaY < 0 ? 0.12 : -0.12;
  reader.value.zoom = clampZoom(reader.value.zoom + delta);
  if (reader.value.zoom <= 1) resetPan();
  else clampPan();
}

function zoomBy(delta) {
  reader.value.zoom = clampZoom(reader.value.zoom + delta);
  if (reader.value.zoom <= 1) resetPan();
  else clampPan();
}

function toggleFit() {
  reader.value.fit = reader.value.fit === "height" ? "width" : "height";
  reader.value.zoom = 1;
  resetPan();
}

function imageStyle() {
  return { width: pageSize.value.w + "px", height: pageSize.value.h + "px" };
}

function scrollRailToActive() {
  requestAnimationFrame(() => {
    const rail = railRef.value;
    if (!rail) return;
    const active = rail.querySelector(".is-active");
    if (active) active.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  });
}

watch(
  () => reader.value.page,
  () => {
    scrollRailToActive();
    preload();
    refreshAspect();
    resetPan();
  }
);

watch([() => reader.value.spread, () => reader.value.fit], () => resetPan());

watch([() => reader.value.spread, () => reader.value.zoom, () => reader.value.fit, bookSize], async () => {
  await nextTick();
  syncCanvas();
  clampPan();
});

function onWindowResize() {
  viewport.w = window.innerWidth;
  viewport.h = window.innerHeight;
  requestAnimationFrame(clampPan);
}

function preload() {
  const idx = reader.value.page - 1;
  for (const offset of [1, 2, 3, -1, -2]) {
    const page = reader.value.pages[idx + offset];
    if (page) getImage(page.url);
  }
}

function onKey(event) {
  if (!reader.value.open) return;
  const key = event.key;
  if (key === "ArrowRight" || key === "PageDown" || key === " ") {
    event.preventDefault();
    jump(1);
  } else if (key === "ArrowLeft" || key === "PageUp") {
    event.preventDefault();
    jump(-1);
  } else if (key === "Home") {
    goToPage(1);
  } else if (key === "End") {
    goToPage(total.value);
  } else if (key === "Escape") {
    if (document.fullscreenElement) return;
    closeReader();
  } else if (key === "f") {
    toggleFullscreen();
  } else if (key === "s") {
    toggleSpread();
  } else if (key === "r") {
    reader.value.showRail = !reader.value.showRail;
  } else if (key === "=" || key === "+") {
    zoomBy(0.15);
  } else if (key === "-") {
    zoomBy(-0.15);
  }
}

function onVisibility() {
  if (document.visibilityState === "hidden") flushProgress();
}

let observer = null;

onMounted(async () => {
  window.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", flushProgress);
  if (readerRef.value) readerRef.value.addEventListener("wheel", onWheel, { passive: false });
  paperTexture = makePaperTexture(420, 600);
  preload();
  refreshAspect();
  scrollRailToActive();
  window.addEventListener("resize", onWindowResize);
  await nextTick();
  syncCanvas();
  observer = new ResizeObserver(() => syncCanvas());
  if (bookRef.value) observer.observe(bookRef.value);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("beforeunload", flushProgress);
  if (readerRef.value) readerRef.value.removeEventListener("wheel", onWheel);
  if (observer) observer.disconnect();
  window.removeEventListener("resize", onWindowResize);
  cancelAnimationFrame(rafId);
  cancelAnimationFrame(animId);
  clearTimeout(animTimer);
  flushProgress();
});
</script>

<template>
  <div ref="readerRef" class="reader" @contextmenu.prevent>
    <header class="reader__hud">
      <button class="btn-ghost" @click="closeReader">✕ 关闭</button>
      <div class="reader__title">
        <strong>{{ reader.title }} · {{ reader.volume }}</strong>
        <span>
          LOCAL ARCHIVE · {{ totalLabel }} PAGES · {{ platformLabel }} ·
          拖拽翻页 · ←/→ · F 全屏 · S 双页 · R 胶片 ·
          <kbd class="keycap">{{ modKeyLabel }}</kbd> + 滚轮 缩放 ·
          <kbd class="keycap">{{ modKeyLabel }}</kbd> + 拖动 平移
        </span>
      </div>
      <div style="flex: 1"></div>

      <div class="reader__readout">
        <span>页码 <b>{{ pageLabel }}</b> / {{ totalLabel }}</span>
        <span>缩放 <b>{{ Math.round(reader.zoom * 100) }}%</b></span>
      </div>

      <button class="btn-ghost" @click="zoomBy(-0.15)">－</button>
      <button class="btn-ghost" @click="zoomBy(0.15)">＋</button>
      <button class="btn-ghost" :class="{ 'is-active': reader.fit === 'width' }" @click="toggleFit">
        {{ reader.fit === "height" ? "适应高度" : "适应宽度" }}
      </button>
      <button class="btn-ghost" @click="toggleFullscreen">{{ isFullscreen ? "退出全屏" : "全屏" }}</button>
    </header>

    <div class="hazard" style="opacity: 0.5"></div>

    <div ref="stageRef" class="reader__stage">
      <button class="reader__nav reader__nav--prev" :disabled="!canPrev" title="上一页 ←" @click="jump(-1)">←</button>

      <div
        ref="bookRef"
        class="book"
        :style="{
          width: bookSize.w + 'px',
          height: bookSize.h + 'px',
          transform: pan.x || pan.y ? 'translate(' + pan.x + 'px, ' + pan.y + 'px)' : 'none',
        }"
        :class="{ 'is-dragging': drag.active && drag.moved, 'is-panning': panDrag.active }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dragstart.prevent
      >
        <div class="book__pages">
          <img
            v-for="(image, index) in baseImages"
            :key="(image && image.index) + '-' + index"
            class="book__page"
            :src="image.url"
            :style="imageStyle()"
            alt=""
            draggable="false"
          />
        </div>
        <canvas ref="canvasRef" class="book__canvas"></canvas>

        <div
          v-if="flatGeom"
          class="flat-sheet"
          :style="{
            left: flatGeom.left + 'px',
            width: flatGeom.width + 'px',
            transformOrigin: flatGeom.origin,
            transform: 'rotateY(' + flatGeom.deg + 'deg)',
          }"
        >
          <div class="flat-face">
            <img :src="flatGeom.front ? flatGeom.front.url : ''" alt="" draggable="false" />
            <div class="flat-shade" :style="{ opacity: flatGeom.shade }"></div>
          </div>
          <div class="flat-face flat-face--back">
            <img v-if="flatGeom.back" :src="flatGeom.back.url" alt="" draggable="false" />
            <div v-else class="flat-paper">MKX ARCHIVE</div>
          </div>
        </div>

        <div v-if="!flip.active" class="book__hint">拖拽翻页</div>
      </div>

      <button class="reader__nav reader__nav--next" :disabled="!canNext" title="下一页 →" @click="jump(1)">→</button>

      <div class="reader__rail">
        <button class="rail-btn" :class="{ 'is-active': reader.showRail }" @click="reader.showRail = !reader.showRail">预览</button>
        <button class="rail-btn" @click="toggleFullscreen">全屏</button>
        <button class="rail-btn" :class="{ 'is-active': reader.spread }" @click="toggleSpread">双页</button>
        <button class="rail-btn" :disabled="!canPrev" @click="jump(-1)">←</button>
        <button class="rail-btn" :disabled="!canNext" @click="jump(1)">→</button>
      </div>

      <div v-if="reader.zoom > 1" class="reader__pan-hint">
        <kbd class="keycap">{{ modKeyLabel }}</kbd> 拖动平移 · <kbd class="keycap">{{ modKeyLabel }}</kbd> 滚轮缩放
      </div>

      <div class="reader__progress" :style="{ width: progress * 100 + '%' }"></div>
    </div>

    <footer v-if="reader.showRail" class="reader__footer">
      <div class="reader__readout" style="justify-content: space-between">
        <span>FILMSTRIP · 点击跳转</span>
        <span>剩余 <b>{{ total - reader.page }}</b> 页 · {{ reader.pages[0] ? reader.pages[0].file.split(".").pop().toUpperCase() : "" }}</span>
      </div>
      <div ref="railRef" class="page-rail">
        <button
          v-for="page in reader.pages"
          :key="page.index"
          class="page-thumb"
          :class="{ 'is-active': page.index === reader.page || (spread && page.index === reader.page + 1) }"
          @click="goToPage(page.index)"
        >
          <img :src="page.url" :alt="'第' + page.index + '页'" loading="lazy" />
          <span>{{ String(page.index).padStart(2, "0") }}</span>
        </button>
      </div>
    </footer>

    <v-dialog :model-value="reader.askResume" max-width="500" persistent :transition="false">
      <div class="panel panel--cut" style="padding: 24px">
        <div class="eyebrow" style="margin-bottom: 10px">RESUME SESSION · 阅读进度</div>
        <div style="font-size: 15px; color: var(--bone)">
          上次读到第 <b style="color: var(--amber)">{{ reader.resumeAt }}</b> 页 / 共 {{ total }} 页
        </div>
        <p style="font-size: 12px; line-height: 1.9; color: var(--muted); margin: 10px 0 0">
          要从上次停下的位置继续，还是从这一期的第一页重新开始？
        </p>
        <div class="hazard" style="margin: 18px 0"></div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button class="btn-ghost" @click="restartReading">从头开始</button>
          <button class="btn-hazard" @click="resumeReading">继续阅读</button>
        </div>
      </div>
    </v-dialog>
  </div>
</template>

<style scoped>
.reader__rail {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  background: rgba(12, 10, 8, 0.86);
  backdrop-filter: blur(6px);
  z-index: 5;
}
.rail-btn {
  width: 64px;
  padding: 12px 0;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  background: transparent;
  color: var(--bone-dim);
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 0.08em;
  cursor: pointer;
  transition: all 0.15s ease;
}
.rail-btn:last-child { border-bottom: 0; }
.rail-btn:hover { background: var(--amber); color: #14110d; }
.rail-btn.is-active { color: var(--amber); box-shadow: inset 2px 0 0 var(--amber); }
.rail-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.reader__progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--amber);
  box-shadow: 0 0 12px var(--amber);
  transition: width 0.25s ease;
}

.book {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  -webkit-user-select: none;
  user-select: none;
  touch-action: pan-y;
  will-change: transform;
  transform-style: preserve-3d;
}
.book.is-dragging,
.book.is-panning { cursor: grabbing; }
.book__pages { display: flex; }
.book__page {
  display: block;
  -webkit-user-select: none;
  user-select: none;
  -webkit-user-drag: none;
  box-shadow: 0 30px 80px -40px #000, 0 0 0 1px rgba(255, 176, 0, 0.14);
  background: #0b0a08;
}
.book__canvas {
  position: absolute;
  top: 0;
  pointer-events: none;
  z-index: 2;
}

.flat-sheet {
  position: absolute;
  top: 0;
  height: 100%;
  transform-style: preserve-3d;
  will-change: transform;
  z-index: 3;
}
.flat-face {
  position: absolute;
  inset: 0;
  backface-visibility: hidden;
  overflow: hidden;
  background: #0b0a08;
  box-shadow: 0 24px 60px -34px #000;
}
.flat-face img { width: 100%; height: 100%; object-fit: fill; display: block; }
.flat-face--back { transform: rotateY(180deg); }
.flat-shade { position: absolute; inset: 0; background: #050403; pointer-events: none; }
.flat-paper {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #b6aa92, #948872);
  color: #3b3529;
  font-size: 13px;
  letter-spacing: 0.3em;
}

.book__hint {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: rgba(222, 212, 194, 0.35);
  background: rgba(10, 9, 7, 0.45);
  border: 1px solid rgba(61, 52, 39, 0.6);
  padding: 3px 10px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.25s ease;
}
.book:hover .book__hint { opacity: 1; }

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

.reader__pan-hint {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--bone-dim);
  background: rgba(10, 9, 7, 0.82);
  border: 1px solid var(--line);
  padding: 5px 10px;
  pointer-events: none;
  z-index: 4;
}
</style>
