<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import IssueCard from "@/components/IssueCard.vue";
import DossierPanel from "@/components/DossierPanel.vue";
import ReaderView from "@/components/ReaderView.vue";
import DownloadDock from "@/components/DownloadDock.vue";
import {
  state,
  loadLibrary,
  relogin,
  selectYear,
  openReader,
  downloadIssue,
  cancelDownload,
  connectEvents,
  disconnectEvents,
  refreshJobs,
  syncArchive,
  closeReader,
} from "@/stores/archive";
import { sessionState, loadSession, openLoginDialog, maskPhone } from "@/stores/session";
import { goHome } from "@/lib/navigation";
import { formatBytes } from "@/lib/format";
import { t } from "@/i18n";
import { notify } from "@/stores/ui";

const pending = ref(null);
const refreshing = ref(false);
let poll = null;

const library = computed(() => state.library);
const issues = computed(() => (library.value ? library.value.issues : []));
const years = computed(() => (library.value ? library.value.years : []));
const magazine = computed(() => (library.value && library.value.magazines[0]) || null);
const archived = computed(() => issues.value.filter((i) => i.local && i.local.complete).length);
const accountLabel = computed(() => {
  const phone = sessionState.credentials.login || sessionState.session.account;
  return phone ? maskPhone(phone) : "未登录";
});

function openAccount() {
  const force = Boolean(sessionState.credentials.login);
  openLoginDialog(force ? "更换 mkexue.com 订阅账号" : "登录 mkexue.com 订阅账号", { force });
}

const linkLabel = computed(() => {
  if (state.loading) return "SYNCING";
  if (sessionState.session.authenticated) return "LINK OK";
  return "LOCAL READY";
});
const linkClass = computed(() => {
  if (state.loading) return "led--amber";
  if (state.error) return "led--err";
  return "";
});

function onCardOpen(issue) {
  if (issue.local && issue.local.complete) openReader(issue);
  else pending.value = issue;
}

function confirmDownload() {
  const issue = pending.value;
  pending.value = null;
  if (issue) downloadIssue(issue);
}

function sync() {
  syncArchive();
}

async function refreshCache() {
  if (refreshing.value || state.loading) return;
  refreshing.value = true;
  try {
    await loadLibrary(state.year, true);
    await refreshJobs();
    notify("本地归档缓存已刷新", "success");
  } finally {
    refreshing.value = false;
  }
}

watch(
  () => sessionState.lastLoginAt,
  (value) => {
    if (value && !state.busy) loadLibrary(state.year, false);
  }
);

onMounted(async () => {
  await loadSession();
  await loadLibrary(null, false);
  connectEvents();
  await refreshJobs();
  poll = setInterval(() => {
    if (Object.values(state.jobs).some((job) => ["queued", "preparing", "downloading"].includes(job.status))) {
      refreshJobs();
    }
  }, 4000);
});

onBeforeUnmount(() => {
  clearInterval(poll);
  disconnectEvents();
  if (state.reader.open) closeReader();
});
</script>

