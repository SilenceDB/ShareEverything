/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

/**
 * 批量上传队列：把「用户一次选中的一堆文件」摊成一条有序队列，按固定并发逐个送进
 * `uploadFile()`。
 *
 * 为什么不直接用 `Promise.all(files.map(uploadFile))`：
 *   单个文件内部已经会开到 4~8 路分片并发，再把几十个文件一起放出去，等于几百个
 *   请求同时打同一个源站。浏览器同源只给 6 条连接，多出去的请求全在本地排队，
 *   结果就是每个文件的进度条一起卡住、谁也不动 —— 看起来像卡死，其实是自己堵自己。
 *   服务端那边还有 `maxConcurrentChunks` 的闸门，撞上去就是一片 429。
 *
 * 所以这里只控制「同时传几个文件」，文件内部的分片并发仍由 uploader 自适应：
 * 单个文件能跑满带宽，多个文件之间又不会互相踩。
 *
 * 任务状态与 uploader 的 `TransferSnapshot` 对齐，界面层不需要区分「排队中」和
 * 「传输中」两套模型 —— 排队中的文件会先给一个 `prepare` 快照，用户在点完选择框的
 * 那一刻就能看到完整列表，这正是批量上传最需要的反馈。
 */
import type { FileItem } from '../api'
import { t } from '../i18n'
import { uploadFile, type TransferControl, type TransferSnapshot } from './uploader'
import type { UploadPolicy } from './uploadPolicy'

/** 一批上传的汇总，界面用它画总进度条 */
export interface BatchSummary {
  total: number
  done: number
  failed: number
  canceled: number
  /** 还没结束的数量（排队 + 正在传 + 暂停） */
  active: number
  loaded: number
  size: number
  speed: number
}

export interface UploadQueueOptions {
  /** 每次启动文件时现取策略：用户中途切换档位，后续文件按新档位走 */
  resolvePolicy: () => UploadPolicy
  /** 同时上传几个文件；不填按策略推导 */
  parallel?: number
  onUpdate: (s: TransferSnapshot) => void
  onSummary: (s: BatchSummary) => void
  /** 新的一批开始时触发（上一批已全部结束），界面可借此清掉上一批的残留行 */
  onBatchStart?: () => void
  onFileDone?: (f: FileItem) => void
  /** 整批结束（成功 / 失败 / 取消都算）时触发一次 */
  onIdle?: (s: BatchSummary) => void
}

interface QueueItem {
  id: string
  file: File
  /** 选中时所在的目录：中途换目录不影响已经排队的文件 */
  parent: string
  state: 'waiting' | 'running' | 'paused' | 'done' | 'error' | 'canceled'
  loaded: number
  /** 已结算（成功/失败/取消），避免重复让出并发位 */
  settled: boolean
  control?: TransferControl
  snapshot: TransferSnapshot
}

/**
 * 同时传几个文件。
 *
 * 取策略硬上限的一半：单个文件内部还要再开若干路分片，两者相乘不能超过服务端
 * `maxConcurrentChunks`（默认 8）。再夹到 1~3，避免几十个小文件时并发过高。
 */
export function defaultParallel(policy: UploadPolicy): number {
  return Math.max(1, Math.min(3, Math.round(policy.hardMaxConcurrency / 2)))
}

