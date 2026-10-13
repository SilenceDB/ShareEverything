/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db.js'
import { canCreateMount, config, isMountPathAllowed } from '../config.js'
import { AppError, isEscapeLink, normalizeRel, realRoot, resolveInside } from '../utils/fs.js'
import { authGuard } from '../plugins/auth.js'
import { streamFile } from '../utils/stream.js'

const SKIP_NAMES = new Set(['$RECYCLE.BIN', 'System Volume Information', '.DS_Store'])
const KINDS = new Set(['FOLDER', 'DIR', 'FILE'])

type MountRow = {
  id: string
  userId: string
  name: string
  kind: string
  absPath: string | null
  parentId: string | null
  sortOrder: number
  readOnly: boolean
  createdAt: Date
  user?: { id: string; username: string } | null
}

/**
 * 磁盘发布是「全站共享资源库」：所有登录用户都能看到、浏览、下载，
 * userId 只记录是谁发布的，用于决定谁能改名 / 取消发布。
 *
 * 资源库现在是一棵逻辑树：FOLDER 是纯逻辑分组（不对应任何磁盘路径），
 * DIR / FILE 才是真正的磁盘映射。三者共用一张表，所以可以任意嵌套。
 *
 * 理由：能登录本服务的人，本身就拥有「自行发布服务器上任意目录」的能力
 * （发布接口没有路径白名单时），按用户隔离挂载记录只是把入口藏起来，
 * 并不构成真正的边界。所以读权限直接放开，改为把「谁可以发布」和
 * 「能发布哪个范围」收窄（见 config 的 MOUNT_CREATE_ROLE / MOUNT_ALLOWED_ROOTS）。
 */
function dto(m: MountRow, current: { id: string; role: string }) {
  const isOwner = m.userId === current.id
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    absPath: m.absPath,
    parentId: m.parentId,
    sortOrder: m.sortOrder,
    readOnly: m.readOnly,
    createdAt: m.createdAt,
    ownerId: m.userId,
    ownerName: m.user?.username ?? '',
    /** 发布者本人或管理员可以改名 / 移动 / 取消发布 */
    canManage: isOwner || current.role === 'ADMIN',
  }
}

/** 取一条节点，不存在返回 404（不区分「不存在」和「无权」，避免泄露存在性） */
async function getMount(id: string) {
  const mount = await prisma.mount.findUnique({ where: { id }, include: { user: true } })
  if (!mount) throw new AppError('发布不存在', 404)
  return mount
}

function assertCanManage(m: { userId: string }, current: { id: string; role: string }) {
  if (m.userId !== current.id && current.role !== 'ADMIN') {
    throw new AppError('只有发布者本人或管理员可以修改这一项', 403)
  }
}

function normalizeName(raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (!name) throw new AppError('名称不能为空')
  if (name.length > 120) throw new AppError('名称过长（最多 120 个字符）')
  // 名称只是逻辑标签，但混进路径分隔符会让界面和排查都变得难读
  if (/[\\/]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    throw new AppError('名称不能包含路径分隔符或控制字符')
  }
  return name
}

/** 校验父节点：必须是逻辑文件夹（或根） */
async function resolveParent(parentId: string | null | undefined) {
  if (!parentId) return null
  const parent = await prisma.mount.findUnique({ where: { id: parentId } })
  if (!parent) throw new AppError('目标文件夹不存在', 404)
  if (parent.kind !== 'FOLDER') throw new AppError('只能放进逻辑文件夹里')
  return parent
}

/**
 * 同层重名检查。数据库那层拦不住根节点之间的重名
 * （SQLite 认为多个 NULL 互不相同），所以统一在这里校验。
 */
