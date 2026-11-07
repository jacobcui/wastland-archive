<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from "vue";
import { idbDelete, idbGet, idbGetAll, idbPut, idbPutMany } from "@/lib/idb";
import { formatBytes } from "@/lib/format";
import { goHome } from "@/lib/navigation";
import { transcodeMedia } from "@/lib/media-decoder";
import { notify } from "@/stores/ui";
import { t } from "@/i18n";

const MIME_BY_EXT = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ts: "video/mp2t",
  flv: "video/x-flv",
  f4v: "video/x-f4v",
  mxf: "application/mxf",
  avi: "video/x-msvideo",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wma: "audio/x-ms-wma",
  alac: "audio/mp4",
};

const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mov", "mkv", "ts", "flv", "f4v", "mxf", "avi", "3gp"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "wma", "alac"]);

const media = ref([]);
const folders = ref([]);
const active = ref(null);
const objectUrl = ref("");
const loading = ref(true);
const importing = ref(false);
const folderImporting = ref(false);
const folderStatus = ref("");
const decoding = ref(false);
const decodeProgress = ref(0);
const decodeStatus = ref("");
const streamMode = ref(false);
const streamState = ref("idle");
const streamStatus = ref("");
const streamProgress = ref(0);
const streamBusy = computed(() => ["uploading", "transcoding", "starting"].includes(streamState.value));
const rescanningFolder = ref("");
const rescanTargetFolderId = ref("");
const pendingSeek = ref(0);
let seekTimer = null;
let lastPositionSave = 0;
let hls = null;
let streamAbort = null;
let streamSessionId = "";
let streamToken = 0;
let streamStarted = false;
let fallbackForId = "";
let playRequested = false;
const dragging = ref(false);
const removeCandidate = ref(null);
const folderRemoveCandidate = ref(null);
const collapsed = reactive(new Set());
const fileInput = ref(null);
const folderInput = ref(null);
const videoRef = ref(null);
const audioRef = ref(null);
const playerRef = ref(null);
const pendingAutoplay = ref(false);
const decodedCache = new Map();
const fileCache = new Map();

const POSITION_KEY = "wasteland.media.positions.v1";
let resumePositions = {};
try { resumePositions = JSON.parse(localStorage.getItem(POSITION_KEY) || "{}") || {}; } catch {}

function writeResumePositions() {
  try { localStorage.setItem(POSITION_KEY, JSON.stringify(resumePositions)); } catch {}
}

function resumePosition(row) {
  if (!row) return 0;
  const recorded = resumePositions[row.id];
  const raw = recorded && Number.isFinite(recorded.position) ? recorded.position : Number(row.position) || 0;
  const duration = Number(recorded && recorded.duration) || Number(row.duration) || 0;
  if (duration > 0 && raw >= duration - 1.5) return 0;
  return Math.max(0, raw);
}

function rememberPosition(row, position) {
  if (!row) return;
  const pos = Math.max(0, Number(position) || 0);
  const duration = Number(player.duration) || Number(row.duration) || 0;
  resumePositions[row.id] = { position: duration > 0 && pos >= duration - 1.5 ? 0 : pos, duration, updatedAt: Date.now() };
  row.position = resumePositions[row.id].position;
  writeResumePositions();
}

function forgetPosition(row) {
  if (!row) return;
  delete resumePositions[row.id];
  row.position = 0;
  writeResumePositions();
}

const visualizerRef = ref(null);
const visualStageRef = ref(null);
const visualFullscreen = ref(false);
const fsTopVisible = ref(false);
const fsBottomVisible = ref(false);
let fsTopTimer = null;
let fsBottomTimer = null;

function showFsTop() {
  fsTopVisible.value = true;
  clearTimeout(fsTopTimer);
  fsTopTimer = setTimeout(() => { fsTopVisible.value = false; }, 2800);
}

function showFsBottom() {
  fsBottomVisible.value = true;
  clearTimeout(fsBottomTimer);
  fsBottomTimer = setTimeout(() => { fsBottomVisible.value = false; }, 2800);
}

function onVisualPointer(event) {
  if (!visualFullscreen.value) return;
  const y = event.clientY;
  if (y < 150) showFsTop();
  if (y > window.innerHeight - 170) showFsBottom();
}
const PLAY_MODES = [
  { value: "continue", label: "顺序" },
  { value: "loop", label: "列表循环" },
  { value: "single", label: "单曲循环" },
  { value: "shuffle", label: "随机" },
];
const VISUAL_MODES = [
  { value: "wave", label: "波形 Waveform" },
  { value: "bars", label: "频谱条 Spectrum Bars" },
  { value: "line", label: "线状频谱 Line Spectrum" },
  { value: "radial", label: "径向频谱 Radial Spectrum" },
  { value: "particles", label: "粒子 Particles" },
  { value: "terrain", label: "山峦 Terrain" },
];
const storedMode = localStorage.getItem("wasteland.media.play-mode");
const playMode = ref(PLAY_MODES.some((mode) => mode.value === storedMode) ? storedMode : "continue");
const storedVisual = localStorage.getItem("wasteland.media.visual-mode");
const visualMode = ref(VISUAL_MODES.some((mode) => mode.value === storedVisual) ? storedVisual : "bars");

const player = reactive({
  playing: false,
  ready: false,
  loading: false,
  error: null,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  rate: 1,
});

let removeTimer = null;
let folderRemoveTimer = null;
let persistTimer = null;
const probe = document.createElement("video");

const totalBytes = computed(() => media.value.reduce((sum, row) => sum + (row.size || 0), 0));

function mediaPath(row) {
  return String(row.relativePath || row.name || "");
}

function sortMediaRows(a, b) {
  return mediaPath(a).localeCompare(mediaPath(b), "zh-CN", { numeric: true, sensitivity: "base" });
}

function folderFiles(folderId) {
  return media.value.filter((row) => row.folderId === folderId).sort(sortMediaRows);
}

function buildPathTree(rows) {
  const root = { dirs: new Map(), files: [] };
  for (const row of rows) {
    const parts = mediaPath(row).split("/").filter(Boolean);
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(row);
  }
  return root;
}

function treeCount(node) {
  let total = node.files.length;
  for (const child of node.dirs.values()) total += treeCount(child);
  return total;
}

function appendTreeRows(out, node, depth, keyPrefix) {
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN", { numeric: true, sensitivity: "base" }));
  for (const [name, child] of dirs) {
    const key = keyPrefix + "/" + name;
    out.push({ type: "dir", key, name, depth, count: treeCount(child) });
    if (!collapsed.has(key)) appendTreeRows(out, child, depth + 1, key);
  }
  const files = [...node.files].sort(sortMediaRows);
  for (const row of files) out.push({ type: "file", row, depth });
}

const playOrder = computed(() => {
  const out = media.value.filter((row) => !row.folderId).sort(sortMediaRows);
  for (const folder of folders.value) out.push(...folderFiles(folder.id));
  return out;
});

const treeRows = computed(() => {
  const out = [];
  const loose = media.value.filter((row) => !row.folderId).sort(sortMediaRows);
  if (loose.length) {
    out.push({ type: "folder", key: "loose", name: "直接导入", depth: 0, count: loose.length, folder: null });
    if (!collapsed.has("loose")) for (const row of loose) out.push({ type: "file", row, depth: 1 });
  }
  for (const folder of folders.value) {
    const files = folderFiles(folder.id);
    const key = "folder:" + folder.id;
    out.push({ type: "folder", key, name: folder.name, depth: 0, count: files.length, folder });
    if (!collapsed.has(key)) appendTreeRows(out, buildPathTree(files), 1, key);
  }
  return out;
});

function toggleTree(key) {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
}

watch(playMode, (value) => {
  try {
    localStorage.setItem("wasteland.media.play-mode", value);
  } catch {}
});

let audioContext = null;
let analyser = null;
let sourceEl = null;
let sourceNode = null;
let visualRaf = 0;
let visualPhase = 0;
let freqData = new Uint8Array(1024);
let waveData = new Uint8Array(2048);

const particles = Array.from({ length: 220 }, () => ({
  angle: Math.random() * Math.PI * 2,
  radius: 14 + Math.random() * 280,
  speed: 0.35 + Math.random() * 1.35,
  spin: (Math.random() - 0.5) * 0.018,
  band: Math.random(),
  prevX: null,
  prevY: null,
}));

function ensureAudioGraph() {
  if (!active.value || active.value.kind !== "audio") return null;
  const el = audioRef.value;
  if (!el) return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioContext) audioContext = new Ctx();
  if (sourceEl !== el) {
    try {
      sourceNode = audioContext.createMediaElementSource(el);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;
      sourceNode.connect(analyser);
      analyser.connect(audioContext.destination);
      sourceEl = el;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      waveData = new Uint8Array(analyser.fftSize);
    } catch {
      sourceNode = null;
      analyser = null;
      sourceEl = null;
    }
  }
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return analyser;
}

async function toggleVisualFullscreen() {
  const el = visualStageRef.value;
  if (!el) return;
  if (visualFullscreen.value) {
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch {}
    visualFullscreen.value = false;
    return;
  }
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (el.msRequestFullscreen) el.msRequestFullscreen();
    else return;
    visualFullscreen.value = true;
    showFsTop();
    showFsBottom();
  } catch {}
}

function onVisualFullscreenChange() {
  const el = visualStageRef.value;
  visualFullscreen.value = Boolean(el && (document.fullscreenElement === el || document.webkitFullscreenElement === el));
  clearTimeout(fsTopTimer);
  clearTimeout(fsBottomTimer);
  if (visualFullscreen.value) {
    showFsTop();
    showFsBottom();
  } else {
    fsTopVisible.value = false;
    fsBottomVisible.value = false;
  }
}

function startVisualizer() {
  if (visualRaf) return;
  const loop = () => {
    visualRaf = requestAnimationFrame(loop);
    drawVisual();
  };
  visualRaf = requestAnimationFrame(loop);
}

function stopVisualizer() {
  if (visualRaf) cancelAnimationFrame(visualRaf);
  visualRaf = 0;
}

function readFrequencies() {
  if (analyser && player.playing) {
    if (freqData.length !== analyser.frequencyBinCount) freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);
    return freqData;
  }
  for (let i = 0; i < freqData.length; i += 1) {
    const value = 22 + 16 * Math.sin(visualPhase * 1.4 + i * 0.19) + 10 * Math.sin(visualPhase * 2.2 + i * 0.071);
    freqData[i] = Math.max(0, Math.min(255, value));
  }
  return freqData;
}

function readWaveform() {
  if (analyser && player.playing) {
    if (waveData.length !== analyser.fftSize) waveData = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(waveData);
    return waveData;
  }
  for (let i = 0; i < waveData.length; i += 1) {
    waveData[i] = 128 + 34 * Math.sin((i / waveData.length) * Math.PI * 6 + visualPhase * 2.4) * Math.sin(visualPhase * 0.7 + 0.8);
  }
  return waveData;
}

