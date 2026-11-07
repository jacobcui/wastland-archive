<script setup>
import { computed } from "vue";
import { activeJobs, cancelDownload, progressOf } from "@/stores/archive";
import { formatBytes } from "@/lib/format";

const jobs = computed(() => activeJobs.value);
const files = computed(() => jobs.value.length);

function ratio(job) {
  return Math.round(progressOf(job) * 100);
}
</script>

<template>
  <aside v-if="files" class="dock panel panel--cut">
    <div class="dock__head">
      <div class="dock__title"><span class="led led--amber"><i />ARCHIVE RUNNING</span></div>
      <span class="eyebrow">{{ files }} JOB</span>
    </div>
    <div class="hazard" style="margin: 10px 0"></div>
    <div v-for="job in jobs" :key="job.id" style="margin-bottom: 12px">
      <div class="dock__row" style="margin-top: 0">
        <span style="color: var(--bone)">{{ job.volume || job.title }}</span>
        <span>{{ ratio(job) }}%</span>
      </div>
      <div class="seg-bar" style="height: 8px">
        <i
          v-for="n in 24"
          :key="n"
          :class="{ on: n <= Math.round((24 * (job.downloaded + job.failed)) / Math.max(1, job.total)) }"
        />
      </div>
      <div class="dock__row">
        <span>{{ job.status === "preparing" ? "解析目录…" : job.downloaded + "/" + job.total + " 页" }}</span>
        <span>{{ formatBytes(job.bytes) }}</span>
      </div>
      <button class="mini-btn" style="width: 100%; margin-top: 6px" @click="cancelDownload(job.nodeId)">中止任务</button>
    </div>
  </aside>
</template>