async function assertNameFree(parentId: string | null, name: string, excludeId?: string) {
  const dup = await prisma.mount.findFirst({
    where: {
      parentId: parentId ?? null,
      name,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
  })
  if (dup) throw new AppError('同一层级下已存在同名项目，请换一个名称', 409)
}

/** 不允许与已发布的目录存在包含关系，避免同一批文件在资源库里出现两次 */
async function assertNoDirOverlap(target: string) {
  const dirs = await prisma.mount.findMany({
    where: { kind: 'DIR' },
    select: { absPath: true, name: true },
  })
  for (const d of dirs) {
    if (!d.absPath) continue
    const other = path.resolve(d.absPath)
    if (target.startsWith(other + path.sep) || other.startsWith(target + path.sep)) {
      throw new AppError(`与已发布目录「${d.name}」存在包含关系，请换一个路径`, 400, {
        key: '与已发布目录「{}」存在包含关系，请换一个路径',
        params: [d.name],
      })
    }
  }
}

/** 取某个节点及其全部后代的 id（父在前、子在后） */
async function collectSubtree(rootId: string): Promise<string[]> {
  const all = await prisma.mount.findMany({ select: { id: true, parentId: true } })
  const byParent = new Map<string, string[]>()
  for (const n of all) {
    const key = n.parentId ?? ''
    const list = byParent.get(key)
    if (list) list.push(n.id)
    else byParent.set(key, [n.id])
  }
  const out: string[] = []
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    out.push(id)
    for (const child of byParent.get(id) ?? []) stack.push(child)
  }
  return out
}

/* ---------------- 选择器：服务端磁盘浏览 ---------------- */

/** Windows 上的盘符列表。从 C: 开始，跳过 A:/B:（软驱探测会卡住） */
function listDriveRoots(): string[] {
  if (process.platform !== 'win32') return ['/']
  const out: string[] = []
  for (let i = 67; i <= 90; i++) {
    const drive = `${String.fromCharCode(i)}:\\`
    try {
      if (fs.existsSync(drive)) out.push(drive)
    } catch {
      /* 光驱没放盘之类的探测失败，忽略 */
    }
  }
  return out
}

/** 选择器可用的起始根目录 */
function pickerRoots(): string[] {
  if (config.mountRootsUnrestricted) return listDriveRoots()
  const out: string[] = []
  for (const r of config.mountAllowedRoots) {
    try {
      if (fs.statSync(r).isDirectory()) out.push(fs.realpathSync(r))
    } catch {
      /* 配了但目录还不存在，先不展示 */
    }
  }
  return out
}

function normCase(p: string): string {
  return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
}

/** 找出包含该真实路径的最内层根目录，用于限制「向上」和判断软链接越界 */
function boundaryRoot(realPath: string): string | null {
  const target = normCase(realPath)
  let best: string | null = null
  for (const r of pickerRoots()) {
    const root = normCase(r)
    const inside =
      target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
    if (inside && (!best || root.length > normCase(best).length)) best = r
  }
  return best
}

