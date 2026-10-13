<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { api, type ArchiveJobInfo, type ArchiveMode, type ArchivePlanResult } from '../api'
import {
  canStreamDownload,
  nativeDownload,
  startDownload,
  startStreamDownload,
} from '../utils/downloader'
import { formatDateTime, humanSize } from '../utils/format'
import type { TransferControl } from '../utils/uploader'
import LocaleSwitcher from '../components/LocaleSwitcher.vue'

type PublicInfo = Awaited<ReturnType<typeof api.shares.publicInfo>>

const route = useRoute()
const { t } = useI18n()
const code = String(route.params.code ?? '')
const info = ref<PublicInfo | null>(null)
const accessCode = ref('')
const loading = ref(true)

const plan = ref<ArchivePlanResult | null>(null)
const planLoading = ref(false)
const planError = ref('')
const mode = ref<ArchiveMode>('smart')

const control = ref<TransferControl | null>(null)
const loaded = ref(0)
const total = ref(0)
const speed = ref(0)
const downloading = ref(false)
const downError = ref('')

/** 后台打包任务：目录较大时走这条路，打包完再以普通文件方式下载 */
const job = ref<ArchiveJobInfo | null>(null)
const jobPhase = ref<'none' | 'packing' | 'ready' | 'failed'>('none')
const jobError = ref('')
let timer: number | undefined

const isDir = computed(() => info.value?.kind === 'DIR')
const useAsync = computed(() => !!plan.value?.suggestAsync)
const percent = computed(() =>
  total.value ? Math.min(100, Math.round((loaded.value * 100) / total.value)) : 0,
)
const canArchive = computed(
  () => !!plan.value && !plan.value.truncated && info.value?.status === 'ACTIVE' && info.value?.available,
)
const busy = computed(() => jobPhase.value === 'packing' || downloading.value)

const modeOptions = computed<Array<{ value: ArchiveMode; label: string }>>(() => [
  { value: 'smart', label: t('share.mode.smart') },
  { value: 'store', label: t('share.mode.store') },
  { value: 'deflate', label: t('share.mode.deflate') },
])

const truncatedText = computed(() => {
  if (!plan.value?.truncated) return ''
  const p = plan.value
  if (p.truncatedBy === 'files') return t('share.truncatedFiles', { n: p.limits.maxFiles })
  if (p.truncatedBy === 'bytes') return t('share.truncatedBytes', { size: humanSize(p.limits.maxTotalBytes) })
  return t('share.truncatedDepth', { n: p.limits.maxDepth })
})

