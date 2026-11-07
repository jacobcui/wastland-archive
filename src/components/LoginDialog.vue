<script setup>
import { computed, ref, watch } from "vue";
import { sessionState, submitLoginDialog, cancelLoginDialog, logout, maskPhone } from "@/stores/session";
import WastelandMark from "@/components/WastelandMark.vue";
import { locale, t } from "@/i18n";

const dialog = computed(() => sessionState.loginDialog);
const show = ref(false);

watch(
  () => dialog.value.open,
  (open) => {
    if (open) show.value = false;
  }
);

function onToggle(value) {
  if (!value) cancelLoginDialog();
}

function submit() {
  submitLoginDialog();
}

function close() {
  cancelLoginDialog();
}

function doLogout() {
  logout();
}
</script>

<template>
  <v-dialog :model-value="dialog.open" max-width="500" :transition="false" @update:model-value="onToggle">
    <div class="panel panel--cut login-panel">
      <div class="login-panel__head">
        <div class="login-panel__mark"><WastelandMark /></div>
        <div style="flex: 1">
          <div class="eyebrow">{{ t("login.eyebrow") }}</div>
          <h2 class="login-panel__title">mkexue.com</h2>
        </div>
        <button class="login-panel__close" :disabled="dialog.busy" :title="t('login.close')" @click="close">✕</button>
      </div>

      <p class="login-panel__reason">{{ locale === "en" ? t("login.reason") : dialog.reason }}</p>

      <form @submit.prevent="submit">
        <label class="field-label" for="mkx-phone">{{ t("login.phone") }}</label>
        <input
          id="mkx-phone"
          v-model="dialog.phone"
          class="field"
          type="tel"
          inputmode="numeric"
          autocomplete="username"
          :placeholder="t('login.phonePlaceholder')"
          :disabled="dialog.busy"
        />

        <label class="field-label" for="mkx-password">{{ t("login.password") }}</label>
        <div class="field-wrap">
          <input
            id="mkx-password"
            v-model="dialog.password"
            class="field"
            :type="show ? 'text' : 'password'"
            autocomplete="current-password"
            :placeholder="t('login.passwordPlaceholder')"
            :disabled="dialog.busy"
          />
          <button type="button" class="field-eye" :disabled="dialog.busy" @click="show = !show">
            {{ show ? t("login.hide") : t("login.show") }}
          </button>
        </div>

        <div v-if="dialog.error" class="login-panel__error">⚠ {{ dialog.error }}</div>

        <label class="checkline">
          <input v-model="dialog.remember" type="checkbox" :disabled="dialog.busy" />
          <span>{{ t("login.remember") }}</span>
        </label>

        <p class="login-panel__hint">
          {{ t("login.hint") }}
        </p>

        <div class="login-panel__actions">
          <button type="button" class="btn-ghost" :disabled="dialog.busy" @click="close">{{ t("login.cancel") }}</button>
          <button type="submit" class="btn-hazard" :disabled="dialog.busy">
            {{ dialog.busy ? t("login.busy") : t("login.submit") }}
          </button>
        </div>

        <div v-if="dialog.hasSaved || sessionState.session.authenticated" class="login-panel__saved">
          <span v-if="dialog.hasSaved">{{ t("login.saved", { account: maskPhone(sessionState.credentials.login) }) }}</span>
          <span v-else-if="sessionState.credentials.login">{{ t("login.current", { account: maskPhone(sessionState.credentials.login) }) }}</span>
          <span v-else>{{ t("login.loggedIn") }}</span>
          <button type="button" class="login-panel__logout" :disabled="dialog.busy" @click="doLogout">
            {{ t("login.logout") }}
          </button>
        </div>
      </form>
    </div>
  </v-dialog>
</template>

<style scoped>
.login-panel { padding: 22px; }
.login-panel__head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.login-panel__mark {
  width: 40px;
  height: 40px;
  padding: 6px;
  color: var(--amber);
  border: 1px solid var(--amber);
  background: linear-gradient(160deg, rgba(255, 176, 0, 0.14), transparent);
  clip-path: polygon(0 0, 100% 0, 100% 70%, 70% 100%, 0 100%);
}
.login-panel__title {
  margin: 2px 0 0;
  font-family: var(--display);
  font-size: 24px;
  letter-spacing: 0.08em;
  color: var(--bone);
  text-transform: uppercase;
}
.login-panel__close {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 18px;
  cursor: pointer;
  padding: 4px 6px;
}
.login-panel__close:hover { color: var(--amber); }
.login-panel__reason {
  border-left: 2px solid var(--amber);
  background: rgba(255, 176, 0, 0.06);
  padding: 8px 10px;
  margin: 0 0 18px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--bone-dim);
}
.field-label {
  display: block;
  margin: 12px 0 6px;
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--muted);
  text-transform: uppercase;
}
.field {
  width: 100%;
  border: 1px solid var(--line);
  background: #0e0c09;
  color: var(--bone);
  font-family: var(--mono);
  font-size: 14px;
  padding: 11px 12px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.field:focus {
  border-color: var(--amber);
  box-shadow: 0 0 0 1px rgba(255, 176, 0, 0.25);
}
.field:disabled { opacity: 0.6; }
.field-wrap { position: relative; }
.field-wrap .field { padding-right: 64px; }
.field-eye {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  border: 0;
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  padding: 8px;
  cursor: pointer;
}
.field-eye:hover { color: var(--amber); }
.login-panel__error {
  margin-top: 12px;
  border: 1px solid var(--danger);
  background: rgba(224, 65, 45, 0.1);
  color: #f0b3a8;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}
.checkline {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  font-size: 12px;
  color: var(--bone-dim);
  cursor: pointer;
}
.checkline input { margin-top: 2px; accent-color: var(--amber); }
.login-panel__hint {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--muted);
}
.login-panel__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.login-panel__saved {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--line-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11.5px;
  color: var(--muted);
}
.login-panel__logout {
  border: 0;
  background: transparent;
  color: var(--rust);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  cursor: pointer;
  padding: 4px 0;
}
.login-panel__logout:hover { color: var(--danger); text-decoration: underline; }
</style>
