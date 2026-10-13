/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { en } from './en.js'

export type Locale = 'zh-CN' | 'en-US'

export const DEFAULT_LOCALE: Locale = 'zh-CN'
export const SUPPORTED_LOCALES: Locale[] = ['zh-CN', 'en-US']

/**
 * 语言从哪里来。
 *
 * 优先读自定义头 `X-Locale`：`Accept-Language` 是浏览器的**禁止头**，JS 改不动它，
 * 它反映的是操作系统语言而非用户在界面里选的语言。所以前端切语言时必须靠自定义头，
 * 拿不到时才退回 `Accept-Language`（比如直接用 curl 调接口）。
 */
export const LOCALE_HEADER = 'x-locale'

/** 把各种写法的语言标签归一成我们支持的两种；不认识返回 null */
function normalize(tag: unknown): Locale | null {
  if (typeof tag !== 'string') return null
  const t = tag.trim().toLowerCase()
  if (!t) return null
  if (t === 'zh' || t.startsWith('zh-')) return 'zh-CN'
  if (t === 'en' || t.startsWith('en-')) return 'en-US'
  return null
}

/**
 * 解析本次请求该用哪种语言。
 *
 * 注意：这里按小写头名取值。Node 的 HTTP 解析器会把收到的头名统一小写，
 * 所以客户端发 `X-Locale` 也会以 `x-locale` 出现 —— 值的大小写不敏感由 normalize 兜住。
 */
export function localeFromRequest(req: {
  headers: Record<string, unknown>
}): Locale {
  const explicit = normalize(req.headers[LOCALE_HEADER])
  if (explicit) return explicit

  const accept = req.headers['accept-language']
  if (typeof accept === 'string') {
    // 形如 `zh-CN,zh;q=0.9,en;q=0.8`，按声明顺序取第一个能认出来的
    for (const part of accept.split(',')) {
      const hit = normalize(part.split(';')[0])
      if (hit) return hit
    }
  }
  return DEFAULT_LOCALE
}

/** 把模板里的 `{}` 按顺序替换成参数 */
function fill(template: string, params?: (string | number)[]): string {
  if (!params?.length) return template
  let i = 0
  return template.replace(/\{\}/g, () => String(params[i++] ?? ''))
}

/**
 * 取词。key 就是中文原文；中文直接回填模板，英文查表。
 *
 * 查不到时**原样返回中文**而不是抛错或返回 key —— 漏译的后果只是夹一句中文，
 * 不会把界面搞成一片 `files.title` 之类的占位符。
 */
export function t(locale: Locale, key: string, params?: (string | number)[]): string {
  if (locale !== 'zh-CN') {
    const hit = en[key]
    if (hit) return fill(hit, params)
  }
  return fill(key, params)
}

/**
 * 翻译一个错误对象。
 *
 * 这里用**结构类型**而不是 `instanceof AppError`，是为了让 i18n 模块不反向依赖
 * utils/fs.ts（那会让「谁都能引用的工具层」变成环）。凡是长成这个形状的都能翻。
 */
export interface TranslatableError {
  message: string
  i18n?: { key: string; params?: (string | number)[] }
}

export function translateError(locale: Locale, err: TranslatableError): string {
  return t(locale, err.i18n?.key ?? err.message, err.i18n?.params)
}
