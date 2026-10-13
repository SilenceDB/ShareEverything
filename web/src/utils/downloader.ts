/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { t } from '../i18n'
import type { TransferControl, TransferSnapshot, TransferStatus } from './uploader'

const PULL_SIZE = 4 * 1024 * 1024

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface WritableFileStream {
  seek(position: number): Promise<void>
  write(data: BufferSource): Promise<void>
  close(): Promise<void>
  abort(reason?: string): Promise<void>
}

interface FileHandleLike {
  createWritable(): Promise<WritableFileStream>
}

type SaveFilePicker = (opts: {
  suggestedName?: string
}) => Promise<FileHandleLike>

function picker(): SaveFilePicker | null {
  const w = window as unknown as { showSaveFilePicker?: SaveFilePicker }
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker : null
}

/**
 * 在异步闭包里重新取一次。
 * 外层虽然已经 `if (!pick) return null`，但闭包内 TS 不沿用该判空推断，
 * 所以这里再确认一遍；正常运行不会走到抛错分支（没有 picker 时压根不会进闭包）。
 */
function requirePicker(): SaveFilePicker {
  const p = picker()
  if (!p) throw new Error(t('downloadError.noPicker'))
  return p
}

/** 浏览器是否支持流式落盘（Chrome / Edge 支持；Firefox、Safari 暂不支持） */
export function canStreamDownload(): boolean {
  return picker() !== null
}

/** 回退：交给浏览器原生下载，它自己会利用服务端的 Accept-Ranges 做续传 */
export function nativeDownload(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * 流式下载：按 4MB 一段用 Range 拉取并直接写入用户选择的文件，
 * 因此不需要在内存里攒整个大文件，也能暂停 / 继续 / 断点续传。
 *
 * 返回 null 表示当前浏览器不支持，调用方应回退到 nativeDownload。
 */
export function startDownload(
  url: string,
  filename: string,
  opts: {
    onUpdate: (s: TransferSnapshot) => void
    onDone?: () => void
    onFallback?: () => void
  },
): TransferControl | null {
  const pick = picker()
  if (!pick) {
    opts.onFallback?.()
    return null
  }

  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let status: TransferStatus = 'prepare'
  let offset = 0
  let total = 0
  let errorMsg: string | undefined
  /** 出错时的 HTTP 状态码；调用方按它判断情况，不去匹配文案（见 TransferSnapshot 注释） */
  let errorStatus: number | undefined
  let startedAt = Date.now()
  let paused = false
  let canceled = false

  function emit() {
    const elapsed = (Date.now() - startedAt) / 1000
    opts.onUpdate({
      key,
      name: filename,
      size: total,
      status,
      loaded: offset,
      progress: total ? Math.min(100, Math.round((offset * 100) / total)) : 0,
      speed: elapsed > 0.5 && status === 'running' ? Math.round(offset / elapsed) : 0,
      error: errorMsg,
      errorStatus,
    })
  }

  async function run() {
    let writable: WritableFileStream | null = null
    try {
      status = 'prepare'
      emit()

      // 先探测总长度，顺便确认服务端支持 Range
      const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } })
      if (!probe.ok && probe.status !== 206) {
        errorStatus = probe.status
        throw new Error(t('downloadError.httpError', { status: probe.status }))
      }
      const cr = probe.headers.get('content-range')
      total = cr ? Number(cr.split('/')[1]) : Number(probe.headers.get('content-length') ?? 0)
      await probe.body?.cancel().catch(() => {})
      if (!total) throw new Error(t('downloadError.noLength'))

      const handle = await requirePicker()({ suggestedName: filename })
      writable = await handle.createWritable()
      status = 'running'
      startedAt = Date.now()
      emit()

      while (offset < total) {
        if (canceled) break
        while (paused) {
          await sleep(200)
          if (canceled) break
        }
        if (canceled) break

        const end = Math.min(offset + PULL_SIZE - 1, total - 1)
        let res: Response | null = null
        for (let attempt = 0; attempt < 3 && !res; attempt++) {
          try {
            const r = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } })
            if (r.ok || r.status === 206) {
              res = r
            } else {
              errorStatus = r.status
              throw new Error(t('downloadError.httpError', { status: r.status }))
            }
          } catch (e) {
            if (attempt === 2) throw e
            await sleep(500 * (attempt + 1))
          }
        }

        const reader = res!.body?.getReader()
        if (!reader) throw new Error(t('downloadError.noReader'))
        // 从当前进度写起：中断恢复时不会重复写入已落盘的部分
        await writable.seek(offset)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (canceled) break
          await writable.write(value)
          offset += value.byteLength
          emit()
        }
      }

      if (canceled) {
        await writable.abort(t('downloadError.canceled'))
        return
      }
      await writable.close()
      status = 'done'
      emit()
      opts.onDone?.()
    } catch (e: any) {
      if (canceled) return
      if (writable) await writable.abort(t('downloadError.aborted')).catch(() => {})
      // 用户在选择保存位置时点了取消
      if (e?.name === 'AbortError') {
        status = 'canceled'
        emit()
        return
      }
      status = 'error'
      errorMsg = e?.message ?? t('common.downloadFailed')
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
    },
  }
}

