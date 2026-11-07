import { computed, ref } from "vue";

const STORAGE_KEY = "wasteland.background.v1";
const DEFAULT_ID = "preset:wasteland-dunes.svg";
const NONE_ID = "none";
const DEFAULT_URL = "/backgrounds/preset/wasteland-dunes.svg";
const defaultItem = { id: DEFAULT_ID, kind: "preset", name: "废土沙丘", description: "落日、台地与荒原公路", url: DEFAULT_URL };

const presets = ref([]);
const custom = ref([]);
const selectedId = ref(localStorage.getItem(STORAGE_KEY) || DEFAULT_ID);
const customDir = ref("~/.wasteland_browser/bg_screens");
const loading = ref(false);
const uploading = ref(false);
const loaded = ref(false);

const all = computed(() => [...presets.value, ...custom.value]);
const isNone = computed(() => selectedId.value === NONE_ID);
const current = computed(() => {
  if (isNone.value) return null;
  return all.value.find((item) => item.id === selectedId.value) || presets.value[0] || defaultItem;
});
const backgroundStyle = computed(() => (isNone.value ? {} : { backgroundImage: "url(" + JSON.stringify(current.value.url) + ")" }));
const isDefault = computed(() => !selectedId.value || selectedId.value === (presets.value[0] && presets.value[0].id) || selectedId.value === DEFAULT_ID);

function persist() {
  try {
    if (selectedId.value) localStorage.setItem(STORAGE_KEY, selectedId.value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

async function loadBackgrounds() {
  loading.value = true;
  try {
    const response = await fetch("/api/backgrounds", { cache: "no-store" });
    if (!response.ok) throw new Error("背景列表读取失败");
    const data = await response.json();
    presets.value = Array.isArray(data.presets) ? data.presets : [];
    custom.value = Array.isArray(data.custom) ? data.custom : [];
    customDir.value = data.customDir || customDir.value;
    if (!isNone.value && !all.value.some((item) => item.id === selectedId.value)) {
      selectedId.value = data.defaultId || (presets.value[0] && presets.value[0].id) || DEFAULT_ID;
      persist();
    }
    loaded.value = true;
  } catch {
    if (!presets.value.length) presets.value = [defaultItem];
  } finally {
    loading.value = false;
  }
}

function selectBackground(item) {
  if (!item) return;
  selectedId.value = item.id;
  persist();
}

function selectNoBackground() {
  selectedId.value = NONE_ID;
  persist();
}

function resetBackground() {
  selectedId.value = presets.value[0] ? presets.value[0].id : DEFAULT_ID;
  persist();
}

async function uploadBackground(file) {
  if (!file) return null;
  uploading.value = true;
  try {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const response = await fetch("/api/backgrounds", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Background-Ext": ext,
      },
      body: file,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || "背景上传失败");
    await loadBackgrounds();
    if (data.item) selectBackground(data.item);
    return data.item;
  } finally {
    uploading.value = false;
  }
}

async function removeCustom(item) {
  if (!item || item.kind !== "custom") return;
  const response = await fetch("/api/backgrounds/" + encodeURIComponent(item.file), { method: "DELETE" });
  if (!response.ok) throw new Error("删除背景失败");
  if (selectedId.value === item.id) resetBackground();
  await loadBackgrounds();
}

export function useBackgrounds() {
  return {
    presets,
    custom,
    current,
    selectedId,
    isNone,
    customDir,
    loading,
    uploading,
    loaded,
    backgroundStyle,
    isDefault,
    loadBackgrounds,
    selectBackground,
    selectNoBackground,
    resetBackground,
    uploadBackground,
    removeCustom,
  };
}
