<script setup>
import { computed } from "vue";
import { jobsFor, progressOf } from "@/stores/archive";
import { formatBytes } from "@/lib/format";

const props = defineProps({ issue: { type: Object, required: true } });
const emit = defineEmits(["open", "download", "cancel"]);

const job = computed(() => jobsFor(props.issue.nodeId) || props.issue.job);
const active = computed(() => job.value && ["queued", "preparing", "downloading"].includes(job.value.status));
const local = computed(() => Boolean(props.issue.local && props.issue.local.complete));
const cover = computed(() => {
  const localMeta = props.issue.local || {};
  return localMeta.coverLocalUrl || props.issue.coverUrl || "";
});
const number = computed(() => String(props.issue.number || 0).padStart(2, "0"));
const pages = computed(() => {
  if (local.value && props.issue.local.pageCount) {
    const size = props.issue.local.bytes ? " · " + formatBytes(props.issue.local.bytes).replace(" ", "") : "";
    return props.issue.local.pageCount + "P" + size;
  }
  if (active.value && job.value.total) return job.value.downloaded + "/" + job.value.total + "P";
  return "—";
});
const flag = computed(() => {
  if (active.value) return { text: "ARCHIVING", cls: "is-busy" };
  if (local.value) return { text: "LOCAL", cls: "is-local" };
  return { text: "REMOTE", cls: "is-remote" };
});
const readBar = computed(() => {
  const progress = props.issue.progress;
  const total = (props.issue.local && props.issue.local.pageCount) || (progress && progress.total) || 0;
  if (!local.value || !progress || !progress.page || !total) return null;
  if (progress.page <= 1 || progress.page >= total) return null;
  return { page: progress.page, total, percent: Math.round((progress.page / total) * 100) };
});
const segments = computed(() => {
  const total = 14;
  if (!active.value || !job.value || !job.value.total) return [];
  const filled = Math.round(progressOf(job.value) * total);
  return Array.from({ length: total }, (_, i) => (i < filled ? "on" : ""));
});
</script>

<template>
  <article class="issue panel rivets" :class="{ 'is-local': local }" @click="emit('open', issue)">
    <div class="issue__cover-wrap">
      <img v-if="cover" class="issue__cover" :src="cover" :alt="issue.volume" loading="lazy" />
      <div class="issue__sweep" />
      <div class="issue__shade" />
      <div class="issue__index">NO.{{ number }}</div>
      <div class="issue__flag" :class="flag.cls">{{ flag.text }}</div>
      <div v-if="segments.length" class="seg-bar" style="position: absolute; left: 10px; right: 10px; bottom: 10px">
        <i v-for="(cls, i) in segments" :key="i" :class="cls" />
      </div>
      <div v-if="readBar" class="issue__read" :title="'上次读到第 ' + readBar.page + ' 页 / 共 ' + readBar.total + ' 页'">
        <i :style="{ width: readBar.percent + '%' }" />
      </div>
    </div>

    <div class="issue__body">
      <div class="issue__vol">{{ issue.volume }}</div>
      <div class="issue__sub">
        <span>{{ number }} / 51</span>
        <span>{{ pages }}</span>
      </div>

      <div class="issue__actions">
        <button v-if="local" class="mini-btn is-primary" @click.stop="emit('open', issue)">阅读</button>
        <template v-else-if="active">
          <button class="mini-btn" disabled>归档中…</button>
          <button class="mini-btn" @click.stop="emit('cancel', issue)">中止</button>
        </template>
        <template v-else>
          <button class="mini-btn is-primary" @click.stop="emit('download', issue)">归档下载</button>
          <button class="mini-btn" disabled>未归档</button>
        </template>
      </div>
    </div>
  </article>
</template>