export function createUploadQueue(opts: UploadQueueOptions) {
  const items: QueueItem[] = []
  let running = 0
  let seq = 0
  /** 整批已经通报过结束，避免 enqueue 之后立刻又触发一次 */
  let idleNotified = true
  /** 有没有过批次记录：队列项在整批结束后会被清空，只靠 items 判断不出「是否新的一批」 */
  let hasBatch = false
  const parallel = opts.parallel

  function summary(): BatchSummary {
    let done = 0
    let failed = 0
    let canceled = 0
    let active = 0
    let loaded = 0
    let size = 0
    let speed = 0
    for (const it of items) {
      size += it.file.size
      if (it.state === 'done') {
        done++
        loaded += it.file.size
      } else if (it.state === 'error') {
        failed++
        loaded += Math.min(it.loaded, it.file.size)
      } else if (it.state === 'canceled') {
        canceled++
        loaded += Math.min(it.loaded, it.file.size)
      } else {
        active++
        loaded += Math.min(it.loaded, it.file.size)
        if (it.snapshot.status === 'running') speed += it.snapshot.speed
      }
    }
    return { total: items.length, done, failed, canceled, active, loaded, size, speed }
  }

  function emitSummary() {
    opts.onSummary(summary())
  }

  function emitIdleIfDone() {
    if (running > 0 || idleNotified || !items.length) return
    idleNotified = true
    hasBatch = true
    const s = summary()
    opts.onIdle?.(s)
    /**
     * 整批结束后丢掉队列项，把 File 引用放掉。
     *
     * 一批几十张手机照片就是一两百 MB 的 blob，留在队列里等于让标签页一直背着；
     * 界面上要显示的进度早已以快照形式交给调用方，不再需要原始 File。
     */
    items.length = 0
  }

  function start(it: QueueItem) {
    it.state = 'running'
    running++
    it.control = uploadFile(it.file, it.parent, {
      policy: opts.resolvePolicy(),
      onUpdate: (s) => {
        // key 换成队列自己的 id：uploadFile 每次建的 key 界面拿不到，而暂停/取消
        // 按钮需要从快照反查回队列项
        it.snapshot = { ...s, key: it.id }
        it.loaded = s.loaded
        if (s.status === 'done') settle(it, 'done')
        else if (s.status === 'error') settle(it, 'error')
        else if (s.status === 'canceled') settle(it, 'canceled')
        opts.onUpdate(it.snapshot)
        emitSummary()
      },
      onDone: (f) => opts.onFileDone?.(f),
    })
  }

  /**
   * 结算一个文件并让出并发位。
   *
   * uploadFile 在 done 之后还会再 emit 一次（loaded 修正为满值），所以必须用
   * settled 兜住，否则 running 会被减成负数，队列就再也不会启动了。
   */
  function settle(it: QueueItem, state: 'done' | 'error' | 'canceled') {
    if (it.settled) {
      it.state = state
      return
    }
    it.settled = true
    it.state = state
    running = Math.max(0, running - 1)
    // 让出位置后立刻补下一个；用微任务避免在 uploadFile 的同步 emit 里递归太深
    queueMicrotask(() => {
      pump()
      emitIdleIfDone()
    })
  }

  function pump() {
    const cap = Math.max(1, parallel ?? defaultParallel(opts.resolvePolicy()))
    for (const it of items) {
      if (running >= cap) break
      if (it.state === 'waiting') start(it)
    }
  }

  function find(id: string) {
    return items.find((it) => it.id === id)
  }

  function pause(id: string) {
    const it = find(id)
    if (!it || it.settled || it.state === 'paused') return
    if (it.state === 'waiting') {
      it.state = 'paused'
      it.snapshot = { ...it.snapshot, status: 'paused', note: undefined }
      opts.onUpdate(it.snapshot)
      emitSummary()
      return
    }
    it.control?.pause()
  }

  function resume(id: string) {
    const it = find(id)
    if (!it || it.settled) return
    if (it.state === 'paused') {
      it.state = 'waiting'
      it.snapshot = { ...it.snapshot, status: 'prepare', note: t('transferNote.queued') }
      opts.onUpdate(it.snapshot)
      pump()
      emitSummary()
      return
    }
    it.control?.resume()
  }

  function cancel(id: string) {
    const it = find(id)
    if (!it || it.settled) return
    if (it.state === 'waiting' || it.state === 'paused') {
      it.state = 'canceled'
      it.settled = true
      it.snapshot = { ...it.snapshot, status: 'canceled', note: undefined }
      opts.onUpdate(it.snapshot)
      emitSummary()
      // 取消排队项不占并发位，但仍可能是最后一个未结算项
      queueMicrotask(() => {
        pump()
        emitIdleIfDone()
      })
      return
    }
    it.control?.cancel()
  }

  return {
    /** 入队一个文件，返回队列 id（界面用它关联暂停/取消按钮） */
    enqueue(file: File, parent: string): string {
      // 上一批已经全部结束（或已在结束时清空）：这算新的一批，先让界面清掉旧记录
      const newBatch = hasBatch && (items.length === 0 || items.every((it) => it.settled))
      if (newBatch) {
        items.length = 0
        opts.onBatchStart?.()
      }
      hasBatch = true
      idleNotified = false
      const id = `${Date.now().toString(36)}-${(++seq).toString(36)}`
      const item: QueueItem = {
        id,
        file,
        parent,
        state: 'waiting',
        loaded: 0,
        settled: false,
        snapshot: {
          key: id,
          name: file.name,
          size: file.size,
          status: 'prepare',
          loaded: 0,
          progress: 0,
          speed: 0,
          note: t('transferNote.queued'),
        },
      }
      items.push(item)
      opts.onUpdate(item.snapshot)
      pump()
      emitSummary()
      return id
    },

    pause,
    resume,
    cancel,

    pauseAll() {
      for (const it of [...items]) if (!it.settled) pause(it.id)
    },

    resumeAll() {
      for (const it of [...items]) if (!it.settled) resume(it.id)
    },

    cancelAll() {
      for (const it of [...items]) if (!it.settled) cancel(it.id)
    },
  }
}

export type UploadQueue = ReturnType<typeof createUploadQueue>