function drawVisual() {
  const canvas = visualizerRef.value;
  if (!canvas) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetW = Math.round(width * dpr);
  const targetH = Math.round(height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  visualPhase += 0.016;

  const freq = readFrequencies();
  const wave = readWaveform();
  const blue = "#6ea8fe";
  const amber = "#ffb000";
  const tox = "#9ecb3b";

  if (visualMode.value === "wave") {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = blue;
    ctx.shadowColor = blue;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 2) {
      const idx = Math.min(wave.length - 1, Math.floor((x / width) * wave.length));
      const y = height / 2 + ((wave[idx] - 128) / 128) * height * 0.3;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = amber;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (visualMode.value === "bars") {
    const count = 64;
    const gap = 2;
    const barW = Math.max(1, (width - gap * (count - 1)) / count);
    ctx.save();
    for (let i = 0; i < count; i += 1) {
      const idx = Math.min(freq.length - 1, Math.floor(Math.pow(i / count, 1.55) * freq.length * 0.72));
      const value = Math.pow(freq[idx] / 255, 1.6);
      const h = Math.max(2, value * height * 0.72);
      const x = i * (barW + gap);
      const gradient = ctx.createLinearGradient(0, height, 0, height - h);
      gradient.addColorStop(0, "rgba(110, 168, 254, 0.25)");
      gradient.addColorStop(0.55, blue);
      gradient.addColorStop(1, amber);
      ctx.fillStyle = gradient;
      ctx.fillRect(x, height - h - 16, barW, h);
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x, height - h * 0.55 - 16, barW, h * 0.55);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    return;
  }

  if (visualMode.value === "line") {
    const count = 110;
    ctx.save();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = tox;
    ctx.shadowColor = tox;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    for (let i = 0; i < count; i += 1) {
      const idx = Math.min(freq.length - 1, Math.floor(Math.pow(i / count, 1.4) * freq.length * 0.7));
      const x = (i / (count - 1)) * width;
      const y = height * 0.84 - (freq[idx] / 255) * height * 0.62;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.22;
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, height * 0.25, 0, height);
    fill.addColorStop(0, "rgba(158, 203, 59, 0.35)");
    fill.addColorStop(1, "rgba(158, 203, 59, 0)");
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
    return;
  }

  if (visualMode.value === "radial") {
    const cx = width / 2;
    const cy = height / 2;
    const base = Math.min(width, height) * 0.17;
    const count = 96;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(visualPhase * 0.12);
    for (let i = 0; i < count; i += 1) {
      const idx = Math.min(freq.length - 1, Math.floor((i / count) * freq.length * 0.55));
      const value = freq[idx] / 255;
      const angle = (i / count) * Math.PI * 2;
      const length = base * 0.25 + value * Math.min(width, height) * 0.28;
      ctx.beginPath();
      ctx.strokeStyle = i % 3 === 0 ? amber : blue;
      ctx.globalAlpha = 0.28 + value * 0.72;
      ctx.lineWidth = 1.6;
      ctx.moveTo(Math.cos(angle) * base, Math.sin(angle) * base);
      ctx.lineTo(Math.cos(angle) * (base + length), Math.sin(angle) * (base + length));
      ctx.stroke();
    }
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.arc(0, 0, base, 0, Math.PI * 2);
    ctx.strokeStyle = blue;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (visualMode.value === "particles") {
    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.min(width, height) * 0.47;
    const bass = freq.slice(0, 18).reduce((sum, value) => sum + value, 0) / 18 / 255;
    const mid = freq.slice(18, 90).reduce((sum, value) => sum + value, 0) / 72 / 255;
    const treble = freq.slice(90, 220).reduce((sum, value) => sum + value, 0) / 130 / 255;
    ctx.save();
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.35);
    glow.addColorStop(0, "rgba(110, 168, 254, " + (0.05 + bass * 0.16) + ")");
    glow.addColorStop(0.5, "rgba(194, 84, 42, " + (0.025 + mid * 0.06) + ")");
    glow.addColorStop(1, "rgba(7, 6, 5, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    for (const particle of particles) {
      const value = freq[Math.floor(particle.band * freq.length)] / 255;
      particle.radius += particle.speed * (0.35 + value * 4.2 + bass * 1.4);
      particle.angle += particle.spin + 0.002 * (1 + mid) + treble * 0.002;
      if (particle.radius > maxR) {
        particle.radius = 8 + Math.random() * 22;
        particle.angle = Math.random() * Math.PI * 2;
        particle.band = Math.random();
        particle.prevX = null;
        particle.prevY = null;
      }
      const x = cx + Math.cos(particle.angle) * particle.radius;
      const y = cy + Math.sin(particle.angle) * particle.radius * 0.68;
      const size = 1 + value * 3.4 + bass * 2.4;
      const color = particle.band > 0.68 ? amber : particle.band > 0.34 ? blue : tox;
      if (particle.prevX !== null) {
        ctx.globalAlpha = 0.05 + value * 0.34;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.6, size * 0.55);
        ctx.beginPath();
        ctx.moveTo(particle.prevX, particle.prevY);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.3 + value * 0.7;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8 + bass * 10;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
      particle.prevX = x;
      particle.prevY = y;
    }
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
    for (let ring = 0; ring < 3; ring += 1) {
      const radius = maxR * (0.28 + ring * 0.22) + bass * maxR * 0.12;
      ctx.globalAlpha = 0.06 + bass * 0.14 - ring * 0.012;
      ctx.strokeStyle = ring === 1 ? amber : blue;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (visualMode.value === "terrain") {
    const layers = 6;
    const count = 72;
    ctx.save();
    for (let layer = layers - 1; layer >= 0; layer -= 1) {
      const baseY = height * (0.48 + layer * 0.075);
      const amplitude = height * (0.2 - layer * 0.018);
      const gradient = ctx.createLinearGradient(0, baseY - amplitude, 0, height);
      gradient.addColorStop(0, "rgba(110, 168, 254, " + (0.08 + layer * 0.018) + ")");
      gradient.addColorStop(1, "rgba(10, 9, 7, 0)");
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let i = 0; i < count; i += 1) {
        const idx = Math.min(freq.length - 1, Math.floor((i / count) * freq.length * 0.6));
        const value = freq[idx] / 255;
        const x = (i / (count - 1)) * width;
        const y = baseY - value * amplitude - Math.sin(visualPhase * 0.6 + i * 0.16 + layer) * 5;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.strokeStyle = layer === 0 ? blue : "rgba(110, 168, 254, " + (0.2 + layer * 0.05) + ")";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }
}

watch(visualMode, (value) => {
  try {
    localStorage.setItem("wasteland.media.visual-mode", value);
  } catch {}
});

watch(
  () => (active.value ? active.value.kind : null),
  (kind) => {
    if (kind === "audio") startVisualizer();
    else stopVisualizer();
  }
);

function extOf(name) {
  const value = String(name || "");
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(index + 1).toLowerCase() : "";
}

function mimeOf(file) {
  const ext = extOf(file.name);
  return file.type || MIME_BY_EXT[ext] || "";
}

function kindOf(file, mime) {
  const ext = extOf(file.name);
  if (AUDIO_EXT.has(ext) || (mime && mime.startsWith("audio/"))) return "audio";
  if (VIDEO_EXT.has(ext) || (mime && mime.startsWith("video/"))) return "video";
  return null;
}

function isMediaFile(file) {
  if (!file) return false;
  return Boolean(kindOf(file, mimeOf(file)));
}

function uid() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return "media-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function supportOf(mime, fallback = null) {
  const value = mime ? probe.canPlayType(mime) : "";
  if (value === "probably") return { level: "native", label: "原生" };
  if (value === "maybe") return { level: "maybe", label: "可尝试" };
  if (fallback === "maybe") return { level: "maybe", label: "可尝试" };
  if (fallback === "native") return { level: "native", label: "原生" };
  return { level: "no", label: "需转码" };
}

const FORMAT_GROUPS = [
  {
    group: "视频容器",
    rows: [
      { label: "MP4 / M4V", codec: "H.264 + AAC", mime: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' },
      { label: "WebM", codec: "VP9 / AV1 + Opus", mime: 'video/webm; codecs="vp9, opus"' },
      { label: "MOV", codec: "QuickTime H.264", mime: 'video/quicktime; codecs="avc1.42E01E, mp4a.40.2"', fallback: "maybe" },
      { label: "MKV", codec: "H.264 + AAC 多轨", mime: 'video/x-matroska; codecs="avc1.42E01E, mp4a.40.2"' },
      { label: "TS", codec: "HLS / MPEG-TS", mime: 'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"' },
      { label: "FLV / F4V", codec: "H.264 + AAC", mime: 'video/x-flv; codecs="avc1.42E01E, mp4a.40.2"' },
      { label: "AVI", codec: "DivX / Xvid", mime: "video/x-msvideo" },
      { label: "MXF", codec: "广电专业素材", mime: "application/mxf" },
      { label: "3GP", codec: "H.263 / H.264", mime: "video/3gpp" },
      { label: "HEVC / H.265", codec: "hvc1", mime: 'video/mp4; codecs="hvc1"', fallback: "maybe" },
      { label: "AV1", codec: "AV1", mime: 'video/mp4; codecs="av01.0.05M.08"' },
      { label: "ProRes", codec: "Apple ProRes", mime: 'video/quicktime; codecs="apcn"' },
    ],
  },
  {
    group: "音频容器",
    rows: [
      { label: "MP3", codec: "MPEG Layer 3", mime: "audio/mpeg" },
      { label: "M4A / AAC", codec: "AAC-LC", mime: 'audio/mp4; codecs="mp4a.40.2"' },
      { label: "FLAC", codec: "无损", mime: "audio/flac" },
      { label: "WAV", codec: "PCM", mime: "audio/wav" },
      { label: "OGG / Opus", codec: "Opus / Vorbis", mime: 'audio/ogg; codecs="opus"' },
      { label: "ALAC", codec: "Apple 无损", mime: 'audio/mp4; codecs="alac"' },
      { label: "WMA", codec: "Windows Media Audio", mime: "audio/x-ms-wma" },
    ],
  },
].map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row, support: supportOf(row.mime, row.fallback || null) })) }));

function knownDuration(el) {
  if (!el) return 0;
  if (Number.isFinite(el.duration) && el.duration > 0) return el.duration;
  try {
    if (el.seekable && el.seekable.length) return el.seekable.end(el.seekable.length - 1);
  } catch {}
  return 0;
}

function streamDuration(el) {
  if (!el) return 0;
  try {
    if (el.seekable && el.seekable.length) return el.seekable.end(el.seekable.length - 1);
  } catch {}
  return knownDuration(el);
}


