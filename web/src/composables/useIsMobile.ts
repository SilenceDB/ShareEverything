/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * 响应式 `matchMedia`。
 *
 * 只用 CSS 断点做不了「换结构」的活（表格 → 卡片、侧栏 → 抽屉），所以需要
 * 在脚本里也读一次断点。断点数值必须和 `styles/responsive.css` 里的媒体查询
 * **完全一致**，否则会出现「CSS 按手机排、组件还按桌面渲染」的错位。
 */
export function useMediaQuery(query: string): Ref<boolean> {
  // 初始值同步取一次，避免手机上先渲染一帧桌面布局再跳成移动布局
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const matches = ref(supported ? window.matchMedia(query).matches : false)

  let mql: MediaQueryList | null = null
  const onChange = (e: MediaQueryListEvent) => {
    matches.value = e.matches
  }

  onMounted(() => {
    if (!supported) return
    mql = window.matchMedia(query)
    matches.value = mql.matches
    // Safari 13 及更早只有 addListener；这两个分支都要留着，否则老机器上不会跟随旋转
    if (mql.addEventListener) mql.addEventListener('change', onChange)
    else mql.addListener(onChange)
  })

  onBeforeUnmount(() => {
    if (!mql) return
    if (mql.removeEventListener) mql.removeEventListener('change', onChange)
    else mql.removeListener(onChange)
  })

  return matches
}

/** 手机断点：与 responsive.css 的 `@media (max-width: 767px)` 对应 */
export const MOBILE_QUERY = '(max-width: 767px)'

/** 是否手机（窄屏）—— 需要「表格换卡片」「侧栏换抽屉」这类结构变化时用它 */
export function useIsMobile(): Ref<boolean> {
  return useMediaQuery(MOBILE_QUERY)
}