<template>
  <div class="plugin plugin--archive">
    <header class="pluginbar">
      <button class="pluginbar__back" @click="goHome">← {{ t("common.back") }}</button>
      <div class="pluginbar__divider" />
      <div class="pluginbar__brand">
        <div class="pluginbar__mark">MKX</div>
        <div>
          <div class="pluginbar__title">{{ t("plugins.mkx.name") }}</div>
          <div class="pluginbar__sub">杂志档案库 · SUBSCRIBER TERMINAL</div>
        </div>
      </div>

      <div class="pluginbar__spacer" />

      <div class="meter-group">
        <div class="meter">
          <span class="meter__label">ARCHIVED</span>
          <span class="meter__value"><b>{{ archived }}</b> / {{ issues.length }}</span>
        </div>
        <div class="meter">
          <span class="meter__label">LOCAL DISK</span>
          <span class="meter__value">{{ library ? formatBytes(library.storageBytes) : "0 B" }}</span>
        </div>
        <div class="meter">
          <span class="meter__label">YEAR</span>
          <span class="meter__value">{{ library ? library.year : "—" }}</span>
        </div>
      </div>

      <div class="led" :class="linkClass">
        <i />{{ linkLabel }}
      </div>

      <button class="account-chip" :class="{ 'is-on': sessionState.session.authenticated }" @click="openAccount">
        <i />
        <span>{{ accountLabel }}</span>
      </button>

      <button class="btn-ghost" :disabled="state.loading || state.busy" @click="sync">
        {{ state.loading ? "同步中…" : "⟳ 同步" }}
      </button>
      <button
        class="btn-ghost pluginbar__refresh"
        :disabled="state.loading || state.busy || refreshing"
        title="刷新本地归档缓存（重新读取 data/issues）"
        aria-label="刷新本地归档缓存"
        @click="refreshCache"
      >
        {{ refreshing ? "…" : "↻" }}
      </button>
    </header>

    <div class="hazard" />

    <main class="stage">
      <DossierPanel :library="library" @sync="sync" @relogin="relogin" />

      <section>
        <div class="section-head">
          <div>
            <div class="eyebrow" style="margin-bottom: 6px">ISSUE INDEX · 过刊库存</div>
            <h2 class="section-title">
              {{ magazine ? magazine.name : "档案库" }} <em>/ {{ library ? library.year : "----" }}</em>
            </h2>
          </div>
          <div class="year-rail">
            <button
              v-for="year in years"
              :key="year"
              class="year-btn"
              :class="{ 'is-active': year === (library && library.year) }"
              @click="selectYear(year)"
            >
              Y{{ year }}
            </button>
          </div>
        </div>

        <div v-if="!sessionState.session.authenticated && !sessionState.credentials.login" class="banner banner--info">
          <span style="color: var(--tox)">◈</span>
          <span style="flex: 1">本地离线模式。已归档期刊可直接阅读；同步订阅库或归档下载时会弹窗登录 mkexue.com。</span>
          <button class="btn-ghost" @click="relogin">登录</button>
        </div>

        <div v-if="state.error" class="banner">
          <span style="color: var(--amber)">⚠</span>
          <span style="flex: 1">{{ state.error }}</span>
          <button class="btn-ghost" @click="relogin">修复链路</button>
        </div>

        <div v-if="state.loading && !library" class="empty">
          <div class="led led--amber" style="justify-content: center"><i />正在读取本地档案 …</div>
          <div style="margin-top: 10px; font-size: 12px; letter-spacing: 0.2em">LOCAL CACHE · INDEX · READY</div>
        </div>

        <div v-else-if="!issues.length" class="empty">
          NO RECORDS IN THIS SECTOR
          <div style="font-size: 12px; margin-top: 8px">
            该年份下没有可读的过刊。切换年份，或登录后点击「同步」抓取订阅索引。
          </div>
        </div>

        <div v-else class="grid">
          <IssueCard
            v-for="issue in issues"
            :key="issue.nodeId"
            :issue="issue"
            @open="onCardOpen"
            @download="downloadIssue"
            @cancel="cancelDownload"
          />
        </div>

        <footer class="footer-note">
          <span>MKX-ARCHIVE 插件 · 废土馆藏 · 仅限订阅者本人本机阅读</span>
          <span>数据源 mkexue.com · 归档目录 ./data/issues</span>
        </footer>
      </section>
    </main>

    <DownloadDock />
    <ReaderView v-if="state.reader.open" />

    <v-dialog :model-value="Boolean(pending)" max-width="520" :transition="false" @update:model-value="pending = null">
      <div class="panel panel--cut" style="padding: 22px">
        <div class="eyebrow" style="margin-bottom: 10px">ACQUIRE ISSUE · 本地无归档</div>
        <div style="display: flex; gap: 16px">
          <img
            v-if="pending"
            :src="pending.coverUrl"
            alt="cover"
            style="width: 96px; aspect-ratio: 3/4; object-fit: cover; border: 1px solid var(--line); filter: saturate(0.9)"
          />
          <div>
            <div style="font-size: 16.5px; color: var(--bone); letter-spacing: 0.04em">
              {{ pending ? pending.volume : "" }}
            </div>
            <div class="eyebrow" style="margin-top: 8px">SOURCE · mkexue.com</div>
            <p style="font-size: 13px; line-height: 1.8; color: var(--muted); margin: 10px 0 0">
              将把整期页面镜像到本机归档目录，之后可完全离线阅读。归档只对本人开放，不做任何再分发。
            </p>
          </div>
        </div>
        <div class="hazard" style="margin: 18px 0"></div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button class="btn-ghost" @click="pending = null">取消</button>
          <button class="btn-hazard" @click="confirmDownload">开始归档</button>
        </div>
      </div>
    </v-dialog>

  </div>
</template>
