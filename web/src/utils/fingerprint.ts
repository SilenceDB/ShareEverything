/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

const SAMPLE = 1024 * 1024

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 抽样指纹：只取文件头 / 中 / 尾各 1MB 参与计算，大文件也能在毫秒级算完。
 * 仅用于秒传判定，不做内容校验，所以碰撞风险可以接受。
 *
 * 非安全上下文（http 且非 localhost）下 crypto.subtle 不可用，此时返回空串跳过秒传，
 * 分片上传与断点续传不受影响。
 */
export async function sampleFingerprint(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) return ''
  const parts: Blob[] = []
  if (file.size <= SAMPLE * 3) {
    parts.push(file)
  } else {
    const mid = Math.floor(file.size / 2)
    parts.push(file.slice(0, SAMPLE))
    parts.push(file.slice(mid, mid + SAMPLE))
    parts.push(file.slice(file.size - SAMPLE))
  }
  const buf = await new Blob(parts).arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return `sampled:${toHex(digest)}:${file.size}`
}
