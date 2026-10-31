/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { AppError } from './fs.js'

/**
 * 一次批量操作的条目上限。
 *
 * 单层目录正常也就几十条，200 足够覆盖「全选」；再高的值既没有实际场景，
 * 又会让单个请求在权限校验和磁盘回收上停留太久（Node 是单线程，
 * 几百次同步 rmSync 会把其它请求一起卡住）。
 */
export const MAX_BATCH_ITEMS = 200

/**
 * 把请求体里的 ids 收敛成去重后的字符串数组。
 *
 * 只做「形状」校验，不做存在性判断 —— 哪个 id 属于谁、能不能删，
 * 由各路由结合自己的数据表决定。上限在这里统一拦，
 * 免得两个批量接口各写一套、文案还对不上。
 */
export function parseIdList(raw: unknown, max = MAX_BATCH_ITEMS): string[] {
  const list = Array.isArray(raw) ? raw : []
  const ids = [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))]
  if (!ids.length) throw new AppError('请先选择要操作的项目')
  if (ids.length > max) throw new AppError(`一次最多操作 ${max} 项，请分批进行`)
  return ids
}
