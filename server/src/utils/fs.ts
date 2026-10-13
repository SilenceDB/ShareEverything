/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import path from 'node:path'
import fs from 'node:fs'

/**
 * 需要带参数的错误文案，额外挂一份「模板 + 参数」给翻译层用。
 *
 * 为什么不能只靠 message：message 已经是插值后的成品（中文），翻译层拿它查不到表。
 * 所以这里同时给出带 `{}` 占位符的模板，两边各取所需：
 *   message 给中文用（也是日志里看到的），i18n 给英文用。
 */
export interface AppErrorI18n {
  key: string
  params?: (string | number)[]
}

export class AppError extends Error {
  statusCode: number
  /** 只有需要插值的文案才需要它；静态文案留空即可，翻译层会拿 message 当键 */
  i18n?: AppErrorI18n

  constructor(message: string, statusCode = 400, i18n?: AppErrorI18n) {
    super(message)
    this.statusCode = statusCode
    this.i18n = i18n
  }
}

/** 把用户传入的相对路径规整化，剔除 .. 与多余分隔符 */
export function normalizeRel(rel: string): string {
  return (rel ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/')
}

/** Windows 文件系统大小写不敏感，比较时统一小写；其他平台保持原样 */
function cmp(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * 在 root 之内拼接路径，越界直接抛错。
 * 这是防止 ../ 目录穿越的唯一入口，所有涉及用户传入路径的地方都必须走这里。
 */
export function safeJoin(root: string, rel: string): string {
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, normalizeRel(rel))
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new AppError('非法路径：不允许访问根目录之外的位置', 403)
  }
  return abs
}

export function assertInside(root: string, abs: string): void {
  const rootAbs = path.resolve(root)
  const target = path.resolve(abs)
  if (cmp(target) !== cmp(rootAbs) && !cmp(target).startsWith(cmp(rootAbs) + path.sep)) {
    throw new AppError('非法路径：不允许访问根目录之外的位置', 403)
  }
}

/** 把根目录自身也解析成真实路径（根目录本身可能是软链接 / junction） */
export function realRoot(root: string): string {
  try {
    return fs.realpathSync(path.resolve(root))
  } catch {
    throw new AppError('根目录不存在或无法访问', 404)
  }
}

/**
 * 解析出真实绝对路径，并确保「跟随软链接之后」仍落在 root 之内。
 *
 * 顺序很关键：先 safeJoin 挡住 ../ 穿越，再 realpathSync 展开软链接，
 * 最后用真实位置再校验一次。
 *
 * 语义：根内部的软链接属于正常用法，正常放行、读到的就是原始文件；
 * 只有指向根外部的软链接（escaping link）才判定为越界并拒绝。
 */
export function resolveInside(root: string, rel: string): string {
  const rootAbs = realRoot(root)
  const joined = safeJoin(rootAbs, rel)
  let real: string
  try {
    real = fs.realpathSync(joined)
  } catch {
    throw new AppError('文件或目录不存在', 404)
  }
  assertInside(rootAbs, real)
  return real
}

/**
 * 判断某个条目是否指向根外部。只对软链接 / junction 做 realpath，普通条目直接放行，
 * 避免给目录浏览增加无谓的开销。返回 true 表示应被过滤掉。
 */
export function isEscapeLink(rootAbs: string, entryPath: string): boolean {
  let st: fs.Stats
  try {
    st = fs.lstatSync(entryPath)
  } catch {
    return true
  }
  // 实测（Node 22 / Windows）：junction 与 symlink 的 lstat 都是 isSymbolicLink() === true，
  // 所以这里不需要为 Windows 的目录联接单独加判断，普通文件/目录直接放行。
  if (!st.isSymbolicLink()) return false
  try {
    assertInside(rootAbs, fs.realpathSync(entryPath))
    return false
  } catch {
    return true
  }
}

export function fileSize(abs: string): number {
  try {
    return fs.statSync(abs).size
  } catch {
    return 0
  }
}

export function isDirectory(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory()
  } catch {
    return false
  }
}

export function humanSize(bytes: number | bigint): string {
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(2)} ${units[i]}`
}
