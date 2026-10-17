/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { prisma } from '../db.js'
import { AppError } from './fs.js'

/** 发布项的可见范围 */
export type Visibility = 'PUBLIC' | 'PRIVATE' | 'PROTECTED'

export const VISIBILITIES: readonly Visibility[] = ['PUBLIC', 'PRIVATE', 'PROTECTED']

/** 默认 PUBLIC：与「资源库本来就是全站共享」的既有行为保持一致 */
export const DEFAULT_VISIBILITY: Visibility = 'PUBLIC'

export function normalizeVisibility(raw: unknown): Visibility {
  const v = String(raw ?? DEFAULT_VISIBILITY).trim().toUpperCase()
  if (!VISIBILITIES.includes(v as Visibility)) {
    throw new AppError('可见性只能是 PUBLIC / PRIVATE / PROTECTED')
  }
  return v as Visibility
}

type Viewer = { id: string; role: string }

type Node = { id: string; userId: string; parentId: string | null; visibility: string }

/**
 * 单个节点对某个人是否开放 —— **只判这一层，不看祖先**。
 *
 * 三种口径：
 * - 管理员一律放行：否则别人设成私有的项出问题，管理员既看不见也删不掉
 *   （与「改名 / 移动 / 取消发布限发布者或管理员」是同一套口径）
 * - 发布者本人一律放行
 * - PUBLIC 放行 / PRIVATE 拒绝 / PROTECTED 看授权名单
 */
function selfOpen(node: Node, viewer: Viewer, granted: Set<string>): boolean {
  if (viewer.role === 'ADMIN') return true
  if (node.userId === viewer.id) return true
  if (node.visibility === 'PUBLIC') return true
  if (node.visibility === 'PRIVATE') return false
  return granted.has(node.id)
}

/** 该用户被显式授权的发布项 id（PROTECTED 用得上） */
async function grantedIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.mountGrant.findMany({
    where: { userId },
    select: { mountId: true },
  })
  return new Set(rows.map((r) => r.mountId))
}

/**
 * 把「自身是否开放」沿树传播成「实际是否可见」。
 *
 * 规则是**父级收紧则整棵子树一并收紧**：只要路径上任何一级不对你开放，
 * 下面所有层级就都看不见。这样把文件夹设成 PRIVATE 就等于整条分支对外关闭，
 * 不会出现「以为关了、其实子节点还是 PUBLIC 被看见」的情况。
 *
 * 用反复传播而不是一次 DFS，是为了不依赖遍历顺序：
 * 子节点完全可能先于父节点被处理，多跑几轮自然收敛（节点量级是几百，开销可忽略）。
 */
function propagate(nodes: Node[], viewer: Viewer, granted: Set<string>): Set<string> {
  const visible = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const n of nodes) {
      if (visible.has(n.id)) continue
      const parentOk = !n.parentId || visible.has(n.parentId)
      if (parentOk && selfOpen(n, viewer, granted)) {
        visible.add(n.id)
        changed = true
      }
    }
  }
  return visible
}

/** 这个用户能在资源库里看到的全部节点 id */
export async function visibleMountIds(viewer: Viewer): Promise<Set<string>> {
  const nodes = await prisma.mount.findMany({
    select: { id: true, userId: true, parentId: true, visibility: true },
  })
  return propagate(nodes, viewer, await grantedIds(viewer.id))
}

/**
 * 某个发布项对这个人是否可见（含祖先链）。
 *
 * 只查这一条链而不是全表 —— browse / download / 建分享都是单节点操作，
 * 没必要为了一次判定把整棵树拉出来。
 */
export async function canSeeMount(id: string, viewer: Viewer): Promise<boolean> {
  const granted = await grantedIds(viewer.id)
  let cur: Node | null = await prisma.mount.findUnique({
    where: { id },
    select: { id: true, userId: true, parentId: true, visibility: true },
  })
  let guard = 0
  while (cur && guard++ < 100) {
    if (!selfOpen(cur, viewer, granted)) return false
    if (!cur.parentId) return true
    cur = await prisma.mount.findUnique({
      where: { id: cur.parentId },
      select: { id: true, userId: true, parentId: true, visibility: true },
    })
  }
  return false
}

/**
 * 校验可见性，不可见直接抛 404。
 *
 * 刻意复用「发布不存在」而不是「没有权限」：**不泄露这一项是否存在**。
 * 否则别人拿着 id 遍历，就能靠错误码差异把私有发布项的存在性探出来。
 */
export async function assertMountVisible(id: string, viewer: Viewer): Promise<void> {
  if (!(await canSeeMount(id, viewer))) throw new AppError('发布不存在', 404)
}

/** 校验授权名单里的用户都真实存在，返回去重后的 id 列表 */
export async function resolveGrantUserIds(raw: unknown): Promise<string[]> {
  const list = Array.isArray(raw) ? raw : []
  const ids = [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))]
  if (!ids.length) return []
  const found = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } })
  if (found.length !== ids.length) throw new AppError('指定的用户不存在', 400)
  return ids
}