/**
 * 整段流下载：一次请求拿完整响应体，不做 Range 分段。
 *
 * 目录打包生成的 ZIP 是即时流式产出的，服务端无法提供断点续传，
 * 所以这里只能一气呵成地写进用户选择的文件，同样不在内存里攒整个包。
 * 不支持流式落盘的浏览器会走 onFallback（通常是原生下载）。
 */
export function startStreamDownload(
  url: string,
  filename: string,
  opts: {
    onUpdate: (s: TransferSnapshot) => void
    onDone?: () => void
    onError?: (msg: string) => void
    onFallback?: () => void
  },
): TransferControl | null {
  const pick = picker()
  if (!pick) {
    opts.onFallback?.()
    return null
  }

  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let status: TransferStatus = 'prepare'
  let offset = 0
  let total = 0
  let errorMsg: string | undefined
  let errorStatus: number | undefined
  let startedAt = Date.now()
  let canceled = false

  function emit() {
    const elapsed = (Date.now() - startedAt) / 1000
    opts.onUpdate({
      key,
      name: filename,
      size: total,
      status,
      loaded: offset,
      progress: total ? Math.min(100, Math.round((offset * 100) / total)) : 0,
      speed: elapsed > 0.5 && status === 'running' ? Math.round(offset / elapsed) : 0,
      error: errorMsg,
      errorStatus,
    })
  }

  async function run() {
    let writable: WritableFileStream | null = null
    try {
      status = 'prepare'
      emit()

      const res = await fetch(url)
      if (!res.ok) {
        errorStatus = res.status
        let msg = t('downloadError.httpError', { status: res.status })
        try {
          const data = await res.json()
          // 服务端已经按请求语言返回了错误文案，直接用它
          if (data?.error) msg = data.error
        } catch {
          /* 响应不是 JSON 就用默认文案 */
        }
        throw new Error(msg)
      }
      total = Number(res.headers.get('content-length') ?? 0)

      const handle = await requirePicker()({ suggestedName: filename })
      writable = await handle.createWritable()
      status = 'running'
      startedAt = Date.now()
      emit()

      const reader = res.body?.getReader()
      if (!reader) throw new Error(t('downloadError.noReader'))
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (canceled) break
        await writable.write(value)
        offset += value.byteLength
        emit()
      }

      if (canceled) {
        await writable.abort(t('downloadError.canceled'))
        return
      }
      await writable.close()
      status = 'done'
      emit()
      opts.onDone?.()
    } catch (e: any) {
      if (writable) await writable.abort(t('downloadError.aborted')).catch(() => {})
      if (canceled) return
      // 用户在选择保存位置时点了取消
      if (e?.name === 'AbortError') {
        status = 'canceled'
        emit()
        return
      }
      status = 'error'
      errorMsg = e?.message ?? t('common.downloadFailed')
      emit()
      opts.onError?.(errorMsg ?? t('common.downloadFailed'))
    }
  }

  void run()

  return {
    key,
    pause() {
      /* 整段流无法暂停，只能取消 */
    },
    resume() {},
    cancel() {
      canceled = true
      status = 'canceled'
      emit()
    },
  }
}
