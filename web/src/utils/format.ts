/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { appLocale } from '../i18n'

export function humanSize(bytes: number | string): string {
  const n = typeof bytes === 'string' ? Number(bytes) : bytes
  if (!n || n < 0) return '0 B'
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

/**
 * 按**当前界面语言**格式化日期时间。
 *
 * 必须显式传 locale：`toLocaleString()` 不带参数时跟的是浏览器/操作系统的语言，
 * 于是会出现「界面切到英文、日期却还是中文格式」这种自相矛盾的显示。
 * 在模板里调用即可 —— 渲染期间读 `i18n.global.locale` 会建立响应式依赖，切语言自动重渲染。
 */
export function formatDateTime(value: number | string | Date): string {
  return new Date(value).toLocaleString(appLocale())
}

/** 路径太长时保留头尾，中间省略，避免撑破弹窗 */
export function ellipsisPath(p: string, max = 68): string {
  if (p.length <= max) return p
  const head = Math.ceil((max - 3) / 2)
  const tail = Math.floor((max - 3) / 2)
  return `${p.slice(0, head)}...${p.slice(p.length - tail)}`
}