export async function mountRoutes(app: FastifyInstance) {
  /** 共享资源库：返回全部节点（扁平结构，由前端拼成树） */
  app.get('/api/mounts', { onRequest: [authGuard] }, async (req) => {
    const list = await prisma.mount.findMany({
      include: { user: { select: { id: true, username: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    })
    return list.map((m) => dto(m, req.user))
  })

  /** 发布：新建逻辑文件夹 / 映射一个真实目录 / 映射一个真实文件 */
  app.post('/api/mounts', { onRequest: [authGuard] }, async (req, reply) => {
    if (!canCreateMount(req.user.role)) {
      throw new AppError('当前设置下只有管理员可以发布磁盘内容', 403)
    }
    const body = (req.body ?? {}) as {
      name?: string
      kind?: string
      parentId?: string | null
      absPath?: string
    }
    // 兼容旧客户端：只传 name + absPath 时按「发布目录」处理
    const kind = String(body.kind ?? 'DIR').toUpperCase()
    if (!KINDS.has(kind)) throw new AppError('kind 只能是 FOLDER / DIR / FILE')

    const name = normalizeName(body.name)
    const parent = await resolveParent(body.parentId)
    const parentId = parent?.id ?? null
    await assertNameFree(parentId, name)

    const include = { user: { select: { id: true, username: true } } }

    // 逻辑文件夹：只登记一个名字，不碰磁盘
    if (kind === 'FOLDER') {
      const node = await prisma.mount.create({
        data: { userId: req.user.id, name, kind, absPath: null, parentId, readOnly: true },
        include,
      })
      return reply.code(201).send(dto(node, req.user))
    }

    const absPath = String(body.absPath ?? '').trim()
    if (!absPath) throw new AppError(kind === 'DIR' ? '请选择要发布的目录' : '请选择要发布的文件')
    if (!path.isAbsolute(absPath)) throw new AppError('必须是服务器上的绝对路径')

    let st: fs.Stats
    try {
      st = fs.statSync(absPath)
    } catch {
      throw new AppError('该路径在服务器上不存在', 404)
    }
    if (kind === 'DIR' && !st.isDirectory()) throw new AppError('选择的不是目录')
    if (kind === 'FILE' && !st.isFile()) throw new AppError('选择的不是文件')

    // 登记解析后的真实路径：挂载点自身是软链接 / junction 时也能得到一致的比较基准
    const target = fs.realpathSync(absPath)
    if (!isMountPathAllowed(target)) {
      throw new AppError('该路径不在允许发布的范围内（见服务端 MOUNT_ALLOWED_ROOTS 配置）', 403)
    }
    if (kind === 'DIR') await assertNoDirOverlap(target)

    const node = await prisma.mount.create({
      data: { userId: req.user.id, name, kind, absPath: target, parentId, readOnly: true },
      include,
    })
    return reply.code(201).send(dto(node, req.user))
  })

  /** 重命名 / 移动节点（逻辑搬运，绝不动磁盘文件） */
  app.patch('/api/mounts/:id', { onRequest: [authGuard] }, async (req) => {
    const { id } = req.params as { id: string }
    const mount = await getMount(id)
    assertCanManage(mount, req.user)

    const body = (req.body ?? {}) as {
      name?: string
      parentId?: string | null
      sortOrder?: number
    }
    const data: { name?: string; parentId?: string | null; sortOrder?: number } = {}

    if (body.name !== undefined) {
      const name = normalizeName(body.name)
      await assertNameFree(mount.parentId, name, id)
      data.name = name
    }
    if (body.parentId !== undefined) {
      const parent = await resolveParent(body.parentId)
      // 不能把节点搬进它自己的后代里，否则树会断开成环
      if (parent && (await collectSubtree(id)).includes(parent.id)) {
        throw new AppError('不能移动到自身或自己的子节点下')
      }
      await assertNameFree(parent?.id ?? null, data.name ?? mount.name, id)
      data.parentId = parent?.id ?? null
    }
    if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0

    const updated = await prisma.mount.update({
      where: { id },
      data,
      include: { user: { select: { id: true, username: true } } },
    })
    return dto(updated, req.user)
  })

  /** 取消发布：逻辑文件夹会连带删掉下面的所有节点（只删库记录，磁盘文件不动） */
  app.delete('/api/mounts/:id', { onRequest: [authGuard] }, async (req) => {
    const { id } = req.params as { id: string }
    const mount = await getMount(id)
    assertCanManage(mount, req.user)

    const ids = await collectSubtree(id)
    // 自关联用的是 NoAction，数据库不会替我们级联，必须自底向上逐个删
    await prisma.$transaction(ids.slice().reverse().map((x) => prisma.mount.delete({ where: { id: x } })))
    return { ok: true, removed: ids.length }
  })

  /* ---------------- 选择器用的磁盘浏览 ---------------- */

  /** 可浏览的起点：白名单根目录（未限制时是各个盘符） */
  app.get('/api/mounts/fs/roots', { onRequest: [authGuard] }, async (req) => {
    if (!canCreateMount(req.user.role)) {
      throw new AppError('当前设置下只有管理员可以发布磁盘内容', 403)
    }
    const roots = pickerRoots()
    return {
      roots,
      unrestricted: config.mountRootsUnrestricted,
      defaultPath: roots[0] ?? '',
    }
  })

  /**
   * 列举服务器磁盘上的某个目录。
   * 每一次请求都重新校验范围，所以顺着软链接跳出去也会被当场拦住。
   */
  app.get('/api/mounts/fs/list', { onRequest: [authGuard] }, async (req) => {
    if (!canCreateMount(req.user.role)) {
      throw new AppError('当前设置下只有管理员可以发布磁盘内容', 403)
    }
    const { path: rawPath } = (req.query ?? {}) as { path?: string }
    const roots = pickerRoots()

    // 不给路径 = 返回可选起点，让前端先渲染根列表
    if (!rawPath) return { path: '', parent: null, roots, entries: [] }

    let realPath: string
    try {
      realPath = fs.realpathSync(path.resolve(rawPath))
    } catch {
      throw new AppError('该路径不存在或无法访问', 404)
    }
    if (!fs.statSync(realPath).isDirectory()) throw new AppError('该路径不是目录')

    const boundary = config.mountRootsUnrestricted ? null : boundaryRoot(realPath)
    if (!config.mountRootsUnrestricted && !boundary) {
      throw new AppError('该路径不在允许浏览的范围内', 403)
    }

    const entries = fs
      .readdirSync(realPath, { withFileTypes: true })
      .filter((e) => !SKIP_NAMES.has(e.name))
      // 指向范围之外的软链接 / junction 不展示，避免列表里出现点了就报错的入口
      .filter((e) => !boundary || !isEscapeLink(boundary, path.join(realPath, e.name)))
      .map((e) => {
        const full = path.join(realPath, e.name)
        let size = 0
        try {
          size = fs.statSync(full).size
        } catch {
          /* 无权访问的条目跳过大小 */
        }
        return {
          name: e.name,
          path: full,
          isDir: e.isDirectory(),
          isFile: e.isFile(),
          size: size.toString(),
        }
      })
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))

    // 到顶就不再提供「上一级」：要么是磁盘根，要么已经是配置范围的边界
    let parent: string | null = null
    const up = path.dirname(realPath)
    if (normCase(up) !== normCase(realPath)) {
      parent = config.mountRootsUnrestricted ? up : boundaryRoot(up) ? up : null
    }

    return { path: realPath, parent, roots, entries }
  })

  /** 浏览真实磁盘目录内容（所有登录用户） */
  app.get('/api/mounts/:id/browse', { onRequest: [authGuard] }, async (req) => {
    const { id } = req.params as { id: string }
    const { sub } = (req.query ?? {}) as { sub?: string }
    const mount = await getMount(id)

    if (mount.kind === 'FOLDER') throw new AppError('逻辑文件夹没有磁盘内容')
    if (mount.kind === 'FILE') throw new AppError('这是一个文件节点，直接下载即可')
    const basePath = mount.absPath!

    // resolveInside 会跟随软链接展开到真实目录，同时保证它没跑出挂载点
    const rootAbs = realRoot(basePath)
    const abs = resolveInside(basePath, sub ?? '')
    if (!fs.statSync(abs).isDirectory()) throw new AppError('该路径不是目录')

    const entries = fs.readdirSync(abs, { withFileTypes: true })
    const items = entries
      .filter((e) => !SKIP_NAMES.has(e.name))
      // 过滤掉指向挂载点外部的软链接 / junction，避免列表里出现能越狱的入口
      .filter((e) => !isEscapeLink(rootAbs, path.join(abs, e.name)))
      .map((e) => {
        const full = path.join(abs, e.name)
        let size = 0
        let mtime: Date | null = null
        try {
          const st = fs.statSync(full)
          size = st.size
          mtime = st.mtime
        } catch {
          /* 无权访问的文件跳过大小 */
        }
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size: size.toString(),
          mtime,
          sub: normalizeRel(sub ? `${sub}/${e.name}` : e.name),
        }
      })
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))

    return { mount: dto(mount, req.user), sub: normalizeRel(sub ?? ''), items }
  })

  /** 从磁盘发布下载（所有登录用户） */
  // 不按请求数限流，理由同 files.ts 的下载路由：可续传下载天然是大量 Range 请求。
  app.get('/api/mounts/:id/download', { onRequest: [authGuard], config: { rateLimit: false } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { sub } = (req.query ?? {}) as { sub?: string }
    const mount = await getMount(id)

    if (mount.kind === 'FOLDER') throw new AppError('逻辑文件夹不能直接下载')

    // 文件节点：路径就是文件本身，sub 用不上
    if (mount.kind === 'FILE') {
      const abs = realRoot(mount.absPath!) // 源文件被删掉时会在这里抛 404
      return streamFile(req, reply, abs, path.basename(abs))
    }

    if (!sub) throw new AppError('缺少 sub 参数')
    // 读取的是软链接展开后的原始文件，但下载名仍用列表里显示的那一个
    const rel = normalizeRel(sub)
    const abs = resolveInside(mount.absPath!, rel)
    return streamFile(req, reply, abs, rel.split('/').pop() || path.basename(abs))
  })
}
