<script setup>
import { ref } from "vue";
import { useBackgrounds } from "@/stores/backgrounds";
import { notify } from "@/stores/ui";
import { locale, t } from "@/i18n";

const {
  presets,
  custom,
  current,
  customDir,
  loading,
  uploading,
  isDefault,
  loadBackgrounds,
  selectBackground,
  resetBackground,
  uploadBackground,
  removeCustom,
} = useBackgrounds();

const open = ref(false);
const deleting = ref("");
const uploadInput = ref(null);

function nameOf(item) {
  return locale.value === "en" ? item.nameEn || item.name : item.name;
}
function descriptionOf(item) {
  return locale.value === "en" ? item.descriptionEn || item.description || "" : item.description || "";
}

function toggle() {
  open.value = !open.value;
  if (open.value && !presets.value.length) loadBackgrounds();
}

function pickFile() {
  if (uploadInput.value) uploadInput.value.click();
}

async function onFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (!/^image\/(jpeg|png|webp|avif|gif)$/i.test(file.type)) {
    notify(t("background.onlyFormats"), "error");
    return;
  }
  try {
    await uploadBackground(file);
    notify(t("background.saved"), "success");
  } catch (error) {
    notify(error.message, "error");
  }
}

async function remove(item) {
  if (deleting.value === item.id) {
    try {
      await removeCustom(item);
      notify(t("background.deleted"), "info");
    } catch (error) {
      notify(error.message, "error");
    }
    deleting.value = "";
    return;
  }
  deleting.value = item.id;
  setTimeout(() => {
    if (deleting.value === item.id) deleting.value = "";
  }, 3000);
}
</script>

<template>
  <div class="bg-picker">
    <button class="bg-trigger" :class="{ 'is-open': open }" @click="toggle">
      <span class="bg-trigger__swatch" :style="{ backgroundImage: current ? 'url(' + current.url + ')' : 'none' }" />
      <span>{{ t("background.trigger") }}</span>
    </button>

    <div v-if="open" class="bg-backdrop" @click="open = false" />

    <section v-if="open" class="bg-panel panel">
      <header class="bg-panel__head">
        <div>
          <div class="eyebrow">{{ t("background.eyebrow") }}</div>
          <h3 class="bg-panel__title">{{ t("background.title") }}</h3>
        </div>
        <button class="bg-panel__close" :title="t('background.close')" @click="open = false">×</button>
      </header>

      <p class="bg-panel__hint">{{ t("background.hint", { path: customDir }) }}</p>

      <div class="bg-group-label">{{ t("background.presets") }}</div>
      <div class="bg-grid">
        <button
          v-for="item in presets"
          :key="item.id"
          class="bg-card"
          :class="{ 'is-active': current && current.id === item.id }"
          :title="descriptionOf(item) || nameOf(item)"
          @click="selectBackground(item)"
        >
          <span class="bg-card__img" :style="{ backgroundImage: 'url(' + item.url + ')' }" />
          <span class="bg-card__name">{{ nameOf(item) }}</span>
          <span v-if="current && current.id === item.id" class="bg-card__badge">{{ t("background.inUse") }}</span>
        </button>
      </div>

      <div class="bg-group-label">{{ t("background.custom") }}</div>
      <div v-if="!custom.length" class="bg-empty">{{ t("background.empty") }}</div>
      <div v-else class="bg-grid">
        <button
          v-for="item in custom"
          :key="item.id"
          class="bg-card"
          :class="{ 'is-active': current && current.id === item.id }"
          @click="selectBackground(item)"
        >
          <span class="bg-card__img" :style="{ backgroundImage: 'url(' + item.url + ')' }" />
          <span class="bg-card__name">{{ nameOf(item) }}</span>
          <span v-if="current && current.id === item.id" class="bg-card__badge">{{ t("background.inUse") }}</span>
          <span
            class="bg-card__delete"
            :class="{ 'is-confirm': deleting === item.id }"
            :title="t('background.delete')"
            @click.stop="remove(item)"
          >{{ deleting === item.id ? t("background.confirmDelete") : t("background.delete") }}</span>
        </button>
      </div>

      <div class="bg-panel__actions">
        <button class="mini-btn is-primary" :disabled="uploading" @click="pickFile">
          {{ uploading ? t("background.uploading") : t("background.upload") }}
        </button>
        <button class="mini-btn" @click="resetBackground">{{ t("background.reset") }}</button>
        <button class="mini-btn" :disabled="loading" @click="loadBackgrounds">{{ t("background.refresh") }}</button>
      </div>
      <p class="bg-panel__path">{{ t("background.customDir", { path: customDir }) }}</p>

      <input ref="uploadInput" type="file" hidden accept="image/jpeg,image/png,image/webp,image/avif,image/gif" @change="onFile" />
    </section>
  </div>