function applyPendingSeek(el) {
  const target = pendingSeek.value;
  if (!el || !target) return;
  const max = streamMode.value ? streamDuration(el) : knownDuration(el);
  if (max > 0.5 && target >= max - 1.5) {
    pendingSeek.value = 0;
    try { el.currentTime = 0; } catch {}
    return;
  }
  if (max > 0.5 && target > max) {
    if (!streamMode.value) {
      try { el.currentTime = Math.max(0, max - 0.5); } catch {}
      pendingSeek.value = 0;
      return;
    }
    if (seekTimer) return;
    let attempts = 0;
    seekTimer = setInterval(() => {
      attempts += 1;
      if (!el || !active.value || attempts > 20) {
        clearInterval(seekTimer);
        seekTimer = null;
        if (el) {
          try { el.currentTime = target; } catch {}
        }
        pendingSeek.value = 0;
        return;
      }
      const available = streamDuration(el);
      if (available > 0 && available >= target - 0.5) {
        clearInterval(seekTimer);
        seekTimer = null;
        try { el.currentTime = target; } catch {}
        pendingSeek.value = 0;
      }
    }, 500);
    return;
  }
  try { el.currentTime = Math.max(0, target); } catch {}
  pendingSeek.value = 0;
}
function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const total = Math.floor(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
}

function mediaEl() {
  if (!active.value) return null;
  return active.value.kind === "audio" ? audioRef.value : videoRef.value;
}

function isCurrentMedia(event) {
  const el = event && event.currentTarget;
  if (!el) return false;
  if (streamMode.value) return el === mediaEl();
  if (!objectUrl.value) return el === mediaEl();
  return Boolean(el.currentSrc === objectUrl.value);
}

function persist(row) {
  if (!row) return;
  idbPut("media", toRaw(row), row.id).catch(() => {});
}

function persistSoon(row) {
  if (!row) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist(row);
  }, 500);
}


async function readTranscodeRecord(mediaId) {
  try {
    return await idbGet("mediaTranscodes", mediaId);
  } catch {
    return null;
  }
}

async function writeTranscodeRecord(mediaId, sessionId) {
  try {
    await idbPut("mediaTranscodes", { id: mediaId, sessionId, createdAt: Date.now() }, mediaId);
  } catch {}
}

async function forgetTranscodeRecord(mediaId) {
  try {
    await idbDelete("mediaTranscodes", mediaId);
  } catch {}
}

async function dropMediaTranscode(mediaId) {
  const record = await readTranscodeRecord(mediaId);
  if (record && record.sessionId) {
    fetch("/api/transcode/" + record.sessionId, { method: "DELETE" }).catch(() => {});
  }
  await forgetTranscodeRecord(mediaId);
}

