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
import { AppError, normalizeRel, safeJoin } from '../utils/fs.js'
import { authGuard } from '../plugins/auth.js'
import { streamFile } from '../utils/stream.js'

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

  /** 空间用量 */
  app.get('/api/files/usage', { onRequest: [authGuard] }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    const used = await prisma.fileItem.aggregate({
      where: { userId: req.user.id },
      _sum: { size: true },
    })
    return {
      usedBytes: (used._sum.size ?? BigInt(0)).toString(),
      quotaBytes: (user?.quotaBytes ?? BigInt(0)).toString(),
    }
  })

  /** 新建文件夹 */
  app.post('/api/files/mkdir', { onRequest: [authGuard] }, async (req, reply) => {
    const { parent, name } = (req.body ?? {}) as { parent?: string; name?: string }
    if (!name) throw new AppError('目录名不能为空')
    const dir = normalizeRel(parent ?? '')
    const relPath = dir ? `${dir}/${name}` : name

    const root = userStorageDir(req.user.id)
    fs.mkdirSync(safeJoin(root, relPath), { recursive: true })

    const item = await prisma.fileItem.upsert({
      where: { userId_relPath: { userId: req.user.id, relPath } },
      create: {
        userId: req.user.id,
        name,
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

    const filename = path.basename(data.filename || 'unnamed')
    const pathField = (data.fields as Record<string, { value?: unknown }> | undefined)?.path
    const targetDir = normalizeRel(typeof pathField?.value === 'string' ? pathField.value : '')

    const root = userStorageDir(req.user.id)
    const destDir = safeJoin(root, targetDir)
    fs.mkdirSync(destDir, { recursive: true })

    const relPath = targetDir ? `${targetDir}/${filename}` : filename
    const dest = safeJoin(root, relPath)

    await pipeline(data.file, fs.createWriteStream(dest))
    const size = fs.statSync(dest).size

    // 配额检查：写完后判定，超出就回滚
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    const used = await prisma.fileItem.aggregate({
      where: { userId: req.user.id },
      _sum: { size: true },
    })
    const quota = user?.quotaBytes ?? BigInt(0)
    if (quota > 0 && (used._sum.size ?? BigInt(0)) + BigInt(size) > quota) {
      fs.rmSync(dest, { force: true })
      throw new AppError('存储空间不足，上传已取消', 413)
    }

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

    const root = userStorageDir(req.user.id)
    fs.rmSync(safeJoin(root, item.relPath), { recursive: true, force: true })

    // 目录要连子项一起删
    if (item.isDir) {
      await prisma.fileItem.deleteMany({
        where: { userId: req.user.id, relPath: { startsWith: item.relPath + '/' } },
      })
    }
    await prisma.fileItem.delete({ where: { id } })
    return { ok: true }
  })
}