</template>

<style scoped>
.bg-picker { position: relative; z-index: 55; }
.bg-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 10px 0 6px;
  border: 1px solid var(--line);
  background: rgba(12, 10, 8, 0.84);
  color: var(--bone-dim);
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  cursor: pointer;
}
.bg-trigger:hover, .bg-trigger.is-open { border-color: var(--amber); color: var(--amber); }
.bg-trigger__swatch { width: 22px; height: 22px; display: block; border: 1px solid var(--line); background-size: cover; background-position: center; }
.bg-backdrop { position: fixed; inset: 0; z-index: 54; background: rgba(4, 3, 2, 0.48); backdrop-filter: blur(2px); }
.bg-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 56;
  width: min(560px, calc(100vw - 28px));
  max-height: min(76vh, 760px);
  overflow: auto;
  padding: 18px;
  background: linear-gradient(150deg, #17130e, #0c0a08 78%);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.7);
}
.bg-panel__head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.bg-panel__title { margin: 4px 0 0; font-family: var(--display); font-size: 25px; letter-spacing: 0.04em; color: var(--bone); }
.bg-panel__close { border: 0; background: transparent; color: var(--muted); font-size: 26px; line-height: 1; cursor: pointer; }
.bg-panel__close:hover { color: var(--danger); }
.bg-panel__hint { margin: 10px 0 14px; font-size: 11px; line-height: 1.8; color: var(--muted); }
.bg-panel__hint code, .bg-panel__path code { color: var(--amber); font-family: var(--mono); font-size: 10px; }
.bg-group-label { margin: 12px 0 8px; color: var(--amber); font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; }
.bg-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.bg-card { position: relative; display: flex; flex-direction: column; gap: 5px; padding: 4px; border: 1px solid var(--line); background: #0b0907; color: var(--bone-dim); cursor: pointer; text-align: left; }
.bg-card:hover, .bg-card.is-active { border-color: var(--amber); }
.bg-card__img { display: block; width: 100%; aspect-ratio: 16 / 9; background-size: cover; background-position: center; border: 1px solid var(--line-soft); }
.bg-card__name { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.04em; padding: 1px 2px 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bg-card__badge { position: absolute; top: 7px; left: 7px; padding: 2px 4px; background: var(--amber); color: #140d08; font-family: var(--mono); font-size: 8px; }
.bg-card__delete { position: absolute; right: 7px; bottom: 26px; padding: 2px 4px; border: 1px solid var(--line); background: rgba(8, 6, 5, 0.85); color: var(--muted); font-family: var(--mono); font-size: 8px; }
.bg-card__delete:hover, .bg-card__delete.is-confirm { border-color: var(--danger); color: var(--danger); }
.bg-empty { border: 1px dashed var(--line); padding: 12px; color: var(--muted); font-size: 11px; line-height: 1.7; }
.bg-panel__actions { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 16px; }
.bg-panel__path { margin: 12px 0 0; font-size: 10px; color: var(--muted); word-break: break-all; }
@media (max-width: 720px) {
  .bg-panel { position: fixed; top: 60px; left: 12px; right: 12px; width: auto; }
  .bg-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