async function transcodeRecordStatus(record) {
  if (!record || !record.sessionId) return null;
  try {
    const response = await fetch("/api/transcode/" + record.sessionId + "/status", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
function cleanupStreamResources({ keepSession = false } = {}) {
  if (hls) {
    try { hls.destroy(); } catch {}
    hls = null;
  }
  if (streamAbort) {
    const controller = streamAbort;
    streamAbort = null;
    try { controller.abort(); } catch {}
  }
  if (streamSessionId) {
    const id = streamSessionId;
    streamSessionId = "";
    if (!keepSession || !streamStarted) {
      fetch("/api/transcode/" + id, { method: "DELETE" }).catch(() => {});
    }
  }
  streamStarted = false;
  streamMode.value = false;
}

function detachStreaming({ keepSession = true } = {}) {
  streamToken += 1;
  cleanupStreamResources({ keepSession });
  streamState.value = "idle";
  streamStatus.value = "";
  streamProgress.value = 0;
  if (seekTimer) {
    clearInterval(seekTimer);
    seekTimer = null;
  }
}

function dropStreaming() {
  detachStreaming({ keepSession: false });
}

function saveActivePosition() {
  const el = mediaEl();
  if (!el || !active.value) return;
  const position = Number.isFinite(el.currentTime) ? el.currentTime : 0;
  active.value.position = position;
  rememberPosition(active.value, position);
  persist(active.value);
}

function stopCurrent() {
  saveActivePosition();
  const el = mediaEl();
  detachStreaming({ keepSession: true });
  if (el) {
    try {
      el.pause();
    } catch {}
    el.removeAttribute("src");
    try {
      el.load();
    } catch {}
  }
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = "";
  player.playing = false;
  player.ready = false;
  player.loading = false;
  player.error = null;
  player.currentTime = 0;
  player.duration = 0;
  pendingAutoplay.value = false;
  pendingSeek.value = 0;
}

async function ensureReadPermission(handle) {
  if (!handle) return false;
  try {
    if (handle.queryPermission) {
      const state = await handle.queryPermission({ mode: "read" });
      if (state === "granted") return true;
      if (handle.requestPermission) return (await handle.requestPermission({ mode: "read" })) === "granted";
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function resolveStoredSource(row) {
  if (!row) return null;
  if (row.fileHandle && typeof row.fileHandle.getFile === "function") {
    if (!(await ensureReadPermission(row.fileHandle))) return null;
    return row.fileHandle.getFile();
  }
  if (row.folderId) {
    const folder = folders.value.find((item) => item.id === row.folderId);
    if (!folder || !folder.handle) return null;
    if (!(await ensureReadPermission(folder.handle))) return null;
    const parts = String(row.relativePath || row.name || "").split("/").filter(Boolean);
    if (!parts.length) return null;
    let dir = folder.handle;
    for (let i = 0; i < parts.length - 1; i += 1) dir = await dir.getDirectoryHandle(parts[i]);
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
    return fileHandle.getFile();
  }
  return null;
}

async function openMedia(row, { autoplay = false } = {}) {
  if (!row) return;
  stopCurrent();
  fallbackForId = "";
  playRequested = autoplay;
  active.value = row;
  pendingAutoplay.value = autoplay;
  pendingSeek.value = resumePosition(row);
  lastPositionSave = 0;
  player.error = null;
  player.loading = true;
  player.ready = false;
  player.currentTime = pendingSeek.value;
  player.duration = Number(row.duration) || 0;
  const cached = decodedCache.get(row.id) || null;
  const sourceFile = fileCache.get(row.id) || null;
  const type = cached ? cached.type : row.type || mimeOf({ name: row.name, type: row.type });
  let source = cached || sourceFile || row.data || row.blob || null;
  if (!source) {
    source = await resolveStoredSource(row);
    if (source) fileCache.set(row.id, source);
  }
  const sourceBytes = source ? source.size || source.byteLength || 0 : 0;
  if (row.kind === "video" && sourceBytes > 200 * 1024 * 1024) {
    player.error = null;
    player.ready = false;
    player.playing = false;
    if (!autoplay) {
      player.loading = false;
      return;
    }
    fallbackForId = row.id;
    player.loading = true;
    pendingAutoplay.value = true;
    await nextTick();
    runAutoFallback(row);
    return;
  }
  if (source && source instanceof Blob && source.type) {
    objectUrl.value = URL.createObjectURL(source);
  } else if (source) {
    objectUrl.value = URL.createObjectURL(new Blob([source], { type }));
  } else {
    pendingAutoplay.value = false;
    player.loading = false;
    player.error = row.folderId
      ? "无法访问原文件夹，请重新选择该文件夹以恢复读取权限。"
      : "浏览器不会复制媒体文件；请重新选择该文件，或改用“添加文件夹”保留持久访问。";
    return;
  }
  await nextTick();
  const el = mediaEl();
  if (el) {
    el.volume = player.volume;
    el.muted = player.muted;
    el.playbackRate = player.rate;
    el.load();
  }
}

async function refresh() {
  loading.value = true;
  try {
    const [rows, folderRows] = await Promise.all([idbGetAll("media"), idbGetAll("mediaFolders")]);
    media.value = rows.sort((a, b) => (b.lastPlayedAt || b.addedAt || 0) - (a.lastPlayedAt || a.addedAt || 0));
    for (const folder of folderRows) {
      if (folder.handle) folder.handle = markRaw(folder.handle);
    }
    folders.value = folderRows.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    if (!active.value && media.value.length) await openMedia(media.value[0]);
  } catch (error) {
    notify("媒体库不可用: " + error.message, "error");
  } finally {
    loading.value = false;
  }
}

function fileRow(file, extra = {}) {
  const mime = mimeOf(file);
  const kind = kindOf(file, mime);
  if (!kind) return null;
  return {
    id: uid(),
    name: file.name,
    size: file.size,
    type: mime || (kind === "audio" ? "audio/" + extOf(file.name) : "video/" + extOf(file.name)),
    kind,
    addedAt: Date.now(),
    lastPlayedAt: 0,
    duration: 0,
    lastModified: file.lastModified || 0,
    ...extra,
  };
}

async function importFileHandles(handles) {
  importing.value = true;
  try {
    const rows = [];
    for (const handle of handles || []) {
      const file = await handle.getFile();
      const row = fileRow(file, { fileHandle: markRaw(handle) });
      if (!row) continue;
      rows.push(row);
      fileCache.set(row.id, file);
    }
    if (rows.length) await idbPutMany("media", rows);
    await refresh();
    notify("已添加 " + rows.length + " 个媒体文件（保留在原目录）", "success");
  } catch (error) {
    notify("导入失败: " + error.message, "error");
  } finally {
    importing.value = false;
  }
}

async function importFiles(fileList) {
  const files = [...(fileList || [])].filter(isMediaFile);
  if (!files.length) {
    notify("没有发现可播放的音频 / 视频文件", "info");
    return;
  }
  importing.value = true;
  try {
    const rows = [];
    for (const file of files) {
      const row = fileRow(file, { temporary: true });
      if (!row) continue;
      rows.push(row);
      fileCache.set(row.id, file);
    }
    if (rows.length) await idbPutMany("media", rows);
    await refresh();
    notify("已添加 " + rows.length + " 个媒体文件；未复制原文件。刷新页面后如无法访问，请重新选择目录。", "info");
  } catch (error) {
    notify("导入失败: " + error.message, "error");
  } finally {
    importing.value = false;
  }
}

async function pickFile() {
  if (typeof window.showOpenFilePicker === "function") {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      await importFileHandles(handles);
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
  }
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

async function collectMediaDirectory(handle) {
  const out = [];
  async function walk(dir, prefix, depth) {
    for await (const entry of dir.values()) {
      if (entry.kind === "file") {
        const file = await entry.getFile();
        if (isMediaFile(file)) out.push({ file, path: prefix + file.name });
      } else if (entry.kind === "directory" && depth < 8) {
        await walk(entry, prefix + entry.name + "/", depth + 1);
      }
    }
  }
  await walk(handle, "", 0);
  return out;
}

async function importFolderEntries(name, entries, source, handle = null) {
  const accepted = (entries || []).filter((entry) => entry && entry.file && isMediaFile(entry.file));
  if (!accepted.length) {
    notify("这个文件夹里没有可播放的音频 / 视频", "info");
    return;
  }
  const folder = {
    id: uid(),
    name: name || "文件夹",
    source: source || "input",
    addedAt: Date.now(),
    lastScannedAt: Date.now(),
    temporary: !handle,
  };
  if (handle) folder.handle = markRaw(handle);
  importing.value = true;
  folderImporting.value = true;
  folderStatus.value = "准备导入 " + accepted.length + " 个媒体文件…";
  try {
    await idbPut("mediaFolders", toRaw(folder), folder.id);
    folders.value.push(folder);
    const rows = [];
    for (const entry of accepted) {
      const file = entry.file;
      const path = entry.path || file.webkitRelativePath || file.name;
      const prefix = name + "/";
      const relativePath = path.startsWith(prefix) ? path.slice(prefix.length) : path;
      const row = fileRow(file, { relativePath, folderId: folder.id });
      if (!row) continue;
      rows.push(row);
      fileCache.set(row.id, file);
      if (rows.length % 25 === 0) folderStatus.value = "读取索引 " + rows.length + " / " + accepted.length + " …";
    }
    await idbPutMany("media", rows);
    folderStatus.value = "载入媒体库 …";
    await refresh();
    notify("已添加文件夹 · " + folder.name + " · " + rows.length + " 个媒体（文件保留在原目录）", "success");
  } catch (error) {
    notify("文件夹导入中断: " + error.message, "error");
  } finally {
    importing.value = false;
    folderImporting.value = false;
    folderStatus.value = "";
  }
}

async function addFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    if (folderInput.value) folderInput.value.click();
    return;
  }
  try {
    folderStatus.value = "选择目录…";
    const handle = await window.showDirectoryPicker({ mode: "read" });
    folderStatus.value = "扫描目录 " + handle.name + "…";
    const entries = await collectMediaDirectory(handle);
    await importFolderEntries(handle.name, entries, "handle", handle);
  } catch (error) {
    folderStatus.value = "";
    if (error && error.name === "AbortError") return;
    notify("系统不允许授权该目录，改用文件夹选择器读取（非媒体文件忽略）", "info");
    if (folderInput.value) folderInput.value.click();
  }
}

async function onFolderChange(event) {
  const files = [...(event.target.files || [])].filter(isMediaFile);
  event.target.value = "";
  const targetId = rescanTargetFolderId.value;
  rescanTargetFolderId.value = "";
  if (!files.length) {
    notify("没有发现可播放的音频 / 视频文件", "info");
    return;
  }
  const firstPath = files[0].webkitRelativePath || files[0].name;
  const root = firstPath.includes("/") ? firstPath.split("/")[0] : "文件夹";
  const entries = files.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  if (targetId) {
    const folder = folders.value.find((item) => item.id === targetId);
    if (!folder) return;
    rescanningFolder.value = folder.id;
    try {
      await reconcileFolder(folder, entries, root);
    } finally {
      rescanningFolder.value = "";
    }
    return;
  }
  importFolderEntries(root, entries, "input");
}

function askRemoveFolder(folder) {
  if (folderRemoveCandidate.value === folder.id) {
    removeFolder(folder);
    return;
  }
  folderRemoveCandidate.value = folder.id;
  clearTimeout(folderRemoveTimer);
  folderRemoveTimer = setTimeout(() => {
    folderRemoveCandidate.value = null;
  }, 3200);
}

async function removeFolder(folder) {
  folderRemoveCandidate.value = null;
  clearTimeout(folderRemoveTimer);
  const rows = media.value.filter((row) => row.folderId === folder.id);
  if (active.value && active.value.folderId === folder.id) {
    stopCurrent();
    active.value = null;
  }
  try {
    for (const row of rows) {
      decodedCache.delete(row.id);
      fileCache.delete(row.id);
      await dropMediaTranscode(row.id);
      await idbDelete("media", row.id);
    }
    await idbDelete("mediaFolders", folder.id);
    await refresh();
    notify("已移除目录 · " + folder.name + "（不会删除磁盘文件）", "info");
  } catch (error) {
    notify("移除目录失败: " + error.message, "error");
  }
}

function entryRelativePath(entry, rootPrefix = "") {
  const raw = String(entry.path || (entry.file && entry.file.webkitRelativePath) || (entry.file && entry.file.name) || "");
  if (rootPrefix && raw.startsWith(rootPrefix + "/")) return raw.slice(rootPrefix.length + 1);
  return raw;
}

async function reconcileFolder(folder, entries, rootPrefix = "") {
  const accepted = (entries || []).filter((entry) => entry && entry.file && isMediaFile(entry.file));
  const existing = media.value.filter((row) => row.folderId === folder.id);
  const existingByPath = new Map(existing.map((row) => [row.relativePath || row.name, row]));
  const seen = new Set();
  const putRows = [];
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const entry of accepted) {
    const file = entry.file;
    const relativePath = entryRelativePath(entry, rootPrefix);
    if (!relativePath) continue;
    seen.add(relativePath);
    const old = existingByPath.get(relativePath);
    if (!old) {
      const row = fileRow(file, { relativePath, folderId: folder.id });
      if (!row) continue;
      putRows.push(row);
      fileCache.set(row.id, file);
      added += 1;
    } else if (old.size !== file.size || (old.lastModified || 0) !== (file.lastModified || 0)) {
      old.name = file.name;
      old.size = file.size;
      old.type = mimeOf(file) || old.type;
      old.kind = kindOf(file, mimeOf(file));
      old.lastModified = file.lastModified || 0;
      delete old.blob;
      delete old.data;
      delete old.temporary;
      forgetPosition(old);
      decodedCache.delete(old.id);
      fileCache.set(old.id, file);
      await dropMediaTranscode(old.id);
      if (active.value && active.value.id === old.id) {
        stopCurrent();
        active.value = null;
      }
      putRows.push(toRaw(old));
      updated += 1;
    }
  }
  if (putRows.length) await idbPutMany("media", putRows);
  for (const old of existing) {
    if (seen.has(old.relativePath || old.name)) continue;
    if (active.value && active.value.id === old.id) {
      stopCurrent();
      active.value = null;
    }
    decodedCache.delete(old.id);
    fileCache.delete(old.id);
    forgetPosition(old);
    await dropMediaTranscode(old.id);
    await idbDelete("media", old.id);
    removed += 1;
  }
  folder.lastScannedAt = Date.now();
  folder.temporary = false;
  await idbPut("mediaFolders", toRaw(folder), folder.id);
  await refresh();
  notify("重扫完成 · " + folder.name + " · 新增 " + added + " / 更新 " + updated + " / 移除 " + removed, "success");
}

async function rescanFolder(folder) {
  if (!folder || rescanningFolder.value) return;
  if (!folder.handle) {
    if (typeof window.showDirectoryPicker === "function") {
      rescanningFolder.value = folder.id;
      try {
        const handle = await window.showDirectoryPicker({ mode: "read" });
        folder.handle = markRaw(handle);
        await idbPut("mediaFolders", toRaw(folder), folder.id);
        const entries = await collectMediaDirectory(handle);
        await reconcileFolder(folder, entries, "");
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
        notify("目录选择失败，改用兼容模式重新选择", "info");
        rescanTargetFolderId.value = folder.id;
        if (folderInput.value) folderInput.value.click();
        return;
      } finally {
        rescanningFolder.value = "";
      }
    }
    rescanTargetFolderId.value = folder.id;
    notify("当前浏览器不支持持久目录句柄，请重新选择一次目录", "info");
    if (folderInput.value) folderInput.value.click();
    return;
  }
  rescanningFolder.value = folder.id;
  try {
    let permission = "granted";
    if (typeof folder.handle.queryPermission === "function") permission = await folder.handle.queryPermission({ mode: "read" });
    if (permission !== "granted" && typeof folder.handle.requestPermission === "function") {
      permission = await folder.handle.requestPermission({ mode: "read" });
    }
    if (permission !== "granted") {
      notify("没有获得目录读取权限", "error");
      return;
    }
    const entries = await collectMediaDirectory(folder.handle);
    await reconcileFolder(folder, entries, "");
  } catch (error) {
    notify("重扫失败: " + error.message, "error");
  } finally {
    rescanningFolder.value = "";
  }
}
function onLoadedMetadata(event) {
  if (!isCurrentMedia(event)) return;
  const el = mediaEl();
  if (!el) return;
  player.loading = false;
  player.ready = true;
  player.error = null;
  player.duration = streamMode.value ? streamDuration(el) : knownDuration(el);
  applyPendingSeek(el);
  player.currentTime = Number.isFinite(el.currentTime) ? el.currentTime : 0;
  player.volume = el.volume;
  player.muted = el.muted;
  if (streamMode.value) {
    streamState.value = "playing";
    streamStatus.value = "";
  }
  if (active.value) {
    active.value.duration = player.duration;
    const row = media.value.find((item) => item.id === active.value.id);
    if (row) row.duration = player.duration;
    persist(active.value);
  }
  if (pendingAutoplay.value) {
    pendingAutoplay.value = false;
    el.play().catch(() => {});
  }
}

function onTimeUpdate(event) {
  if (!isCurrentMedia(event)) return;
  const el = mediaEl();
  if (!el) return;
  player.currentTime = el.currentTime;
  if (active.value) {
    active.value.position = el.currentTime;
    if (Date.now() - lastPositionSave > 1000) {
      lastPositionSave = Date.now();
      rememberPosition(active.value, el.currentTime);
      persist(active.value);
    }
  }
  if (streamMode.value) {
    const duration = streamDuration(el);
    if (duration > 0 && Math.abs(duration - player.duration) > 0.1) player.duration = duration;
  }
}

function onDurationChange(event) {
  if (!isCurrentMedia(event)) return;
  const el = mediaEl();
  if (!el) return;
  const duration = streamMode.value ? streamDuration(el) : knownDuration(el);
  if (duration > 0) player.duration = duration;
}

function onPlay(event) {
  if (!isCurrentMedia(event)) return;
  player.playing = true;
  if (streamMode.value) {
    streamState.value = "playing";
    streamStatus.value = "";
  }
  if (active.value && active.value.kind === "audio") {
    ensureAudioGraph();
    startVisualizer();
  }
  if (active.value) {
    active.value.lastPlayedAt = Date.now();
    const row = media.value.find((item) => item.id === active.value.id);
    if (row) row.lastPlayedAt = active.value.lastPlayedAt;
    persistSoon(active.value);
  }
}

function onPause(event) {
  if (!isCurrentMedia(event)) return;
  player.playing = false;
  const el = mediaEl();
  if (el && active.value) {
    active.value.position = Number.isFinite(el.currentTime) ? el.currentTime : 0;
    rememberPosition(active.value, active.value.position);
    persist(active.value);
  }
}

function replayCurrent() {
  const el = mediaEl();
  if (!el) return;
  el.currentTime = 0;
  player.currentTime = 0;
  el.play().catch(() => {});
}

function nextMedia({ auto = false } = {}) {
  const list = playOrder.value;
  if (!list.length) return;
  const index = active.value ? list.findIndex((row) => row.id === active.value.id) : -1;
  if (auto && playMode.value === "single") {
    replayCurrent();
    return;
  }
  let nextIndex;
  if (playMode.value === "shuffle") {
    if (list.length === 1) nextIndex = 0;
    else {
      do {
        nextIndex = Math.floor(Math.random() * list.length);
      } while (nextIndex === index);
    }
  } else {
    nextIndex = index + 1;
    if (nextIndex >= list.length) {
      if (playMode.value === "loop" || !auto) nextIndex = 0;
      else {
        player.playing = false;
        return;
      }
    }
  }
  openMedia(list[nextIndex], { autoplay: true });
}

function prevMedia() {
  const list = playOrder.value;
  if (!list.length) return;
  const index = active.value ? list.findIndex((row) => row.id === active.value.id) : 0;
  const nextIndex = index <= 0 ? list.length - 1 : index - 1;
  openMedia(list[nextIndex], { autoplay: true });
}

function onEnded(event) {
  if (!isCurrentMedia(event)) return;
  player.playing = false;
  player.currentTime = player.duration;
  if (active.value) {
    forgetPosition(active.value);
    persist(active.value);
  }
  nextMedia({ auto: true });
}

function onMediaError(event) {
  if (streamMode.value) return;
  if (!isCurrentMedia(event)) return;
  const row = active.value;
  if (!row) return;
  player.playing = false;
  player.ready = false;
  if (!playRequested) {
    player.loading = false;
    return;
  }
  if (fallbackForId === row.id) {
    player.loading = false;
    player.error = "无法播放该媒体。自动流式转码和内置解码器都未能播放它。";
    return;
  }
  fallbackForId = row.id;
  player.error = null;
  player.loading = true;
  runAutoFallback(row);
}

async function runAutoFallback(row) {
  if (!active.value || active.value.id !== row.id) return;
  if (row.kind === "video") {
    const streamed = await streamAndPlay({ automatic: true });
    if (streamed) return;
    if (!active.value || active.value.id !== row.id) return;
    if ((row.size || 0) > 150 * 1024 * 1024) {
      player.loading = false;
      player.error = "无法播放该媒体。本机流式转码失败: " + (streamStatus.value || "未知错误");
      return;
    }
    decodeStatus.value = "流式播放不可用，改用内置解码器…";
    player.loading = true;
    await decodeAndPlay({ automatic: true });
    return;
  }
  decodeStatus.value = "使用内置解码器…";
  await decodeAndPlay({ automatic: true });
}


async function uploadForStream(source, name, token) {
  const size = source.size || source.byteLength || 0;
  if (!size) throw new Error("媒体数据为空");
  const initResponse = await fetch("/api/transcode/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ext: extOf(name) || "bin", size }),
  });
  if (!initResponse.ok) throw new Error("无法建立本机转码会话");
  const init = await initResponse.json();
  streamSessionId = init.id;
  const chunkSize = init.chunkSize || 8 * 1024 * 1024;
  try {
    for (let offset = 0; offset < size; offset += chunkSize) {
      if (token !== streamToken) throw new DOMException("Aborted", "AbortError");
      const end = Math.min(size, offset + chunkSize);
      const chunk = source.slice(offset, end);
      const controller = new AbortController();
      streamAbort = controller;
      const response = await fetch("/api/transcode/" + init.id + "/chunk", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
        signal: controller.signal,
      });
      if (streamAbort === controller) streamAbort = null;
      if (!response.ok) {
        let message = "上传失败 (" + response.status + ")";
        try {
          const body = await response.json();
          if (body && body.error) message = body.error;
        } catch {}
        throw new Error(message);
      }
      streamProgress.value = Math.round((end / size) * 100);
      streamStatus.value = "上传到本机转码服务 " + streamProgress.value + "%";
    }
    const startResponse = await fetch("/api/transcode/" + init.id + "/start", { method: "POST" });
    if (!startResponse.ok) {
      let message = "无法启动本机转码";
      try {
        const body = await startResponse.json();
        if (body && body.error) message = body.error;
      } catch {}
      throw new Error(message);
    }
    return init;
  } catch (error) {
    if (streamAbort) {
      try { streamAbort.abort(); } catch {}
      streamAbort = null;
    }
    if (error instanceof TypeError) throw new Error("无法连接本机转码服务");
    throw error;
  }
}

async function waitForStream(id, rowId, token) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (token !== streamToken || !active.value || active.value.id !== rowId) {
      throw new DOMException("Aborted", "AbortError");
    }
    const response = await fetch("/api/transcode/" + id + "/status", { cache: "no-store" });
    if (!response.ok) throw new Error("转码会话已结束");
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (data.ready) return data;
    streamStatus.value = data.segments ? "已生成 " + data.segments + " 段，等待首段可播…" : "转码中，等待首段…";
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("等待首段超时");
}

function failStream(message) {
  const mediaId = active.value && active.value.id;
  cleanupStreamResources({ keepSession: false });
  if (mediaId) forgetTranscodeRecord(mediaId);
  streamState.value = "error";
  streamStatus.value = message;
  player.loading = false;
  player.error = "无法播放该媒体。流式转码失败: " + message;
}

async function attachStream(playlist) {
  streamMode.value = true;
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = "";
  player.error = null;
  player.loading = true;
  player.ready = false;
  player.playing = false;
  player.currentTime = 0;
  player.duration = 0;
  pendingAutoplay.value = true;
  streamState.value = "starting";
  streamStatus.value = "首段已就绪，开始播放…";
  await nextTick();
  const video = videoRef.value;
  if (!video) throw new Error("视频元素未就绪");
  const { default: Hls } = await import("hls.js");
  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      maxBufferLength: 40,
      startPosition: pendingSeek.value > 0 ? pendingSeek.value : 0,
    });
    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(playlist));
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      applyPendingSeek(video);
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) failStream(data.details || "HLS 播放错误");
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = playlist;
    video.load();
    video.play().catch(() => {});
  } else {
    throw new Error("当前浏览器不支持 HLS 流式播放");
  }
}

