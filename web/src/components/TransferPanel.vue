<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TransferSnapshot, TransferStatus } from '../utils/uploader'
import { humanSpeed } from '../utils/uploader'
import type { BatchSummary } from '../utils/uploadQueue'
import { humanSize } from '../utils/format'

const props = defineProps<{ tasks: TransferSnapshot[]; summary?: BatchSummary | null }>()
const emit = defineEmits<{
  (e: 'pause', key: string): void
  (e: 'resume', key: string): void
  (e: 'cancel', key: string): void
  (e: 'pause-all'): void
  (e: 'resume-all'): void
  (e: 'cancel-all'): void
}>()

const { t } = useI18n()

const STATUS_TYPE: Record<TransferStatus, string> = {
  prepare: 'info',
  running: 'primary',
  paused: 'warning',
  merging: 'warning',
  done: 'success',
  error: 'danger',
  canceled: 'info',
}

/** 写成 computed：语言变了，标签也要跟着变 */
const statusText = computed<Record<TransferStatus, string>>(() => ({
  prepare: t('transfer.status.prepare'),
  running: t('transfer.status.running'),
  paused: t('transfer.status.paused'),
  merging: t('transfer.status.merging'),
  done: t('transfer.status.done'),
  error: t('transfer.status.error'),
  canceled: t('transfer.status.canceled'),
}))

const active = computed(() =>
  props.tasks.filter((t) => t.status !== 'done' && t.status !== 'error' && t.status !== 'canceled'),
)

/** 一批多个文件时才画总进度：单文件时每行自己的进度条已经够清楚 */
const batch = computed(() => {
  const s = props.summary
  return s && s.total > 1 ? s : null
})

const batchPercent = computed(() => {
  const s = batch.value
  if (!s || !s.size) return 0
  return Math.min(100, Math.round((s.loaded * 100) / s.size))
})

const batchText = computed(() => {
  const s = batch.value
  if (!s) return ''
  return t('transfer.summary', {
    done: s.done,
    total: s.total,
    loaded: humanSize(s.loaded),
    size: humanSize(s.size),
    speed: humanSpeed(s.speed),
  })
})
</script>

<template>
  <div v-if="tasks.length" class="panel">
    <div class="head">
      <span>{{ t('transfer.title') }}</span>
      <span v-if="batch" class="batch-ops">
        <el-button link size="small" @click="emit('pause-all')">
          {{ t('transfer.pauseAll') }}
        </el-button>
        <el-button link size="small" @click="emit('resume-all')">
          {{ t('transfer.resumeAll') }}
        </el-button>
        <el-button link size="small" type="danger" @click="emit('cancel-all')">
          {{ t('transfer.cancelAll') }}
        </el-button>
      </span>
      <span class="count">
        {{ active.length ? t('transfer.active', active.length) : t('transfer.allDone') }}
      </span>
    </div>
    <div v-if="batch" class="batch">
      <el-progress :percentage="batchPercent" :stroke-width="6" />
      <div class="batch-text">{{ batchText }}</div>
    </div>
    <div class="rows">
      <div v-for="task in tasks" :key="task.key" class="row">
        <div class="meta">
          <span class="name">{{ task.name }}</span>
          <el-tag size="small" :type="STATUS_TYPE[task.status]">{{ statusText[task.status] }}</el-tag>
          <el-tag v-if="task.note" size="small" type="success">{{ task.note }}</el-tag>
          <span class="size">{{ humanSize(task.loaded) }} / {{ humanSize(task.size) }}</span>
          <span class="speed">{{ humanSpeed(task.speed) }}</span>
          <span class="ops">
            <el-button
              v-if="task.status === 'running'"
              size="small"
              @click="emit('pause', task.key)"
            >
              {{ t('transfer.pause') }}
            </el-button>
            <el-button
              v-if="task.status === 'paused'"
              size="small"
              type="primary"
              @click="emit('resume', task.key)"
            >
              {{ t('transfer.resume') }}
            </el-button>
            <el-button
              v-if="task.status !== 'done' && task.status !== 'canceled'"
              size="small"
              type="danger"
              @click="emit('cancel', task.key)"
            >
              {{ t('transfer.cancel') }}
            </el-button>
          </span>
        </div>
        <el-progress
          :percentage="task.progress"
          :status="
            task.status === 'done' ? 'success' : task.status === 'error' ? 'exception' : undefined
          "
          :stroke-width="8"
        />
        <div v-if="task.error" class="err">{{ task.error }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel {
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
  background: var(--el-fill-color-lighter);
}
.head {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 10px;
}
.count {
  color: var(--el-text-color-secondary);
  font-weight: 400;
}
.batch-ops {
  display: flex;
  gap: 10px;
  margin-left: auto;
  margin-right: 12px;
}
.batch {
  margin-bottom: 10px;
}
.batch-text {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-top: 4px;
}
/* 几十个文件时面板会一路撑下去，把表格挤出屏幕；限高 + 内部滚动，
   总进度条留在外面，始终可见 */
.rows {
  max-height: 320px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
}
.row + .row {
  margin-top: 12px;
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 6px;
}
.name {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.size,
.speed {
  color: var(--el-text-color-secondary);
}
.ops {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.err {
  color: var(--el-color-danger);
  font-size: 12px;
  margin-top: 4px;
}
</style>
