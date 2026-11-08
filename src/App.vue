<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from "vue";
import WastelandMark from "@/components/WastelandMark.vue";
import LoginDialog from "@/components/LoginDialog.vue";
import BackgroundPicker from "@/components/BackgroundPicker.vue";
import LocaleSwitch from "@/components/LocaleSwitch.vue";
import { useBackgrounds } from "@/stores/backgrounds";
import { t } from "@/i18n";
import { plugins, pluginById } from "@/plugins/registry";
import { enabledCount, isEnabled, togglePlugin } from "@/stores/plugins";
import { platformLabel } from "@/lib/platform";
import { uiState, notify } from "@/stores/ui";
import {
  updateState,
  maybeCheckForUpdates,
  checkForUpdates,
  openUpdateDialog,
  closeUpdateDialog,
  downloadUpdate,
} from "@/stores/update";

function parseHash() {
  const raw = window.location.hash || "";
  const match = /^#\/plugin\/([\w-]+)/.exec(raw);
  if (match) return { name: "plugin", id: match[1] };
  return { name: "home" };
}

const route = ref(parseHash());
const componentCache = new Map();
const { backgroundStyle, isNone, loadBackgrounds } = useBackgrounds();
const appVersion = __APP_VERSION__;
const changelogUrl = "https://github.com/jacobcui/wastland-archive/blob/main/CHANGELOG.md";

const updateSystemLabel = computed(() => (updateState.system && updateState.system.label) || "");
const updateDownloadLabel = computed(() => {
  if (updateState.downloading) {
    return updateState.downloadProgress == null
      ? t("app.updateDownloadingUnknown")
      : t("app.updateDownloading", { percent: updateState.downloadProgress });
  }
  if (updateSystemLabel.value) return t("app.updateDownloadFor", { system: updateSystemLabel.value });
  return t("app.updateDownload");
});

function pluginName(plugin) {
  return plugin ? t(plugin.nameKey) : "";
}
function pluginDescription(plugin) {
  return plugin ? t(plugin.descriptionKey) : "";
}
function pluginTags(plugin) {
  return plugin ? (plugin.tagKeys || []).map((key) => t(key)) : [];
}

const activePlugin = computed(() => (route.value.name === "plugin" ? pluginById(route.value.id) : null));
const activeComponent = computed(() => {
  const plugin = activePlugin.value;
  if (!plugin) return null;
  if (!componentCache.has(plugin.id)) componentCache.set(plugin.id, defineAsyncComponent(plugin.component));
  return componentCache.get(plugin.id);
});

function goHome() {
  if (window.location.hash === "#/" || window.location.hash === "") route.value = { name: "home" };
  else window.location.hash = "#/";
}

function openPlugin(id) {
  if (!isEnabled(id)) {
    notify(t("app.pluginDisabled"), "info");
    return;
  }
  window.location.hash = "#/plugin/" + id;
}

function togglePluginState(id) {
  togglePlugin(id);
  if (!isEnabled(id) && activePlugin.value && activePlugin.value.id === id) goHome();
}

function onHashChange() {
  route.value = parseHash();
  const plugin = activePlugin.value;
  if (plugin && !isEnabled(plugin.id)) {
    notify(t("app.pluginDisabledNamed") + pluginName(plugin), "info");
    goHome();
  }
}

onMounted(() => {
  window.addEventListener("hashchange", onHashChange);
  onHashChange();
  loadBackgrounds();
  maybeCheckForUpdates();
});

onBeforeUnmount(() => {
  window.removeEventListener("hashchange", onHashChange);
});
</script>

