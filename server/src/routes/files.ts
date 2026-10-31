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
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db.js'
import { config, userStorageDir } from '../config.js'
import { AppError, assertSafeName, normalizeRel, safeJoin } from '../utils/fs.js'
import {
  allowanceBytes,
  ByteLimitStream,
  quotaExceeded,
  quotaState,
  reserveInFlight,
} from '../utils/quota.js'
import { authGuard } from '../plugins/auth.js'
import { streamFile } from '../utils/stream.js'
import { parseIdList } from '../utils/batch.js'

export function dto(f: {
  id: string
  name: string
  relPath: string
  size: bigint
  mime: string | null
  isDir: boolean
  parent: string
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: f.id,
    name: f.name,
    relPath: f.relPath,
    parent: f.parent,
    size: f.size.toString(),
    mime: f.mime,
    isDir: f.isDir,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }
}

/**
 * 删除一条记录及其磁盘内容（目录会递归）。
 *
 * 单个删除和批量删除共用这一段，避免两边口径走偏 —— 曾经只想在批量里
 * 「跳过不存在的项」，结果单个路由漏了 directory 的 deleteMany，
 * 磁盘清空了却在库里留下整棵子树的孤儿记录。
 */
async function removeFileItem(
  userId: string,
  item: { id: string; relPath: string; isDir: boolean },
) {
  const root = userStorageDir(userId)
  // force 让「文件已经不在了」变成无操作，批量里重复选中也能安全跑完
  fs.rmSync(safeJoin(root, item.relPath), { recursive: true, force: true })

  // 目录要连子项一起删
  if (item.isDir) {
    await prisma.fileItem.deleteMany({
      where: { userId, relPath: { startsWith: item.relPath + '/' } },
    })
  }
  await prisma.fileItem.delete({ where: { id: item.id } })
}