async function load() {
  try {
    info.value = await api.shares.publicInfo(code)
    // 没有提取码的目录分享直接预检；有提取码的等用户填完再查，
    // 否则预检接口本身就变成了一个目录探测器
    if (isDir.value && !info.value.needAccessCode && info.value.status === 'ACTIVE') {
      await loadPlan()
    }
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function loadPlan() {
  stopPolling()
  planError.value = ''
  planLoading.value = true
  plan.value = null
  job.value = null
  jobPhase.value = 'none'
  try {
    plan.value = await api.shares.archivePlan(code, accessCode.value || undefined, mode.value)
  } catch (e: any) {
    plan.value = null
    planError.value = e.message
  } finally {
    planLoading.value = false
  }
}

function zipName(): string {
  return `${info.value?.title || 'archive'}.zip`
}

function stopPolling() {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
}

function doDownload() {
  const url = api.shares.publicDownloadUrl(code, accessCode.value || undefined)
  nativeDownload(url)
}

/** 同步流式：小目录直接边打包边下载，没有临时文件、不支持续传 */
function doArchiveDownload() {
  if (!canArchive.value) return
  downError.value = ''
  loaded.value = 0
  total.value = plan.value?.zipBytes ?? 0
  speed.value = 0
  downloading.value = true

  const url = api.shares.archiveUrl(code, accessCode.value || undefined, mode.value)
  if (!canStreamDownload()) {
    // 不支持流式落盘（Firefox / Safari）就交给原生下载
    nativeDownload(url)
    downloading.value = false
    return
  }

  control.value = startStreamDownload(url, zipName(), {
    onUpdate: (s) => {
      loaded.value = s.loaded
      if (s.size) total.value = s.size
      speed.value = s.speed
      if (s.status === 'error') {
        downloading.value = false
        downError.value = s.error ?? t('common.downloadFailed')
      }
      if (s.status === 'done' || s.status === 'canceled') downloading.value = false
    },
    onDone: () => {
      downloading.value = false
      ElMessage.success(t('common.downloadDone'))
    },
    onError: (msg) => {
      downloading.value = false
      downError.value = msg
    },
  })
}

/** 后台打包：先在服务端生成 zip，完成后以普通文件下载（可断点续传） */
async function startAsyncJob() {
  if (!canArchive.value) return
  jobError.value = ''
  downError.value = ''
  jobPhase.value = 'packing'
  try {
    const created = await api.shares.jobs.create(code, accessCode.value || undefined, mode.value)
    job.value = created
    timer = window.setInterval(() => void pollJob(), 1000)
    await pollJob()
  } catch (e: any) {
    jobPhase.value = 'failed'
    jobError.value = e.message
  }
}

async function pollJob() {
  if (!job.value) return
  try {
    const j = await api.shares.jobs.status(code, job.value.id, accessCode.value || undefined)
    job.value = j
    if (j.status === 'READY') {
      stopPolling()
      jobPhase.value = 'ready'
      downloadJobFile(j)
    } else if (j.status === 'FAILED') {
      stopPolling()
      jobPhase.value = 'failed'
      jobError.value = j.error || t('share.archiveFailed')
    }
  } catch (e: any) {
    stopPolling()
    jobPhase.value = 'failed'
    jobError.value = e.message
  }
}

function downloadJobFile(j: ArchiveJobInfo) {
  const url = api.shares.jobs.fileUrl(code, j.id, accessCode.value || undefined)
  downloading.value = true
  loaded.value = 0
  total.value = Number(j.zipBytes ?? 0)
  speed.value = 0

  control.value = startDownload(url, zipName(), {
    onUpdate: (s) => {
      loaded.value = s.loaded
      if (s.size) total.value = s.size
      speed.value = s.speed
      if (s.status === 'error') {
        downloading.value = false
        downError.value = s.error ?? t('common.downloadFailed')
        // 打包结果已过期（410）就退回初始状态，让用户能重新打包。
        // 这里按**状态码**判断而不是匹配文案 —— 文案会跟着语言变，状态码不会。
        if (s.errorStatus === 410) jobPhase.value = 'none'
      }
      if (s.status === 'done' || s.status === 'canceled') downloading.value = false
    },
    onDone: () => {
      downloading.value = false
      ElMessage.success(t('common.downloadDone'))
    },
    // 不支持流式落盘时退回浏览器原生下载，由浏览器自己续传
    onFallback: () => {
      downloading.value = false
      nativeDownload(url)
    },
  })
}

async function cancelJob() {
  stopPolling()
  if (job.value) {
    await api.shares.jobs.remove(code, job.value.id, accessCode.value || undefined).catch(() => {})
  }
  job.value = null
  jobPhase.value = 'none'
}

function cancelDownload() {
  control.value?.cancel()
  control.value = null
  downloading.value = false
}

function onMainClick() {
  if (jobPhase.value === 'ready' && job.value) {
    downloadJobFile(job.value)
    return
  }
  if (useAsync.value) void startAsyncJob()
  else doArchiveDownload()
}

onMounted(load)
onUnmounted(stopPolling)
</script>

<template>
  <div class="page">
    <div class="lang-bar">
      <LocaleSwitcher />
    </div>

    <div class="box">
      <h2>ShareEverything</h2>

      <template v-if="loading">
        <el-skeleton :rows="3" animated />
      </template>

      <template v-else-if="info">
        <div class="name">
          <el-tag v-if="isDir" size="small" type="warning" class="kind">{{ t('share.file') }}</el-tag>
          {{ info.title }}
        </div>
        <div class="meta">
          <el-tag v-if="info.status === 'ACTIVE'" type="success" size="small">
            {{ t('share.available') }}
          </el-tag>
          <el-tag v-else type="danger" size="small">
            {{
              info.status === 'EXPIRED' ? t('shares.status.expired') : t('shares.status.exhausted')
            }}
          </el-tag>
          <span v-if="info.expiresAt">
            {{ t('share.expiresAt', { time: formatDateTime(info.expiresAt) }) }}
          </span>
          <span v-if="info.maxDownloads">
            {{ t('share.remaining', { n: Math.max(0, info.maxDownloads - info.downloadCount) }) }}
          </span>
        </div>

        <div v-if="info.status === 'ACTIVE' && info.available">
          <el-input
            v-if="info.needAccessCode"
            v-model="accessCode"
            :placeholder="t('share.accessCodePlaceholder')"
            class="code"
          />

          <!-- 单文件：直接下载 -->
          <template v-if="!isDir">
            <el-button
              type="primary"
              class="btn"
              :disabled="info.needAccessCode && !accessCode"
              @click="doDownload"
            >
              {{ t('share.downloadFile') }}
            </el-button>
          </template>

          <!-- 目录：先预检，再打包下载 -->
          <template v-else>
            <el-button
              v-if="!plan && !planLoading"
              type="primary"
              class="btn"
              :disabled="info.needAccessCode && !accessCode"
              @click="loadPlan"
            >
              {{ info.needAccessCode ? t('share.viewFolder') : t('share.replan') }}
            </el-button>

            <div v-if="planLoading" class="hint">{{ t('share.planning') }}</div>

            <el-alert v-if="planError" type="error" :closable="false" :title="planError" />

            <template v-if="plan">
              <div class="stat">
                <span>{{ t('share.statFiles', plan.fileCount) }}</span>
                <span v-if="plan.dirCount">· {{ t('share.statDirs', plan.dirCount) }}</span>
                <span>· {{ t('share.statTotal', { size: humanSize(plan.totalBytes) }) }}</span>
              </div>
              <div class="stat sub">
                {{
                  t('share.zipApprox', {
                    size: plan.zipBytes != null ? humanSize(plan.zipBytes) : t('share.zipUnknown'),
                  })
                }}
                <template v-if="plan.skipped"> · {{ t('share.skipped', plan.skipped) }}</template>
              </div>

              <el-alert
                v-if="plan.truncated"
                class="warn"
                type="warning"
                :closable="false"
                :title="truncatedText"
              />

              <div class="row">
                <span class="label">{{ t('share.modeLabel') }}</span>
                <el-select v-model="mode" size="small" class="mode" @change="loadPlan">
                  <el-option v-for="o in modeOptions" :key="o.value" :label="o.label" :value="o.value" />
                </el-select>
              </div>

              <div v-if="useAsync && jobPhase === 'none'" class="hint">
                {{ t('share.asyncHint') }}
              </div>

              <!-- 后台打包进度 -->
              <div v-if="jobPhase === 'packing' && job" class="progress">
                <el-progress :percentage="job.percent" :stroke-width="10" />
                <div class="hint">
                  {{ job.status === 'QUEUED' ? t('share.queued') : t('share.packing') }}
                  {{ t('share.jobProgress', { done: job.processedFiles, total: job.fileCount }) }}
                  {{
                    t('share.jobBytes', {
                      done: humanSize(Number(job.processedBytes)),
                      total: humanSize(Number(job.totalBytes)),
                    })
                  }}
                </div>
                <el-button size="small" @click="cancelJob">{{ t('share.cancelPack') }}</el-button>
              </div>

              <el-button
                type="primary"
                class="btn"
                :disabled="!canArchive || busy"
                @click="onMainClick"
              >
                {{ jobPhase === 'ready' ? t('share.redownload') : t('share.packAndDownload') }}
              </el-button>

              <!-- 打包结果的下载进度 -->
              <div v-if="downloading" class="progress">
                <el-progress :percentage="percent" :stroke-width="10" />
                <div class="hint">
                  {{ t('share.downloading', { size: humanSize(loaded) }) }}
                  <template v-if="total"> {{ t('share.ofTotal', { size: humanSize(total) }) }}</template>
                  <template v-if="speed"> {{ t('share.speed', { speed: humanSize(speed) }) }}</template>
                  <template v-if="jobPhase === 'ready'"> {{ t('share.resumable') }}</template>
                </div>
                <el-button size="small" @click="cancelDownload">{{ t('common.cancel') }}</el-button>
              </div>

              <el-alert
                v-if="jobError"
                class="warn"
                type="error"
                :closable="false"
                :title="jobError"
              />
              <el-alert v-if="downError" class="warn" type="error" :closable="false" :title="downError" />
            </template>
          </template>
        </div>
        <el-alert v-else type="warning" :closable="false" :title="t('share.unavailable')" />
      </template>

      <el-alert v-else type="error" :closable="false" :title="t('share.notFound')" />
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.lang-bar {
  position: absolute;
  top: 18px;
  right: 24px;
}
.box {
  width: 420px;
  background: #fff;
  padding: 28px;
  border-radius: 10px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}
h2 {
  margin: 0 0 18px;
  font-size: 18px;
  text-align: center;
  color: #303133;
}
.name {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 10px;
  word-break: break-all;
}
.kind {
  margin-right: 6px;
}
.meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #909399;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.code {
  margin-bottom: 12px;
}
.btn {
  width: 100%;
  margin-top: 6px;
}
.stat {
  font-size: 13px;
  color: #303133;
  margin-bottom: 4px;
}
.stat.sub {
  font-size: 12px;
  color: #909399;
  margin-bottom: 12px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.label {
  font-size: 12px;
  color: #606266;
}
.mode {
  flex: 1;
}
.hint {
  font-size: 12px;
  color: #909399;
  margin: 8px 0;
}
.warn {
  margin-bottom: 10px;
}
.progress {
  margin-top: 12px;
}
</style>
