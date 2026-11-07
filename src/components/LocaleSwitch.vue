<script setup>
import { locale, localeOptions, setLocale, t } from "@/i18n";

defineProps({ floating: Boolean });
</script>

<template>
  <div class="locale-switch" :class="{ 'locale-switch--floating': floating }" :title="t('locale.switch')">
    <button
      v-for="item in localeOptions"
      :key="item.value"
      class="locale-switch__btn"
      :class="{ 'is-active': locale === item.value }"
      @click="setLocale(item.value)"
    >
      {{ item.label }}
    </button>
  </div>
</template>

<style scoped>
.locale-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  background: rgba(12, 10, 8, 0.78);
}
.locale-switch__btn {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.06em;
  padding: 4px 6px;
  cursor: pointer;
}
.locale-switch__btn:hover { color: var(--bone); }
.locale-switch__btn.is-active { background: var(--amber); color: #140d08; }
.locale-switch--floating {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 80;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
}
</style>