async function streamAndPlay({ automatic = false } = {}) {
  if (streamBusy.value || decoding.value || !active.value) return false;
  if (active.value.kind !== "video") return false;
  const row = active.value;
  detachStreaming({ keepSession: true });
  const token = ++streamToken;
  player.error = null;
  player.loading = true;
  player.ready = false;
  player.playing = false;
  player.currentTime = pendingSeek.value || 0;
  player.duration = 0;
  pendingAutoplay.value = true;
  streamState.value = "transcoding";
  streamProgress.value = 0;
  streamStatus.value = "检查转码缓存…";
  try {
    const record = await readTranscodeRecord(row.id);
    if (record) {
      const cached = await transcodeRecordStatus(record);
      if (cached && !cached.error && (cached.ready || cached.status === "running" || cached.status === "done")) {
        streamSessionId = record.sessionId;
        streamStarted = true;
        streamStatus.value = cached.ready ? "恢复上次转码会话…" : "恢复转码，等待首段…";
        if (!cached.ready) await waitForStream(record.sessionId, row.id, token);
        if (token !== streamToken || !active.value || active.value.id !== row.id) return false;
        await attachStream(cached.playlist);
        return true;
      }
      await dropMediaTranscode(row.id);
    }
    const source = fileCache.get(row.id) || row.data || row.blob || null;
    if (!source) {
      player.loading = false;
      player.error = "媒体数据缺失，请重新导入。";
      return false;
    }
    streamState.value = "uploading";
    streamProgress.value = 0;
    streamStatus.value = "正在准备流式播放…";
    const result = await uploadForStream(source, row.name, token);
    if (token !== streamToken || !active.value || active.value.id !== row.id) return false;
    streamSessionId = result.id;
    streamStarted = true;
    await writeTranscodeRecord(row.id, result.id);
    streamState.value = "transcoding";
    streamProgress.value = 0;
    streamStatus.value = "转码中，等待首段…";
    const info = await waitForStream(result.id, row.id, token);
    if (token !== streamToken || !active.value || active.value.id !== row.id) return false;
    await attachStream(info.playlist);
    return true;
  } catch (error) {
    if (error && error.name === "AbortError") return false;
    if (token !== streamToken) return false;
    if (automatic) {
      cleanupStreamResources({ keepSession: false });
      await forgetTranscodeRecord(row.id);
      streamState.value = "error";
      streamStatus.value = error.message;
      player.loading = true;
      return false;
    }
    failStream(error.message);
    return false;
  }
}
async function decodeAndPlay({ automatic = false } = {}) {
  if (decoding.value || !active.value) return false;
  const row = active.value;
  dropStreaming();
  await dropMediaTranscode(row.id);
  const fileSource = fileCache.get(row.id) || row.blob || null;
  let source = row.data || null;
  if (!source && fileSource) source = await fileSource.arrayBuffer();
  if (!source) {
    player.loading = false;
    player.error = "媒体数据缺失，请重新导入。";
    return false;
  }
  decoding.value = true;
  decodeProgress.value = 0;
  decodeStatus.value = "准备内置解码器…";
  player.error = null;
  player.loading = true;
  player.ready = false;
  player.playing = false;
  try {
    const blob = await transcodeMedia({
      data: source,
      name: row.name,
      kind: row.kind,
      onProgress: (value) => {
        decodeProgress.value = value;
      },
      onStatus: (value) => {
        decodeStatus.value = value;
      },
    });
    if (!active.value || active.value.id !== row.id) return false;
    decodedCache.set(row.id, blob);
    if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
    objectUrl.value = URL.createObjectURL(blob);
    player.error = null;
    player.loading = true;
    player.ready = false;
    player.playing = false;
    player.currentTime = 0;
    player.duration = 0;
    pendingAutoplay.value = true;
    await nextTick();
    const el = mediaEl();
    if (el) {
      el.volume = player.volume;
      el.muted = player.muted;
      el.playbackRate = player.rate;
      el.load();
    }
    return true;
  } catch (error) {
    if (automatic) {
      player.loading = false;
      player.error = "无法播放该媒体。内置解码失败: " + error.message;
    }
    return false;
  } finally {
    decoding.value = false;
    decodeProgress.value = 0;
    decodeStatus.value = "";
  }
}

function togglePlay() {
  const el = mediaEl();
  if (!el) return;
  playRequested = true;
  if (active.value && active.value.kind === "audio") ensureAudioGraph();
  if (!objectUrl.value && !streamMode.value && active.value && active.value.kind === "video") {
    fallbackForId = active.value.id;
    player.loading = true;
    runAutoFallback(active.value);
    return;
  }
  if (el.paused) {
    el.play().catch(() => onMediaError({ currentTarget: el }));
  } else {
    el.pause();
  }
}

function onSeekInput(event) {
  const el = mediaEl();
  if (!el) return;
  const value = Number(event.target.value);
  el.currentTime = value;
  player.currentTime = value;
}

function onVolumeInput(event) {
  const el = mediaEl();
  if (!el) return;
  const value = Math.min(1, Math.max(0, Number(event.target.value)));
  el.volume = value;
  el.muted = value === 0;
  player.volume = value;
  player.muted = el.muted;
}