export async function fileRoutes(app: FastifyInstance) {
  /** 列目录 */
  app.get('/api/files', { onRequest: [authGuard] }, async (req) => {
    const { parent } = (req.query ?? {}) as { parent?: string }
    const dir = normalizeRel(parent ?? '')
    const items = await prisma.fileItem.findMany({
      where: { userId: req.user.id, parent: dir },
      orderBy: [{ isDir: 'desc' }, { name: 'asc' }],
    })
    return { parent: dir, items: items.map(dto) }
  })

  /**
   * 空间用量。
   *
   * 口径与配额判定保持一致：已落库的文件 **加上** 在途上传的分片。
   * 分片虽然还躺在临时目录里，但确实占着磁盘，也算在用户的额度上；
   * 只报已落库的话，用户会看到「还有空间」却在上传时被拒。
   */
  app.get('/api/files/usage', { onRequest: [authGuard] }, async (req) => {
    const state = await quotaState(req.user.id)
    return {
      usedBytes: (state.stored + state.pending).toString(),
      quotaBytes: state.quota.toString(),
    }
  })

  /** 新建文件夹 */
  app.post('/api/files/mkdir', { onRequest: [authGuard] }, async (req, reply) => {
    const { parent, name } = (req.body ?? {}) as { parent?: string; name?: string }
    if (!name) throw new AppError('目录名不能为空')
    const safeName = assertSafeName(name)
    const dir = normalizeRel(parent ?? '')
    const relPath = dir ? `${dir}/${safeName}` : safeName

    const root = userStorageDir(req.user.id)
    const dest = safeJoin(root, relPath)

    /**
     * 只递归补齐**父目录**，目标本身严格建一层。
     *
     * 早先是 `mkdirSync(dest, { recursive: true })`：名字里带分隔符时会一口气建出多级，
     * 而数据库只登记了最后一层，中间几层既没记录也列不出来 —— 磁盘上凭空多出一批
     * 看不见也删不掉的孤儿目录。名字现在保证是单段，这里也就没有多级可建。
     */
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    const existing = await prisma.fileItem.findUnique({
      where: { userId_relPath: { userId: req.user.id, relPath } },
    })
    // 同名普通文件挡在前面：目录和文件不能共用同一个 relPath
    if (existing && !existing.isDir) throw new AppError('同名文件已存在', 409)

    let stat: fs.Stats | null = null
    try {
      stat = fs.statSync(dest)
    } catch {
      stat = null
    }
    if (stat && !stat.isDirectory()) throw new AppError('同名文件已存在', 409)
    // 已存在同名目录：保持幂等，复用原来的 upsert 直接返回
    if (!stat) fs.mkdirSync(dest)

    const item = await prisma.fileItem.upsert({
      where: { userId_relPath: { userId: req.user.id, relPath } },
      create: {
        userId: req.user.id,
        name: safeName,
        relPath,
        parent: dir,
        isDir: true,
        size: BigInt(0),
      },
      update: { isDir: true },
    })
    return reply.code(201).send(dto(item))
  })

  /** 上传文件（multipart/form-data：file=文件, path=目标目录） */
  // bodyLimit 是路由级覆盖：全局那个 1MB 是给 JSON API 用的（会被整个缓冲进内存），
  // multipart 的路由必须显式抬回单文件上限，否则大文件会被误判成 413。
  app.post('/api/files/upload', { onRequest: [authGuard], bodyLimit: config.maxUploadSize }, async (req, reply) => {
    if (!req.isMultipart()) throw new AppError('请使用 multipart/form-data 上传', 415)

    const data = await req.file({ limits: { fileSize: config.maxUploadSize } })
    if (!data) throw new AppError('没有收到文件')

    // 文件名同样要过一遍：basename 只挡住了穿越，挡不住 Windows 非法字符和保留名，
    // 那些会让写盘直接抛错，最终变成一次没有文案的 500
    const filename = assertSafeName(path.basename(data.filename || '') || 'unnamed')
    const pathField = (data.fields as Record<string, { value?: unknown }> | undefined)?.path
    const targetDir = normalizeRel(typeof pathField?.value === 'string' ? pathField.value : '')

    const root = userStorageDir(req.user.id)
    const destDir = safeJoin(root, targetDir)
    fs.mkdirSync(destDir, { recursive: true })

    const relPath = targetDir ? `${targetDir}/${filename}` : filename
    const dest = safeJoin(root, relPath)

    /**
     * 配额在**写盘之前**判定，并且把剩余额度直接作为写盘过程的截断上限。
     *
     * 早先是 `pipeline` 把整个文件写完再判、超了才回滚 —— 也就是说配额形同虚设：
     * 一个 2GB 的文件照样能完整落盘，只是在最后一步被删掉，期间磁盘被真实占满。
     * 现在改成：先算还剩多少额度，再把额度交给 ByteLimitStream，写的过程中
     * 一旦越线立刻中断，落盘的字节数永远不会超过剩余额度。
     */
    const state = await quotaState(req.user.id)
    const allowance = allowanceBytes(state.remaining, config.maxUploadSize)
    if (allowance <= 0) throw new AppError('存储空间不足，上传已取消', 413)

    /**
     * 直传没有 UploadTask 记录可记账，用进程内在途预留顶上：
     * 写盘期间这笔额度对并发的其它请求可见，不会各自以为空间还空着。
     */
    const release = reserveInFlight(req.user.id, BigInt(allowance))
    try {
      const limiter = new ByteLimitStream(allowance)
      await pipeline(data.file, limiter, fs.createWriteStream(dest))
      if (limiter.exceeded) throw quotaExceeded()

      const size = fs.statSync(dest).size

      const item = await prisma.fileItem.upsert({
        where: { userId_relPath: { userId: req.user.id, relPath } },
        create: {
          userId: req.user.id,
          name: filename,
          relPath,
          parent: targetDir,
          size: BigInt(size),
          mime: data.mimetype ?? null,
          isDir: false,
        },
        update: { size: BigInt(size), mime: data.mimetype ?? null, isDir: false },
      })
      return reply.code(201).send(dto(item))
    } catch (e) {
      // 落库失败也要把文件删掉：否则磁盘上会留下没有对应记录的孤儿文件
      fs.rmSync(dest, { force: true })
      throw e
    } finally {
      // 无论成败都释放：成功的话字节已计入 stored，失败的话文件已被删除
      release()
    }
  })

  /** 下载文件 */
  // 不按请求数限流：可续传下载是前端按 4MB 一段顺序发 Range，
  // 一个 1GB 的文件就是 256 个请求，在局域网下一分钟就能越过任何合理阈值。
  app.get('/api/files/:id/download', { onRequest: [authGuard], config: { rateLimit: false } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const item = await prisma.fileItem.findUnique({ where: { id } })
    if (!item || item.userId !== req.user.id) throw new AppError('文件不存在', 404)
    if (item.isDir) throw new AppError('目录不支持下载', 400)

    const abs = safeJoin(userStorageDir(req.user.id), item.relPath)
    return streamFile(req, reply, abs, item.name)
  })

  /** 删除文件或目录 */
  app.delete('/api/files/:id', { onRequest: [authGuard] }, async (req) => {
    const { id } = req.params as { id: string }
    const item = await prisma.fileItem.findUnique({ where: { id } })
    if (!item || item.userId !== req.user.id) throw new AppError('文件不存在', 404)

    await removeFileItem(req.user.id, item)
    return { ok: true }
  })

  /**
   * 批量删除：文件库里勾选多条后一次删掉。
   *
   * 只处理属于当前用户的记录 —— 别人的 id 混进来既不删也不报错，
   * 与单个删除一致（404 会泄露「这个 id 存在」）。
   *
   * 部分失败**不回滚**：目录下的某个文件被别的进程占住时，
   * 回滚会把已经删掉的那些又留下记录，反而更难收拾。失败项单独回传名称，
   * 让用户知道哪几个还在。
   */
  app.post('/api/files/batch-delete', { onRequest: [authGuard] }, async (req) => {
    const body = (req.body ?? {}) as { ids?: unknown }
    const ids = parseIdList(body.ids)

    const items = await prisma.fileItem.findMany({
      where: { id: { in: ids }, userId: req.user.id },
    })
    if (!items.length) throw new AppError('文件不存在', 404)

    /**
     * 先长后短：同时勾选了目录和它里面的文件时，子项先被删掉，
     * 目录再递归清一次盘（force 幂等），不会因为「删目录时子项记录已消失」而报错。
     */
    const ordered = items.slice().sort((a, b) => b.relPath.length - a.relPath.length)

    const failed: string[] = []
    let removed = 0
    for (const item of ordered) {
      try {
        await removeFileItem(req.user.id, item)
        removed++
      } catch {
        failed.push(item.name)
      }
    }
    return { ok: true, removed, failed }
  })
}
