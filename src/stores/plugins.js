import { computed, reactive } from "vue";
import { plugins } from "@/plugins/registry";

const STORAGE_KEY = "wasteland.plugins.disabled.v1";

function readDisabled() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

export const pluginsState = reactive({ disabled: readDisabled() });

export function isEnabled(id) {
  return !pluginsState.disabled.has(id);
}

export function togglePlugin(id) {
  if (pluginsState.disabled.has(id)) pluginsState.disabled.delete(id);
  else pluginsState.disabled.add(id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...pluginsState.disabled]));
  } catch {}
}

export const enabledCount = computed(() => plugins.filter((plugin) => isEnabled(plugin.id)).length);
