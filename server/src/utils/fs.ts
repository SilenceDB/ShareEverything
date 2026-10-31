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
 * 「目录前缀」：用于判断 target 是否在 root 之内。
 *
 * 必须处理 root 自身已带分隔符的情况 —— 盘符根是 `D:\`，直接拼一个就变成 `D:\\`，
 * 于是 `D:\foo` 永远比不上、判定为越界。发布整个盘（`MOUNT_ALLOWED_ROOTS=D:\`）时
 * 会踩到这一条，表现为「选得到但一发布就 403」。
 */
export function dirPrefix(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep
}

/** 单段名称的最大字节数（UTF-8）；主流文件系统都以 255 字节为上限 */
const MAX_NAME_BYTES = 255

/**
 * Windows 保留设备名。
 *
 * 只要「第一个点之前的部分」命中就不行 —— `NUL.txt`、`CON.log` 一样会被当成设备。
 * 这类名字在 Windows 上要么创建失败，要么造出一个删不掉的东西（本项目就吃过 `NUL` 的亏）。
 */
const RESERVED_NAME = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/i

/**
 * 文件系统不允许的字符。
 *
 * - `< > : " | ? *`：Windows 非法；其中 `:` 在 macOS 上还会被显示成 `/`，同样不能留
 * - 控制字符：`\u0000-\u001F`、`\u007F`
 * - 双向文本控制符（`\u200E` 等）：不非法，但能做出「显示名与实际名相反」的欺骗文件名
 */
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/

/**
 * 校验「单个文件 / 目录名」，返回可直接落盘的名字；不合法就抛错。
 *
 * 目录穿越本身由 `safeJoin` 挡着，但光有它不够：名称还会被拼成 `relPath` 存进数据库，
 * 库里存什么，后面所有查找、下载、删除就都按什么来。于是下面这些写法都会造成
 * **磁盘与数据库对不上**：
 *
 * - `name = 'a/b'`：`safeJoin` 会规整成两级，但库里记的 `parent` 是父目录，
 *   中间那层没人认领 → 列表里永远看不到它，变成孤儿目录
 * - `name = '报告 '`（尾部空格）或 `'报告.'`（尾部点）：Windows 会**自动裁掉**再落盘，
 *   库里却记着带空格的版本 → 之后按库里的名字去操作，一律「文件或目录不存在」
 * - `name = '..'`：`normalizeRel` 会把它吃掉，实际建出的是别的名字
 *
 * 注意这里是**报错而不是静默改写**：把 `'报告 '` 悄悄 trim 成 `'报告'` 看似贴心，
 * 但用户建的和界面显示的就不是一个名字了，更难排查。
 */
export function assertSafeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw : ''
  if (!name) throw new AppError('名称不能为空')
  if (name.includes('/') || name.includes('\\')) throw new AppError('名称不能包含路径分隔符')
  if (name !== name.trim() || name.endsWith('.')) throw new AppError('名称首尾不能有空格或点')
  if (ILLEGAL_CHARS.test(name)) throw new AppError('名称包含非法字符')
  const stem = name.includes('.') ? name.slice(0, name.indexOf('.')) : name
  if (RESERVED_NAME.test(stem)) throw new AppError('名称不能使用系统保留名')
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) throw new AppError('名称过长', 400)
  return name
}

/**
 * 在 root 之内拼接路径，越界直接抛错。
 * 这是防止 ../ 目录穿越的唯一入口，所有涉及用户传入路径的地方都必须走这里。
 */
export function safeJoin(root: string, rel: string): string {
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, normalizeRel(rel))
  if (abs !== rootAbs && !abs.startsWith(dirPrefix(rootAbs))) {
    throw new AppError('非法路径：不允许访问根目录之外的位置', 403)
  }
  return abs
}

export function assertInside(root: string, abs: string): void {
  const rootAbs = path.resolve(root)
  const target = path.resolve(abs)
  if (cmp(target) !== cmp(rootAbs) && !cmp(target).startsWith(dirPrefix(cmp(rootAbs)))) {
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
