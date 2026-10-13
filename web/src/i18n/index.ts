/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { createI18n } from 'vue-i18n'
import elEn from 'element-plus/es/locale/lang/en'
import elZhCn from 'element-plus/es/locale/lang/zh-cn'
import enUS from '../locales/en-US'
import zhCN from '../locales/zh-CN'

export type AppLocale = 'zh-CN' | 'en-US'

/** 用户选择的语言存在这里，下一次打开沿用；未选择过则按浏览器语言猜 */
export const LOCALE_STORAGE_KEY = 'se_locale'

/**
 * 语言下拉里的选项。
 * label 用**该语言自己的写法**，不跟随当前界面语言 —— 中文界面下也显示 "English"，
 * 否则一个只看不懂当前语言的人根本找不到切回去的入口。
 */
export const SUPPORTED_LOCALES: { value: AppLocale; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' }, // i18n-ignore 语言名必须自指，不翻译
  { value: 'en-US', label: 'English' },
]

export const FALLBACK_LOCALE: AppLocale = 'zh-CN'

export function isAppLocale(v: unknown): v is AppLocale {
  return v === 'zh-CN' || v === 'en-US'
}

/** 首次访问时按浏览器语言猜一个：认不出来就回中文 */
export function detectLocale(): AppLocale {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
  if (isAppLocale(saved)) return saved
  const nav = (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase()
  if (nav.startsWith('en')) return 'en-US'
  if (nav.startsWith('zh')) return 'zh-CN'
  return FALLBACK_LOCALE
}

export const i18n = createI18n({
  // 组合式 API。全局注入 $t，模板里可以直接用，不必每个组件都写 useI18n
  legacy: false,
  globalInjection: true,
  locale: detectLocale(),
  fallbackLocale: FALLBACK_LOCALE,
  messages: { 'zh-CN': zhCN, 'en-US': enUS },
  // 缺键时静默回退到 fallbackLocale，别在控制台刷一屏警告
  missingWarn: false,
  fallbackWarn: false,
})

/** 当前语言（响应式） */
export function appLocale(): AppLocale {
  return i18n.global.locale.value as AppLocale
}

export function setLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale
  localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  document.documentElement.lang = locale
}

/** 应用启动时把 <html lang> 与语言状态对齐（index.html 里写死的是 zh-CN） */
export function syncDocumentLang(): void {
  document.documentElement.lang = appLocale()
}

/**
 * Element Plus 组件自身的文案（分页、日期选择、上传、确认框按钮…）跟着一起切。
 * 它有自己的语言包，与 vue-i18n 是两套，必须手动对应。
 */
export const ELEMENT_LOCALES: Record<AppLocale, typeof elZhCn> = {
  'zh-CN': elZhCn,
  'en-US': elEn as unknown as typeof elZhCn,
}

/**
 * 给**组件之外**的普通模块（工具函数、上传/下载器）取词用。
 *
 * 它读的是全局语言，但不建立响应式依赖 —— 这些函数都是即时执行的，
 * 拿到的就是调用那一刻的语言，正是我们要的。
 */
export function t(key: string, arg?: number | Record<string, unknown>): string {
  return (
    typeof arg === 'number'
      ? i18n.global.t(key, arg)
      : i18n.global.t(key, arg ?? {})
  ) as string
}
