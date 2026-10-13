/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { api, type FileItem, type UploadLimits } from '../api'
import { t } from '../i18n'
import { sampleFingerprint } from './fingerprint'
import {
  getPolicy,
  maxConcurrency,
  resolveChunkSize,
  type UploadPolicy,
} from './uploadPolicy'

export type TransferStatus =
  | 'prepare'
  | 'running'
  | 'paused'
  | 'merging'
  | 'done'
  | 'error'
  | 'canceled'

export interface TransferSnapshot {
  key: string
  name: string
  size: number
  status: TransferStatus
  loaded: number
  progress: number
  speed: number
  note?: string
  error?: string
  /**
   * 出错时的 HTTP 状态码（仅下载侧会填）。
   * 有了它，界面就可以**按状态码**判断该做什么，而不必去匹配错误文案 ——
   * 否则一旦切成英文，`message.includes('过期')` 这类判断就全失效了。
   */
  errorStatus?: number
}

export interface TransferControl {
  /** 任务标识，调用方据此把 control 和面板里的条目对应起来 */
  key: string
  pause(): void
  resume(): void
  cancel(): void
}

/** 小于这个体积走整文件上传，省掉建任务与合并的开销 */
const SMALL_FILE = 8 * 1024 * 1024
const RESUME_KEY_PREFIX = 'se_resume_'
/** 累计分片失败超过这个数才判定整个任务失败，之前都当作需要降速重试 */
const MAX_CHUNK_FAILURES = 12

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function humanSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec < 0) return '-'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let v = bytesPerSec
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

/**
 * 上传一个文件：小文件整传，大文件分片 + 自适应并发 + 失败重试，支持暂停 / 继续 / 取消。
 *
 * 分片大小与并发数由策略推导（见 uploadPolicy.ts），不直接暴露给用户：
 *   - 分片大小按文件体积反推，保证分片总数落在一个合理区间
 *   - 并发数从档位起点开始做慢启动，成功则 +1，失败则减半（AIMD，同 TCP 拥塞控制）
 *   - 并发上限 = min(内存预算 ÷ 分片大小, 档位硬上限, 服务端 maxConcurrentChunks)
 *
 * 断点续传的两个来源：
 *   1. 同一页面内暂停后继续 —— 已完成的分片记在内存集合里
 *   2. 换页面 / 刷新后重选同一文件 —— 用 localStorage 保存的 uploadId 找回服务端残留任务
 */