<template>
  <v-app>
    <div class="shell" :class="{ 'shell--home': !activePlugin, 'shell--plugin': Boolean(activePlugin) }">
      <div class="app-bg" :class="{ 'is-none': isNone }" :style="backgroundStyle" />
      <div v-if="!isNone" class="app-bg__scrim" />

      <template v-if="!activePlugin">
        <header class="topbar topbar--shell">
          <div class="brand-stack">
            <button class="brand" @click="goHome">
              <div class="brand__mark brand__mark--svg"><WastelandMark /></div>
              <div class="brand__text">
                <span class="brand__title">{{ t("app.brandTitle") }}</span>
                <span class="brand__sub">{{ t("app.brandSub") }}</span>
              </div>
            </button>
            <a class="brand__version" :href="changelogUrl" target="_blank" rel="noreferrer" :title="t('app.changelog')">v{{ appVersion }}</a>
            <button
              class="brand__check"
              :disabled="updateState.checking"
              :title="t('app.checkUpdate')"
              @click="checkForUpdates({ manual: true, force: true })"
            >{{ updateState.checking ? "…" : "↻" }}</button>
            <button v-if="updateState.available" class="brand__update" @click="openUpdateDialog()">
              {{ t("app.updateAvailable") }} {{ updateState.latest }}
            </button>
          </div>

          <div class="topbar__spacer" />

          <div class="topbar__status">
            <span class="eyebrow">{{ platformLabel }} · {{ enabledCount }} / {{ plugins.length }} PLUGINS</span>
            <span class="led"><i />LOCAL RUNTIME</span>
          </div>
          <LocaleSwitch />
          <BackgroundPicker />
        </header>

        <div class="hazard" />
      </template>

      <main v-if="!activePlugin" class="launcher">
        <section class="launcher__hero panel panel--cut">
          <div class="launcher__hero-copy">
            <div class="eyebrow">{{ t("app.heroEyebrow") }}</div>
            <h1 class="launcher__title">{{ t("app.heroA") }}<span>{{ t("app.heroB") }}</span></h1>
            <p class="launcher__lede">
              {{ t("app.lede1") }}<br />
              {{ t("app.lede2") }}
            </p>
            <div class="launcher__stats">
              <span><b>{{ plugins.length }}</b> {{ t("app.statPlugins") }}</span>
              <span><b>{{ enabledCount }}</b> {{ t("app.statEnabled") }}</span>
              <span><b>{{ t("app.statLocal") }}</b> {{ t("app.statLocalNote") }}</span>
            </div>
          </div>
          <div class="launcher__sigil"><WastelandMark /></div>
        </section>

        <div class="launcher__head">
          <div>
            <div class="eyebrow">{{ t("app.deckEyebrow") }}</div>
            <h2 class="section-title">{{ t("app.deckTitle") }}</h2>
          </div>
          <div class="eyebrow">{{ t("app.deckHint") }}</div>
        </div>

        <div class="plugin-grid">
          <article
            v-for="plugin in plugins"
            :key="plugin.id"
            class="plugin-card panel panel--cut"
            :class="{ 'is-off': !isEnabled(plugin.id) }"
            :style="{ '--accent': plugin.accent }"
            @click="openPlugin(plugin.id)"
          >
            <div class="plugin-card__visual">
              <div class="plugin-card__code">{{ plugin.code }}</div>
              <div class="plugin-card__mark" :class="{ 'plugin-card__mark--word': plugin.mark.length > 3 }">{{ plugin.mark }}</div>
              <div class="plugin-card__scan" />
              <div class="plugin-card__state">{{ isEnabled(plugin.id) ? "ENABLED" : "DISABLED" }}</div>
            </div>

            <div class="plugin-card__body">
              <div class="plugin-card__kicker">{{ plugin.latin }} · v{{ plugin.version }}</div>
              <h3 class="plugin-card__name">{{ pluginName(plugin) }}</h3>
              <p class="plugin-card__desc">{{ pluginDescription(plugin) }}</p>
              <div class="plugin-card__tags">
                <span v-for="tag in pluginTags(plugin)" :key="tag">{{ tag }}</span>
              </div>
              <div class="plugin-card__actions">
                <button class="mini-btn is-primary" :disabled="!isEnabled(plugin.id)" @click.stop="openPlugin(plugin.id)">
                  {{ t("app.enter") }}
                </button>
                <button class="mini-btn" @click.stop="togglePluginState(plugin.id)">
                  {{ isEnabled(plugin.id) ? t("app.disable") : t("app.enable") }}
                </button>
              </div>
            </div>
          </article>
        </div>

        <footer class="footer-note">
          <span>{{ t("app.footerLeft") }}</span>
          <span>{{ t("app.footerRight") }}</span>
        </footer>
      </main>

      <component :is="activeComponent" v-else :key="activePlugin.id" />

      <LoginDialog />

      <v-dialog v-model="updateState.dialog" max-width="620" :transition="false">
        <div class="panel update-panel">
          <div class="update-panel__head">
            <div>
              <div class="eyebrow">UPDATE · VERSION CHECK</div>
              <h2>{{ t("app.updateTitle") }}</h2>
            </div>
            <button class="update-panel__close" :title="t('app.updateClose')" @click="closeUpdateDialog()">×</button>
          </div>

          <div class="update-panel__versions">
            <div><span>{{ t("app.updateCurrent") }}</span><b>v{{ updateState.current }}</b></div>
            <div><span>{{ t("app.updateLatestLabel") }}</span><b class="is-new">v{{ updateState.latest }}</b></div>
          </div>

          <p v-if="updateState.publishedAt" class="update-panel__date">
            {{ t("app.updatePublished") }} · {{ String(updateState.publishedAt).slice(0, 10) }}
          </p>

          <div v-if="updateSystemLabel" class="update-panel__system">
            <span>{{ t("app.updateDetectedSystem") }}</span>
            <b>{{ updateSystemLabel }}</b>
            <span v-if="updateState.system.assetKind" class="update-panel__system-kind">{{ updateState.system.assetKind.toUpperCase() }}</span>
            <span v-if="updateState.asset" class="update-panel__system-file" :title="updateState.asset.name">{{ updateState.asset.name }}</span>
          </div>

          <div v-if="updateState.downloading" class="update-panel__progress" :class="{ 'is-indeterminate': updateState.downloadProgress == null }">
            <i :style="{ width: (updateState.downloadProgress == null ? 35 : updateState.downloadProgress) + '%' }" />
          </div>

          <p v-if="updateState.downloadError" class="update-panel__error">{{ updateState.downloadError }}</p>

          <div class="update-panel__actions">
            <button
              v-if="updateState.asset"
              class="btn-hazard update-panel__primary"
              :disabled="updateState.downloading"
              @click="downloadUpdate()"
            >
              {{ updateDownloadLabel }}
            </button>
            <a v-else class="btn-hazard" :href="updateState.releaseUrl" target="_blank" rel="noreferrer">
              {{ t("app.updateChoosePlatform") }}
            </a>
            <a class="btn-ghost" :href="updateState.releaseUrl" target="_blank" rel="noreferrer">{{ t("app.updateRelease") }}</a>
            <button class="btn-ghost" @click="closeUpdateDialog()">{{ t("app.updateClose") }}</button>
          </div>
          <p v-if="updateState.asset" class="update-panel__hint">{{ t("app.updateAutoHint") }}</p>
          <p v-else class="update-panel__hint">{{ t("app.updateNoAsset") }}</p>
          <p v-if="updateState.downloadPath" class="update-panel__hint update-panel__path" :title="updateState.downloadPath">{{ t("app.updateDownloadedTo", { path: updateState.downloadPath }) }}</p>

          <details v-if="updateState.body" class="update-panel__notes">
            <summary>{{ t("app.updateNotes") }}</summary>
            <pre>{{ updateState.body }}</pre>
          </details>
        </div>
      </v-dialog>

      <v-snackbar
        class="toast-bar"
        :model-value="Boolean(uiState.toast)"
        :timeout="4000"
        location="bottom left"
        elevation="0"
        @update:model-value="uiState.toast = null"
      >
        <span class="mono" style="font-size: 13px; letter-spacing: 0.06em">{{ uiState.toast ? uiState.toast.message : "" }}</span>
      </v-snackbar>
    </div>
  </v-app>
</template>
