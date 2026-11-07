<script setup>
import { computed } from "vue";
import { state, revealArchive } from "@/stores/archive";
import { sessionState, maskPhone } from "@/stores/session";
import { formatBytes, formatDate } from "@/lib/format";
import { openArchiveLabel } from "@/lib/platform";

const props = defineProps({ library: { type: Object, default: null } });
const emit = defineEmits(["sync", "relogin"]);

const magazine = computed(() => (props.library && props.library.magazines && props.library.magazines[0]) || null);
const trades = computed(() => (magazine.value ? magazine.value.tradeList || [] : []));
const archived = computed(() => (props.library ? props.library.localCount || 0 : 0));
const total = computed(() => (props.library ? props.library.issues.length : 0));
const storage = computed(() => formatBytes(props.library ? props.library.storageBytes : 0));
const account = computed(() => {
  if (sessionState.credentials.login) return maskPhone(sessionState.credentials.login);
  if (sessionState.session.account) return maskPhone(sessionState.session.account);
  return "未登录";
});
const link = computed(() => {
  if (!sessionState.session.authenticated) return "LOCAL";
  return sessionState.session.source === "cache" ? "CACHED" : "LIVE";
});
const expires = computed(() => {
  if (!sessionState.session.authenticated) return "OFFLINE";
  if (!sessionState.session.expiresAt) return "—";
  const diff = sessionState.session.expiresAt - Date.now();
  if (diff <= 0) return "EXPIRED";
  const mins = Math.floor(diff / 60000);
  return mins >= 60 ? Math.floor(mins / 60) + "H " + (mins % 60) + "M" : mins + "M";
});
const lastSync = computed(() => {
  if (!props.library || !props.library.fetchedAt) return "从未同步";
  return formatDate(props.library.fetchedAt, { withTime: true });
});
const cover = computed(() => (magazine.value ? magazine.value.coverUrl : ""));
</script>

<template>
  <aside class="dossier">
    <div class="panel rivets" style="padding: 16px">
      <div class="eyebrow" style="margin-bottom: 12px">SUBSCRIBER DOSSIER · 订阅档案</div>
      <div class="dossier__head">
        <img v-if="cover" class="dossier__cover" :src="cover" alt="magazine cover" />
        <div>
          <h1 class="dossier__name">{{ magazine ? magazine.name : "未连接" }}</h1>
          <div class="dossier__meta">
            {{ magazine ? magazine.type : "—" }}<br />
            {{ magazine ? magazine.free : "—" }} · {{ magazine ? magazine.magazineId.slice(-6) : "——" }}
          </div>
        </div>
      </div>

      <p v-if="magazine" style="font-size: 13px; line-height: 1.8; color: var(--muted); margin: 14px 0 0">
        {{ magazine.description }}
      </p>

      <div class="hairline" style="margin: 14px 0"></div>

      <div class="eyebrow" style="margin-bottom: 8px">订阅周期 / TRADE WINDOW</div>
      <div v-if="trades.length" class="trade-list">
        <div v-for="trade in trades" :key="trade.startYear + '-' + trade.startNum" class="trade">
          <span>{{ trade.startYear }}.{{ String(trade.startNum).padStart(2, "0") }}</span>
          <span>→ {{ trade.endYear }}.{{ String(trade.endNum).padStart(2, "0") }}</span>
        </div>
      </div>
      <div v-else class="dossier__meta">— 无订阅记录 —</div>

      <div class="hairline" style="margin: 14px 0"></div>

      <div class="kv">
        <div class="kv__row"><span>已归档 / TOTAL</span><b>{{ archived }} / {{ total }}</b></div>
        <div class="kv__row"><span>本地占用 / DISK</span><b>{{ storage }}</b></div>
        <div class="kv__row"><span>当前年份 / YEAR</span><b>{{ library ? library.year : "—" }}</b></div>
        <div class="kv__row"><span>通道 / LINK</span><b>{{ link }}</b></div>
        <div class="kv__row"><span>通行证 / TTL</span><b>{{ expires }}</b></div>
        <div class="kv__row"><span>账号 / NODE</span><b>{{ account }}</b></div>
        <div class="kv__row"><span>上次同步 / SYNC</span><b style="font-size: 11px">{{ lastSync }}</b></div>
      </div>

      <div style="display: flex; gap: 8px; margin-top: 16px">
        <button class="btn-hazard" style="flex: 1" :disabled="state.busy" @click="emit('sync')">
          {{ state.loading ? "同步中…" : "同步" }}
        </button>
        <button class="btn-ghost" :disabled="state.busy" @click="emit('relogin')">
          {{ sessionState.session.authenticated ? "重新登录" : "登录账号" }}
        </button>
      </div>
      <button class="btn-ghost file-manager-btn" style="width: 100%; margin-top: 8px" @click="revealArchive()">{{ openArchiveLabel }}</button>
    </div>

    <div class="panel" style="padding: 12px 14px">
      <div class="eyebrow" style="margin-bottom: 8px">OPERATOR NOTES</div>
      <p style="font-size: 12px; line-height: 1.9; color: var(--muted); margin: 0">
        所有期刊仅归档至本机 <span class="mono" style="color: var(--amber)">./data/issues</span>，凭个人订阅凭证读取。<br />
        手机号与密码只保存在本浏览器 localStorage，不写入服务端。<br />
        不提供分享、发布或再分发能力。
      </p>
    </div>
  </aside>
</template>
