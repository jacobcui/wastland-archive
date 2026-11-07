import { reactive } from "vue";

export const uiState = reactive({ toast: null });
let toastTimer = null;

export function notify(message, tone = "info") {
  uiState.toast = { message, tone, id: Date.now() };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (uiState.toast = null), 4200);
}