function toggleMute() {
  const el = mediaEl();
  if (!el) return;
  el.muted = !el.muted;
  player.muted = el.muted;
}

function applyRate() {
  const el = mediaEl();
  if (!el) return;
  el.playbackRate = player.rate;
}

function toggleFullscreen() {
  if (!playerRef.value) return;
  if (!document.fullscreenElement) playerRef.value.requestFullscreen().catch(() => {});
  else document.exitFullscreen().catch(() => {});
}

function closePlayer() {
  stopCurrent();
  active.value = null;
}

async function backToDeck() {
  stopCurrent();
  goHome();
}

function askRemove(row) {
  if (removeCandidate.value === row.id) {
    removeMedia(row);
    return;
  }
  removeCandidate.value = row.id;
  clearTimeout(removeTimer);
  removeTimer = setTimeout(() => {
    removeCandidate.value = null;
  }, 3200);
}

async function removeMedia(row) {
  removeCandidate.value = null;
  clearTimeout(removeTimer);
  if (active.value && active.value.id === row.id) {
    stopCurrent();
    active.value = null;
  }
  try {
    decodedCache.delete(row.id);
    fileCache.delete(row.id);
    forgetPosition(row);
    await dropMediaTranscode(row.id);
    await idbDelete("media", row.id);
    await refresh();
    notify("已从媒体库删除 · " + row.name, "info");
  } catch (error) {
    notify("删除失败: " + error.message, "error");
  }
}

function onKey(event) {
  if (!active.value) return;
  const tag = event.target && event.target.tagName ? event.target.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const el = mediaEl();
  if (!el) return;
  if (event.key === " " || event.key === "Spacebar") {
    event.preventDefault();
    togglePlay();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    el.currentTime = Math.min(player.duration || el.duration || 0, el.currentTime + 5);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    el.currentTime = Math.max(0, el.currentTime - 5);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    player.volume = Math.min(1, Math.round((player.volume + 0.1) * 100) / 100);
    el.volume = player.volume;
    el.muted = false;
    player.muted = false;
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    player.volume = Math.max(0, Math.round((player.volume - 0.1) * 100) / 100);
    el.volume = player.volume;
    player.muted = player.volume === 0;
    el.muted = player.muted;
  } else if (event.key === "m" || event.key === "M") {
    toggleMute();
  } else if (event.key === "f" || event.key === "F") {
    if (active.value.kind === "video") toggleFullscreen();
  }
}

const saveBeforeUnload = () => saveActivePosition();

onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", saveBeforeUnload);
  window.addEventListener("pagehide", saveBeforeUnload);
  document.addEventListener("fullscreenchange", onVisualFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onVisualFullscreenChange);
  refresh();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("beforeunload", saveBeforeUnload);
  window.removeEventListener("pagehide", saveBeforeUnload);
  document.removeEventListener("fullscreenchange", onVisualFullscreenChange);
  document.removeEventListener("webkitfullscreenchange", onVisualFullscreenChange);
  if (visualFullscreen.value && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  clearTimeout(fsTopTimer);
  clearTimeout(fsBottomTimer);
  clearTimeout(removeTimer);
  clearTimeout(folderRemoveTimer);
  if (persistTimer) clearTimeout(persistTimer);
  stopVisualizer();
  if (audioContext) {
    const context = audioContext;
    audioContext = null;
    analyser = null;
    sourceEl = null;
    sourceNode = null;
    context.close().catch(() => {});
  }
  stopCurrent();
});
</script>

<template>
  <div
    class="plugin plugin--media"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <header class="pluginbar">
      <button class="pluginbar__back" @click="backToDeck">← {{ t("common.back") }}</button>
      <div class="pluginbar__divider" />
      <div class="pluginbar__brand">
        <div class="pluginbar__mark pluginbar__mark--word" style="border-color: #6ea8fe; color: #6ea8fe">Media</div>
        <div>
          <div class="pluginbar__title">Media</div>
          <div class="pluginbar__sub">MEDIA PLAYER · LOCAL CODEC DECK</div>
        </div>
      </div>
      <div class="pluginbar__spacer" />
      <div class="media-stat">
        <span class="eyebrow">FILES</span>
        <b>{{ media.length }}</b>
        <span class="eyebrow">{{ formatBytes(totalBytes) }}</span>
      </div>
      <button class="btn-hazard" :disabled="importing" @click="pickFile">{{ importing ? "导入中…" : "导入媒体" }}</button>
      <button class="btn-ghost" :disabled="importing" @click="addFolder">添加文件夹</button>
    </header>

    <section class="media-shelf">
      <div class="media-layout">
        <div class="media-main">
          <div v-if="!active" class="media-drop panel panel--cut" :class="{ 'is-hot': dragging }" @click="pickFile">
            <div class="media-drop__glyph media-drop__glyph--word">Media</div>
            <div>
              <div class="eyebrow" style="color: #6ea8fe">LOCAL MEDIA · 本地播放</div>
              <h2 class="media-drop__title">把视频或音频拖进来，或点击选择文件</h2>
              <p class="media-drop__hint">
                支持 MP4 / M4V / WebM / MOV / MKV / TS / FLV / AVI / 3GP 与 MP3 / M4A / AAC / FLAC / WAV / OGG / Opus / WMA 等。
                浏览器原生能解码的会直接播放；不支持时会在播放器里给出编码提示。
              </p>
              <div class="media-drop__actions">
                <button class="btn-hazard" @click.stop="pickFile">选择媒体文件</button>
                <button class="btn-ghost" @click.stop="addFolder">添加文件夹</button>
              </div>
            </div>
          </div>

          <div v-else ref="playerRef" class="media-player panel">
            <div class="media-stage">
              <video
                v-if="active.kind === 'video'"
                ref="videoRef"
                :src="streamMode ? undefined : objectUrl"
                playsinline
                preload="metadata"
                @loadedmetadata="onLoadedMetadata"
                @durationchange="onDurationChange"
                @timeupdate="onTimeUpdate"
                @play="onPlay"
                @pause="onPause"
                @ended="onEnded"
                @error="onMediaError"
                @click="togglePlay"
              ></video>
              <div
                v-else
                ref="visualStageRef"
                class="media-audio"
                :class="{ 'is-playing': player.playing, 'is-fullscreen': visualFullscreen, 'fs-chrome-visible': visualFullscreen && (fsTopVisible || fsBottomVisible) }"
                @mousemove="onVisualPointer"
              >
                <canvas ref="visualizerRef" class="media-visual"></canvas>
                <div class="media-visual-picker" :class="{ 'is-fs-hidden': visualFullscreen && !fsTopVisible }">
                  <span class="eyebrow">VISUAL</span>
                  <select v-model="visualMode" class="media-visual-select" title="选择音频可视化效果">
                    <option v-for="mode in VISUAL_MODES" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
                  </select>
                  <button class="media-visual-fs" :title="visualFullscreen ? '退出全屏' : '全屏可视化'" @click="toggleVisualFullscreen">
                    {{ visualFullscreen ? "退出" : "全屏" }}
                  </button>
                </div>
                <button v-if="visualFullscreen" class="media-visual-exit" :class="{ 'is-fs-hidden': !fsTopVisible }" title="退出全屏" @click="toggleVisualFullscreen">×</button>
                <div v-if="visualFullscreen" class="media-fs-bottom" :class="{ 'is-visible': fsBottomVisible }">
                  <div class="media-fs-info">
                    <div class="eyebrow">NOW PLAYING · 当前媒体</div>
                    <strong>{{ active.name }}</strong>
                    <span>{{ active.type || "音频" }} · {{ formatBytes(active.size) }}</span>
                  </div>
                  <div class="media-fs-progress">
                    <button class="media-fs-play" :title="player.playing ? '暂停' : '播放'" @click="togglePlay">
                      {{ player.playing ? "❚❚" : "▶" }}
                    </button>
                    <span>{{ formatTime(player.currentTime) }}</span>
                    <input
                      class="media-fs-seek"
                      type="range"
                      min="0"
                      :max="player.duration || 0"
                      step="0.1"
                      :value="player.currentTime"
                      @input="onSeekInput"
                    />
                    <span>{{ formatTime(player.duration) }}</span>
                  </div>
                </div>
                <audio
                  ref="audioRef"
                  :src="objectUrl"
                  preload="metadata"
                  @loadedmetadata="onLoadedMetadata"
                  @durationchange="onDurationChange"
                  @timeupdate="onTimeUpdate"
                  @play="onPlay"
                  @pause="onPause"
                  @ended="onEnded"
                  @error="onMediaError"
                ></audio>
              </div>
              <div v-if="player.loading && !player.error" class="media-overlay media-overlay--loading">
                <div class="led led--amber">
                  <i />{{ streamBusy ? streamStatus || "正在准备流式播放…" : decoding ? decodeStatus || "内置解码器处理中…" : "正在读取媒体 …" }}
                </div>
                <div v-if="streamBusy || decoding" class="media-decode__bar">
                  <i
                    :style="{ width: streamBusy ? (streamState === 'uploading' ? streamProgress + '%' : '100%') : decoding ? Math.round(decodeProgress * 100) + '%' : '0%' }"
                    :class="{ 'is-pulse': (streamBusy && streamState !== 'uploading') || (decoding && decodeProgress === 0) }"
                  />
                </div>
                <button v-if="streamBusy || decoding" class="btn-ghost" @click="closePlayer">取消</button>
              </div>
              <div v-if="player.error" class="media-overlay media-overlay--error">
                <div>⚠ {{ player.error }}</div>
                <div class="media-decode__hint">已自动尝试本机 ffmpeg 流式转码和内置解码器。</div>
                <button class="btn-ghost" @click="closePlayer">关闭播放器</button>
              </div>
            </div>

            <div class="media-controls">
              <button class="media-icon-btn" title="上一个" @click="prevMedia">⏮</button>
              <button class="media-play" :title="player.playing ? '暂停' : '播放'" @click="togglePlay">
                {{ player.playing ? "❚❚" : "▶" }}
              </button>
              <button class="media-icon-btn" title="下一个" @click="nextMedia()">⏭</button>
              <span class="media-time">{{ formatTime(player.currentTime) }}</span>
              <input
                class="media-seek"
                type="range"
                min="0"
                :max="player.duration || 0"
                step="0.1"
                :value="player.currentTime"
                @input="onSeekInput"
              />
              <span class="media-time">{{ formatTime(player.duration) }}</span>
              <button class="media-icon-btn" :title="player.muted ? '取消静音' : '静音'" @click="toggleMute">
                {{ player.muted || player.volume === 0 ? "🔇" : "🔊" }}
              </button>
              <input
                class="media-volume"
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="player.volume"
                @input="onVolumeInput"
              />
              <select v-model.number="player.rate" class="media-rate" @change="applyRate">
                <option :value="0.5">0.5×</option>
                <option :value="0.75">0.75×</option>
                <option :value="1">1×</option>
                <option :value="1.25">1.25×</option>
                <option :value="1.5">1.5×</option>
                <option :value="2">2×</option>
              </select>
              <button v-if="active.kind === 'video'" class="btn-ghost" @click="toggleFullscreen">全屏</button>
              <button class="btn-ghost" @click="closePlayer">关闭</button>
            </div>
          </div>

          <div v-if="active" class="media-now">
            <div>
              <div class="eyebrow">NOW PLAYING · 当前媒体</div>
              <div class="media-now__title">{{ active.name }}</div>
            </div>
            <div class="media-now__meta">
              {{ active.kind === "video" ? "VIDEO" : "AUDIO" }} · {{ active.type || "未知类型" }} · {{ formatBytes(active.size) }}
            </div>
          </div>
        </div>

        <aside class="media-playlist panel">
          <div class="media-playlist__head">
            <div>
              <div class="eyebrow">PLAYLIST · 播放列表</div>
              <h3 class="media-playlist__title">{{ media.length }} 个媒体</h3>
            </div>
            <div class="media-playlist__actions">
              <button class="mini-btn" :disabled="importing" @click="pickFile">＋ 文件</button>
              <button class="mini-btn" :disabled="importing" @click="addFolder">＋ 文件夹</button>
            </div>
          </div>

          <div class="media-playlist__mode">
            <span class="eyebrow">播放模式</span>
            <select v-model="playMode" class="media-mode" title="决定一个媒体播放完后如何继续">
              <option v-for="mode in PLAY_MODES" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
            </select>
          </div>

          <div class="hazard" style="opacity: 0.45; margin: 12px 0"></div>

          <div v-if="folderImporting" class="media-folder-status">
            <span class="led led--amber"><i />{{ folderStatus || "导入文件夹…" }}</span>
          </div>

          <div v-if="!media.length" class="media-playlist__empty">
            还没有媒体。<br />
            导入文件，或添加一个文件夹；非媒体文件会被忽略。
          </div>
          <div v-else class="media-tree">
            <template v-for="node in treeRows" :key="node.key">
              <div
                v-if="node.type === 'folder' || node.type === 'dir'"
                class="media-tree-folder"
                :style="{ paddingLeft: (6 + node.depth * 12) + 'px' }"
                @click="toggleTree(node.key)"
              >
                <span class="media-tree__toggle">{{ collapsed.has(node.key) ? "▸" : "▾" }}</span>
                <span class="media-tree__name" :title="node.name">{{ node.name }}</span>
                <span class="media-tree__count">{{ node.count }}</span>
                <button
                  v-if="node.type === 'folder' && node.folder"
                  class="media-tree__rescan"
                  :disabled="rescanningFolder === node.folder.id"
                  :title="node.folder.handle ? '重新扫描目录，同步新增 / 删除 / 修改的文件' : '首次重扫会要求选择目录并保存句柄，之后可直接重扫'"
                  @click.stop="rescanFolder(node.folder)"
                >
                  {{ rescanningFolder === node.folder.id ? "重扫中" : "重扫" }}
                </button>
                <button
                  v-if="node.type === 'folder' && node.folder"
                  class="media-tree__remove"
                  :class="{ 'is-confirm': folderRemoveCandidate === node.folder.id }"
                  :title="folderRemoveCandidate === node.folder.id ? '再次点击确认移除目录' : '从媒体库移除目录（不删磁盘文件）'"
                  @click.stop="askRemoveFolder(node.folder)"
                >
                  {{ folderRemoveCandidate === node.folder.id ? "确认" : "移除" }}
                </button>
              </div>
              <article
                v-else
                class="media-row"
                :class="{ 'is-active': active && active.id === node.row.id }"
                :style="{ marginLeft: (node.depth * 12) + 'px' }"
                @click="active && active.id === node.row.id ? togglePlay() : openMedia(node.row, { autoplay: true })"
              >
                <div class="media-row__kind" :class="'is-' + node.row.kind">{{ node.row.kind === "video" ? "VID" : "AUD" }}</div>
                <div class="media-row__body">
                  <div class="media-row__name" :title="node.row.relativePath || node.row.name">{{ node.row.name }}</div>
                  <div class="media-row__meta">
                    {{ node.row.duration ? formatTime(node.row.duration) : formatBytes(node.row.size) }}
                    <span v-if="active && active.id === node.row.id && player.playing"> · PLAYING</span>
                  </div>
                </div>
                <button
                  class="media-row__remove"
                  :class="{ 'is-confirm': removeCandidate === node.row.id }"
                  :title="removeCandidate === node.row.id ? '再次点击确认删除' : '从媒体库删除'"
                  @click.stop="askRemove(node.row)"
                >
                  {{ removeCandidate === node.row.id ? "确认" : "删除" }}
                </button>
              </article>
            </template>
          </div>

          <details class="media-formats">
            <summary>支持格式 / CODECS</summary>
            <div v-for="group in FORMAT_GROUPS" :key="group.group" class="format-group">
              <div class="eyebrow" style="margin: 10px 0 6px">{{ group.group }}</div>
              <div v-for="row in group.rows" :key="row.label" class="format-row">
                <span class="format-row__name">{{ row.label }}</span>
                <span class="format-row__codec">{{ row.codec }}</span>
                <span class="format-badge" :class="'is-' + row.support.level">{{ row.support.label }}</span>
              </div>
            </div>
            <p class="media-formats__note">
              是否可播最终取决于浏览器和系统解码器；显示“需转码”的格式仍可导入尝试，失败时播放器会提示。
            </p>
          </details>

          <p class="media-playlist__note">媒体文件保留在原目录，不会复制进 data/ 或 App 包。索引与播放进度保存在应用本地存储（不在 data/）；只有“边转码边播放”的临时分片会发给本机 127.0.0.1，不上传外网。</p>
        </aside>
      </div>

      <input
        ref="fileInput"
        type="file"
        multiple
        hidden
        accept="video/*,audio/*,.mp4,.m4v,.webm,.mov,.mkv,.ts,.flv,.f4v,.mxf,.avi,.3gp,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus,.wma,.alac"
        @change="onFileChange"
      />
      <input
        ref="folderInput"
        type="file"
        webkitdirectory
        multiple
        hidden
        accept="video/*,audio/*,.mp4,.m4v,.webm,.mov,.mkv,.ts,.flv,.f4v,.mxf,.avi,.3gp,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus,.wma,.alac"
        @change="onFolderChange"
      />
      <p class="media-note">
        播放列表和文件都只在本机；添加文件夹时会递归扫描，跳过非媒体文件。“移除目录”只移除媒体库副本，不删除磁盘上的文件。浏览器原生不支持时会自动边转码边播放，没有本机 ffmpeg 时才使用内置解码器。
      </p>
    </section>
  </div>