export function uploadFile(
  file: File,
  parent: string,
  opts: {
    /** 手动指定分片大小（不填则由策略推导） */
    chunkSize?: number
    /** 手动指定并发数（不填则由策略推导并自适应） */
    concurrency?: number
    policy?: UploadPolicy
    onUpdate: (s: TransferSnapshot) => void
    onDone?: (f: FileItem) => void
  },
): TransferControl {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const policy = opts.policy ?? getPolicy()
  // 初值，拿到服务端任务信息后会被服务端生效值覆盖
  let chunkSize = opts.chunkSize ?? resolveChunkSize(file.size, policy)
  const manualConcurrency = opts.concurrency

  let status: TransferStatus = 'prepare'
  let loaded = 0
  let note: string | undefined
  let errorMsg: string | undefined
  let startedAt = Date.now()
  /** 续传时已存在的字节不计入速度，避免刚恢复就显示虚高的速度 */
  let baseLoaded = 0
  let paused = false
  let canceled = false
  let uploadId = ''
  let resumeKey = ''

  function emit() {
    const elapsed = (Date.now() - startedAt) / 1000
    opts.onUpdate({
      key,
      name: file.name,
      size: file.size,
      status,
      loaded: Math.min(loaded, file.size),
      progress: file.size
        ? Math.min(100, Math.round((Math.min(loaded, file.size) * 100) / file.size))
        : 0,
      speed:
        elapsed > 0.5 && status === 'running'
          ? Math.round(Math.max(0, Math.min(loaded, file.size) - baseLoaded) / elapsed)
          : 0,
      note,
      error: errorMsg,
    })
  }

  async function run() {
    try {
      // 小文件：直接整传，进度由 axios 的上传事件驱动
      if (file.size <= SMALL_FILE) {
        status = 'running'
        startedAt = Date.now()
        emit()
        const item = await api.files.upload(file, parent, (p) => {
          loaded = Math.round((p * file.size) / 100)
          emit()
        })
        status = 'done'
        loaded = file.size
        emit()
        opts.onDone?.(item)
        return
      }

      status = 'prepare'
      note = t('transferNote.fingerprint')
      emit()

      const hash = await sampleFingerprint(file)
      let totalChunks = Math.max(1, Math.ceil(file.size / chunkSize))
      let done = new Set<number>()
      let limits: UploadLimits | undefined

      // 先尝试找回上次没传完的任务
      if (hash) {
        resumeKey = RESUME_KEY_PREFIX + hash
        const saved = localStorage.getItem(resumeKey)
        if (saved) {
          try {
            const st = await api.uploads.status(saved)
            if (Number(st.size) === file.size) {
              uploadId = st.uploadId
              totalChunks = st.totalChunks
              // 续传时必须用服务端记录的分片大小，否则切片位置对不上
              chunkSize = st.chunkSize
              done = new Set(st.uploaded)
              note = done.size
                ? t('transferNote.resume', { done: done.size, total: totalChunks })
                : undefined
            }
          } catch {
            localStorage.removeItem(resumeKey)
          }
        }
      }

      if (!uploadId) {
        const init = await api.uploads.init({
          name: file.name,
          size: file.size,
          parent,
          hash: hash || undefined,
          chunkSize,
        })
        if (init.instant && init.file) {
          status = 'done'
          loaded = file.size
          note = t('transferNote.instant')
          emit()
          localStorage.removeItem(resumeKey)
          opts.onDone?.(init.file)
          return
        }
        uploadId = init.uploadId ?? ''
        totalChunks = init.totalChunks ?? totalChunks
        // 服务端可能因为上下限或分片数上限调整过分片大小，以它的值为准
        if (init.chunkSize) chunkSize = init.chunkSize
        limits = init.limits
        done = new Set(init.uploaded ?? [])
        if (hash) localStorage.setItem(resumeKey, uploadId)
      }

      const cap = manualConcurrency
        ? manualConcurrency
        : Math.min(
            maxConcurrency(chunkSize, policy),
            limits?.maxConcurrentChunks ?? Number.POSITIVE_INFINITY,
          )
      let target = Math.min(policy.startConcurrency, cap)

      loaded = Math.min(file.size, done.size * chunkSize)
      status = 'running'
      baseLoaded = loaded
      startedAt = Date.now()
      emit()

      const pending: number[] = []
      for (let i = 0; i < totalChunks; i++) if (!done.has(i)) pending.push(i)
      let cursor = 0
      let active = 0
      let okStreak = 0
      let failures = 0
      let fatal: unknown

      const worker = async () => {
        for (;;) {
          if (canceled || fatal) return
          while (paused) {
            await sleep(250)
            if (canceled || fatal) return
          }
          // 并发目标被下调了，多余的 worker 自然退出
          if (active > target) return
          const index = pending[cursor++]
          if (index === undefined) return

          const start = index * chunkSize
          const blob = file.slice(start, Math.min(start + chunkSize, file.size))
          try {
            await api.uploads.chunk(uploadId, index, blob)
            done.add(index)
            loaded = Math.min(file.size, done.size * chunkSize)
            emit()
            // 慢启动：攒够当前并发数那么多次成功，才再加一路
            okStreak++
            if (!manualConcurrency && okStreak >= target && target < cap) {
              target += 1
              okStreak = 0
            }
          } catch (e) {
            if (canceled) return
            failures++
            if (failures > MAX_CHUNK_FAILURES) {
              fatal = e
              return
            }
            // 失败（含服务端 429）说明并发偏高或网络吃紧：减半、退回队列、退避重试
            if (!manualConcurrency) target = Math.max(1, Math.floor(target / 2))
            okStreak = 0
            pending.push(index)
            note = t('transferNote.retrying', { n: target })
            emit()
            await sleep(400 * Math.min(failures, 6))
          }
        }
      }

      // 调度循环：把 worker 补到 target，直到队列排空
      for (;;) {
        if (canceled) return
        if (fatal) throw fatal
        while (active < target && cursor < pending.length) {
          active++
          void worker().finally(() => {
            active--
          })
        }
        if (cursor >= pending.length && active === 0) break
        await sleep(120)
      }
      if (fatal) throw fatal
      if (canceled) return

      status = 'merging'
      note = t('transferNote.merging')
      emit()

      for (let round = 0; round < 3; round++) {
        const res = await api.uploads.complete(uploadId)
        if (res.done) {
          status = 'done'
          loaded = file.size
          note = undefined
          emit()
          localStorage.removeItem(resumeKey)
          opts.onDone?.(res.file)
          return
        }
        // 少数分片在服务端判定缺失，补传后再合并
        note = t('transferNote.reuploading', res.missing.length)
        emit()
        for (const index of res.missing) {
          const start = index * chunkSize
          const blob = file.slice(start, Math.min(start + chunkSize, file.size))
          let ok = false
          for (let t = 0; t < 3 && !ok; t++) {
            try {
              await api.uploads.chunk(uploadId, index, blob)
              ok = true
            } catch {
              await sleep(500 * (t + 1))
            }
          }
          if (!ok) throw new Error(t('uploadError.reuploadFailed'))
        }
      }
      throw new Error(t('uploadError.mergeFailed'))
    } catch (e: any) {
      if (canceled) return
      status = 'error'
      errorMsg = e?.message ?? t('uploadError.failed')
      emit()
    }
  }

  void run()

  return {
    key,
    pause() {
      if (status === 'done' || status === 'canceled') return
      paused = true
      status = 'paused'
      emit()
    },
    resume() {
      if (status !== 'paused') return
      paused = false
      status = 'running'
      emit()
    },
    cancel() {
      canceled = true
      status = 'canceled'
      emit()
      if (uploadId) void api.uploads.cancel(uploadId).catch(() => {})
      if (resumeKey) localStorage.removeItem(resumeKey)
    },
  }
}
