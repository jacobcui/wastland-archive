import { computed, ref } from "vue";
import en from "./locales/en";
import zh from "./locales/zh";

const STORAGE_KEY = "wasteland.locale";
const messages = { en, zh };
const supported = ["en", "zh"];

function detectLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (supported.includes(saved)) return saved;
  } catch {}
  const browser = typeof navigator !== "undefined" ? String(navigator.language || "").toLowerCase() : "en";
  return browser.startsWith("zh") ? "zh" : "en";
}

export const locale = ref(detectLocale());
export const localeOptions = [
  { value: "zh", label: "中文" },
  { value: "en", label: "EN" },
];

function interpolate(text, params) {
  if (!params) return text;
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (params[key] !== undefined ? params[key] : match));
}

export function t(key, params) {
  const dict = messages[locale.value] || messages.zh;
  const value = dict[key] !== undefined ? dict[key] : messages.zh[key] !== undefined ? messages.zh[key] : key;
  return interpolate(value, params);
}

export function setLocale(next) {
  if (!supported.includes(next)) return;
  locale.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {}
  if (typeof document !== "undefined") document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
}

export function toggleLocale() {
  setLocale(locale.value === "zh" ? "en" : "zh");
}

export const isEnglish = computed(() => locale.value === "en");

setLocale(locale.value);