</template>

<style scoped>
.plugin--media { flex: 1; display: flex; flex-direction: column; min-height: calc(100vh - 70px); }
.media-stat { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--bone-dim); }
.media-stat b { color: #6ea8fe; font-size: 18px; }
.media-shelf { width: 100%; max-width: 1560px; margin: 0 auto; padding: 24px 26px 70px; }
.media-layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; align-items: start; }
.media-main { min-width: 0; }

.media-drop {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 30px;
  cursor: pointer;
  border-style: dashed;
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
}
.media-drop:hover,
.media-drop.is-hot {
  border-color: #6ea8fe;
  background: linear-gradient(120deg, rgba(110, 168, 254, 0.12), transparent 62%), var(--panel);
  transform: translateY(-2px);
}
.media-drop__glyph {
  flex: 0 0 auto;
  width: 96px;
  height: 96px;
  display: grid;
  place-items: center;
  border: 1px solid #6ea8fe;
  color: #6ea8fe;
  font-family: var(--display);
  font-size: 30px;
  letter-spacing: 0.04em;
  background: linear-gradient(155deg, rgba(110, 168, 254, 0.18), transparent);
  clip-path: polygon(0 0, 100% 0, 100% 78%, 78% 100%, 0 100%);
}
.media-drop__glyph--word { font-size: 22px; letter-spacing: 0.02em; }
.media-drop__title { margin: 6px 0 0; font-family: var(--display); font-size: 26px; letter-spacing: 0.04em; color: var(--bone); }
.media-drop__hint { margin: 8px 0 0; max-width: 760px; font-size: 12.5px; line-height: 1.85; color: var(--muted); }
.media-drop__actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }

.media-player { overflow: hidden; }
.media-stage {
  position: relative;
  min-height: 420px;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(60% 50% at 50% 0%, rgba(110, 168, 254, 0.08), transparent 64%),
    #070605;
}
.media-stage video {
  display: block;
  width: 100%;
  max-height: 66vh;
  object-fit: contain;
  background: #000;
  cursor: pointer;
}
.media-audio {
  position: relative;
  width: 100%;
  min-height: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  overflow: hidden;
  background:
    radial-gradient(45% 55% at 50% 45%, rgba(110, 168, 254, 0.16), transparent 70%),
    repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.018) 0 8px, transparent 8px 16px);
}
.media-visual {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}
.media-audio__overlay {
  position: relative;
  z-index: 1;
  width: min(86%, 760px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  pointer-events: none;
  text-align: center;
  text-shadow: 0 2px 18px #000, 0 0 40px #000;
}
.media-visual-picker {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border: 1px solid var(--line);
  background: rgba(10, 9, 7, 0.8);
  backdrop-filter: blur(4px);
  transition: opacity 0.28s ease, transform 0.28s ease;
}
.media-visual-select {
  border: 1px solid var(--line-soft);
  background: #0b0a08;
  color: var(--bone-dim);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  padding: 3px 5px;
  outline: none;
}
.media-visual-select:focus { border-color: #6ea8fe; }
.media-visual-fs {
  border: 1px solid var(--line-soft);
  background: transparent;
  color: var(--bone-dim);
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  padding: 3px 5px;
  cursor: pointer;
}
.media-visual-fs:hover { border-color: #6ea8fe; color: #6ea8fe; }
.media-visual-exit {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 3;
  width: 36px;
  height: 36px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(7, 6, 5, 0.55);
  color: #fff;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
  transition: opacity 0.28s ease, transform 0.28s ease;
}
.media-visual-exit:hover { border-color: #6ea8fe; color: #6ea8fe; }
.media-visual-picker.is-fs-hidden,
.media-visual-exit.is-fs-hidden {
  opacity: 0;
  pointer-events: none;
  transform: translateY(-8px);
}
.media-audio.is-fullscreen { cursor: none; }
.media-audio.is-fullscreen.fs-chrome-visible { cursor: default; }
.media-fs-bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 4;
  padding: 34px 28px 24px;
  background: linear-gradient(0deg, rgba(5, 4, 3, 0.96), rgba(5, 4, 3, 0.72) 58%, transparent);
  opacity: 0;
  transform: translateY(18px);
  pointer-events: none;
  transition: opacity 0.32s ease, transform 0.32s ease;
}
.media-fs-bottom.is-visible {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.media-fs-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 14px;
  text-shadow: 0 2px 18px #000;
}
.media-fs-info strong {
  font-family: var(--display);
  font-size: clamp(22px, 3vw, 38px);
  line-height: 1.05;
  color: var(--bone);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.media-fs-info span { font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; color: var(--muted); }
.media-fs-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--bone-dim);
}
.media-fs-play {
  flex: 0 0 auto;
  width: 40px;
  height: 36px;
  border: 1px solid #6ea8fe;
  background: rgba(110, 168, 254, 0.15);
  color: #6ea8fe;
  font-size: 13px;
  cursor: pointer;
}
.media-fs-play:hover { background: #6ea8fe; color: #07101f; }
.media-fs-seek {
  flex: 1;
  accent-color: #6ea8fe;
  height: 4px;
}
.media-audio:fullscreen .media-visual-picker,
.media-audio:-webkit-full-screen .media-visual-picker {
  top: 18px;
  right: 18px;
}
.media-audio:fullscreen,
.media-audio:-webkit-full-screen {
  width: 100vw;
  height: 100vh;
  min-height: 100vh;
  background: #000;
}
.media-audio:fullscreen .media-visual-picker,
.media-audio:-webkit-full-screen .media-visual-picker {
  top: 18px;
  right: 18px;
}
.media-audio:fullscreen .media-visual,
.media-audio:-webkit-full-screen .media-visual {
  width: 100%;
  height: 100%;
}
.media-audio__glyph {
  width: 110px;
  height: 110px;
  display: grid;
  place-items: center;
  border: 1px solid #6ea8fe;
  color: #6ea8fe;
  font-family: var(--display);
  font-size: 52px;
  background: rgba(110, 168, 254, 0.08);
  clip-path: polygon(0 0, 100% 0, 100% 78%, 78% 100%, 0 100%);
}
.media-audio__title { font-family: var(--display); font-size: 27px; color: var(--bone); max-width: 76%; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.media-audio__meta { font-size: 11.5px; letter-spacing: 0.06em; color: var(--muted); }
.media-eq { display: flex; align-items: flex-end; gap: 3px; height: 30px; margin-top: 8px; }
.media-eq i { width: 3px; height: 8px; background: #6ea8fe; opacity: 0.4; }
.media-audio.is-playing .media-eq i { animation: media-eq 0.9s ease-in-out infinite alternate; opacity: 0.9; }
.media-eq i:nth-child(2n) { animation-delay: 0.18s; }
.media-eq i:nth-child(3n) { animation-delay: 0.32s; }
@keyframes media-eq { from { height: 6px; } to { height: 28px; } }

.media-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(7, 6, 5, 0.78);
  z-index: 2;
  padding: 24px;
}
.media-overlay--loading { flex-direction: column; gap: 14px; text-align: center; }
.media-overlay--error { flex-direction: column; gap: 14px; color: #f0b3a8; font-size: 13px; text-align: center; }
.media-decode { width: min(460px, 94%); display: flex; flex-direction: column; align-items: center; gap: 8px; }
.media-decode__bar { width: 100%; height: 4px; border: 1px solid var(--line); background: #0b0a08; }
.media-decode__bar i { display: block; height: 100%; background: #6ea8fe; box-shadow: 0 0 10px -2px #6ea8fe; transition: width 0.2s linear; }
.media-overlay--loading .media-decode__bar { width: min(340px, 72vw); }
.media-decode__bar i.is-pulse { animation: media-pulse 1.1s ease-in-out infinite alternate; }
@keyframes media-pulse { from { opacity: 0.35; } to { opacity: 1; } }
.media-decode__status { font-size: 11px; letter-spacing: 0.06em; color: var(--bone-dim); }
.media-decode__hint { font-size: 10px; line-height: 1.7; color: var(--muted); max-width: 420px; }

.media-controls {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  background: #0e0c09;
}
.media-play {
  flex: 0 0 auto;
  width: 40px;
  height: 36px;
  border: 1px solid var(--amber);
  background: var(--amber);
  color: #14110d;
  font-size: 15px;
  cursor: pointer;
}
.media-play:hover { background: #ffc233; }
.media-time { flex: 0 0 auto; min-width: 46px; font-size: 11px; color: var(--bone-dim); letter-spacing: 0.04em; text-align: center; }
.media-seek { flex: 1 1 180px; min-width: 120px; accent-color: var(--amber); }
.media-volume { flex: 0 0 74px; accent-color: #6ea8fe; }
.media-icon-btn { flex: 0 0 auto; border: 0; background: transparent; color: var(--bone-dim); font-size: 15px; cursor: pointer; padding: 2px 3px; }
.media-rate {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  background: #0b0a08;
  color: var(--bone-dim);
  font-family: var(--mono);
  font-size: 11px;
  padding: 6px 7px;
}
.media-now {
  margin-top: 12px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 0 2px;
}
.media-now__title { margin-top: 4px; font-size: 14px; color: var(--bone); }
.media-now__meta { font-size: 10.5px; letter-spacing: 0.06em; color: var(--muted); }

.media-playlist { position: sticky; top: 18px; padding: 16px; max-height: calc(100vh - 36px); overflow: auto; }
.media-playlist__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
.media-playlist__title { margin: 4px 0 0; font-family: var(--display); font-size: 24px; letter-spacing: 0.05em; color: var(--bone); }
.media-playlist__actions { display: flex; gap: 5px; flex-wrap: wrap; }
.media-playlist__actions .mini-btn { flex: 0 0 auto; padding: 7px 8px; }
.media-playlist__mode { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
.media-mode {
  border: 1px solid var(--line);
  background: #0b0a08;
  color: var(--bone-dim);
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  padding: 5px 6px;
  outline: none;
}
.media-mode:focus { border-color: #6ea8fe; }
.media-folder-status {
  margin-bottom: 10px;
  padding: 6px 8px;
  border: 1px solid var(--line-soft);
  background: rgba(110, 168, 254, 0.05);
  font-size: 10.5px;
  color: var(--bone-dim);
}
.media-playlist__empty { border: 1px dashed var(--line); padding: 18px 12px; font-size: 12px; line-height: 1.8; color: var(--muted); text-align: center; }
.media-tree { display: flex; flex-direction: column; gap: 5px; }
.media-tree-folder {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px;
  border: 1px solid transparent;
  color: var(--bone-dim);
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
  user-select: none;
}
.media-tree-folder:hover { border-color: var(--line); background: rgba(255, 255, 255, 0.02); }
.media-tree__toggle { flex: 0 0 auto; width: 12px; color: #6ea8fe; }
.media-tree__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bone); }
.media-tree__count { flex: 0 0 auto; font-size: 9.5px; color: var(--muted); border: 1px solid var(--line-soft); padding: 1px 5px; }
.media-tree__rescan {
  flex: 0 0 auto;
  margin-left: auto;
  border: 1px solid var(--line-soft);
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9px;
  padding: 3px 4px;
  cursor: pointer;
}
.media-tree__rescan:hover { border-color: #6ea8fe; color: #6ea8fe; }
.media-tree__rescan:disabled { opacity: 0.5; cursor: wait; }
.media-tree__remove {
  flex: 0 0 auto;
  margin-left: 0;
  border: 1px solid var(--line-soft);
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9px;
  padding: 3px 4px;
  cursor: pointer;
}
.media-tree__remove:hover,
.media-tree__remove.is-confirm { border-color: var(--danger); color: var(--danger); }
.media-tree .media-row { margin-bottom: 1px; }
.media-list { display: flex; flex-direction: column; gap: 7px; }
.media-row {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  padding: 8px;
  border: 1px solid var(--line-soft);
  background: #0e0c09;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.media-row:hover { border-color: #6ea8fe; background: rgba(110, 168, 254, 0.05); }
.media-row.is-active { border-color: #6ea8fe; box-shadow: inset 2px 0 0 #6ea8fe; }
.media-row__kind {
  width: 38px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  font-size: 9px;
  letter-spacing: 0.08em;
}
.media-row__kind.is-video { color: #6ea8fe; border-color: rgba(110, 168, 254, 0.5); }
.media-row__kind.is-audio { color: var(--tox); border-color: rgba(158, 203, 59, 0.45); }
.media-row__body { min-width: 0; }
.media-row__name { font-size: 12px; color: var(--bone); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.media-row__meta { margin-top: 3px; font-size: 10px; letter-spacing: 0.05em; color: var(--muted); }
.media-row__remove {
  border: 1px solid var(--line-soft);
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9.5px;
  padding: 4px 5px;
  cursor: pointer;
}
.media-row__remove:hover,
.media-row__remove.is-confirm { border-color: var(--danger); color: var(--danger); }

.media-formats { margin-top: 16px; border-top: 1px solid var(--line-soft); padding-top: 12px; }
.media-formats summary { font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); cursor: pointer; }
.format-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr) auto; gap: 8px; align-items: center; padding: 3px 0; border-bottom: 1px dashed rgba(42, 36, 27, 0.55); }
.format-row__name { font-size: 10.5px; color: var(--bone-dim); }
.format-row__codec { font-size: 9.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.format-badge { font-size: 9px; letter-spacing: 0.04em; padding: 1px 5px; border: 1px solid var(--line); color: var(--muted); }
.format-badge.is-native { color: var(--tox); border-color: rgba(158, 203, 59, 0.45); }
.format-badge.is-maybe { color: var(--amber); border-color: rgba(255, 176, 0, 0.45); }
.format-badge.is-no { color: var(--rust); border-color: rgba(194, 84, 42, 0.5); }
.media-formats__note { margin: 10px 0 0; font-size: 10px; line-height: 1.7; color: var(--muted); }
.media-playlist__note { margin: 14px 0 0; padding-top: 10px; border-top: 1px dashed var(--line-soft); font-size: 10px; line-height: 1.7; color: var(--muted); }
.media-note { margin-top: 24px; font-size: 11px; line-height: 1.8; letter-spacing: 0.06em; color: var(--muted); }
@media (max-width: 720px) {
  .media-playlist__head { flex-direction: column; }
  .media-playlist__actions { width: 100%; }
  .media-playlist__actions .mini-btn { flex: 1; }
}

.media-player:fullscreen { display: flex; flex-direction: column; background: #050403; }
.media-player:fullscreen .media-stage { flex: 1; min-height: 0; }
.media-player:fullscreen .media-stage video { width: 100%; height: 100%; max-height: none; }

@media (max-width: 1080px) {
  .media-layout { grid-template-columns: 1fr; }
  .media-playlist { position: static; max-height: none; order: 2; }
}
@media (max-width: 720px) {
  .media-shelf { padding: 18px 14px 60px; }
  .media-drop { flex-direction: column; align-items: flex-start; }
  .media-stage { min-height: 280px; }
  .media-controls { gap: 7px; }
  .media-seek { flex-basis: 140px; }
}
</style>
