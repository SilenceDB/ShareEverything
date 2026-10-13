/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { ref } from 'vue'
import { api } from '../api'

/**
 * 当前部署的版本号 —— 由打包脚本按「发包时刻」生成，形如 2026.10.12.1031。
 * 界面角落里显示它，是为了线上出问题时能一眼对上是哪个包。
 */
export const appVersion = ref('')
/** 打包时间，用于悬浮提示 */
export const appBuiltAt = ref('')

let pending: Promise<void> | null = null

/**
 * 只查一次：版本号在一次部署内不会变，整个会话共用同一个请求。
 * 失败就静默留空——版本只是展示信息，不该为此弹错误提示打扰用户。
 */
export function loadAppVersion(): Promise<void> {
  if (!pending) {
    pending = api
      .version()
      .then((info) => {
        appVersion.value = info.version || ''
        appBuiltAt.value = info.builtAt || ''
      })
      .catch(() => {
        /* 拿不到就不显示 */
      })
  }
  return pending
}
