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
import { config, uploadTmpDir, userStorageDir } from '../config.js'
import { localeFromRequest, t } from '../i18n/index.js'
import { AppError, assertSafeName, normalizeRel, safeJoin } from '../utils/fs.js'
import {
  addPending,
  allowanceBytes,
  assertFits,
  ByteLimitStream,
  quotaExceeded,
  quotaState,
} from '../utils/quota.js'
import { authGuard } from '../plugins/auth.js'
import { dto } from './files.js'

/**
 * 同一用户同时在传的分片数。前端给的并发数不可信（可以随便改），
 * 服务端必须自己挡：内存峰值 ≈ 并发数 × 分片大小，不设限会被打爆。
 */
const inFlight = new Map<string, number>()

function acquireSlot(userId: string): boolean {
  const n = inFlight.get(userId) ?? 0
  if (n >= config.maxConcurrentChunks) return false
  inFlight.set(userId, n + 1)
  return true
}

function releaseSlot(userId: string): void {
  const n = (inFlight.get(userId) ?? 1) - 1
  if (n <= 0) inFlight.delete(userId)
  else inFlight.set(userId, n)
}

/**
 * 确定实际生效的分片大小：
 * 先按上下限夹住，再保证分片总数不超过上限——否则 10GB 文件用 512KB 分片
 * 会生成两万个文件，合并时串行读写两万次，complete 会慢到不可用。
 */
function resolveChunkSize(want: number, size: number): { chunkSize: number; totalChunks: number } {
  const min = Math.max(1, Math.min(config.minChunkSize, config.maxChunkSize))
  let chunkSize = Math.min(config.maxChunkSize, Math.max(min, Number(want) || config.chunkSize))
  let totalChunks = Math.max(1, Math.ceil(size / chunkSize))
  if (totalChunks > config.maxChunksPerTask) {
    chunkSize = Math.min(config.maxChunkSize, Math.ceil(size / config.maxChunksPerTask))
    totalChunks = Math.max(1, Math.ceil(size / chunkSize))
  }
  return { chunkSize, totalChunks }
}

/** 分片在临时目录里的文件名，index 已被强制转成数字，不存在注入风险 */
function chunkPath(dir: string, index: number): string {
  return path.join(dir, `${index}.part`)
}

/** 列出某个任务已经收到的分片序号（升序） */
function receivedChunks(dir: string, total: number): number[] {
  if (!fs.existsSync(dir)) return []
  const out: number[] = []
  for (const name of fs.readdirSync(dir)) {
    const m = /^(\d+)\.part$/.exec(name)
    if (!m) continue
    const i = Number(m[1])
    if (i >= 0 && i < total) out.push(i)
  }
  return out.sort((a, b) => a - b)
}

/** 清理该用户超过 TTL 仍未完成的上传任务 */
async function sweepExpired(userId: string): Promise<void> {
  const deadline = new Date(Date.now() - config.uploadTaskTtlDays * 86_400_000)
  const stale = await prisma.uploadTask.findMany({
    where: { userId, updatedAt: { lt: deadline } },
  })
  for (const t of stale) {
    fs.rmSync(path.join(config.tmpRoot, userId, t.id), { recursive: true, force: true })
    await prisma.uploadTask.delete({ where: { id: t.id } }).catch(() => {})
  }
}

export async function uploadRoutes(app: FastifyInstance) {
  /**
   * 初始化上传任务。
   * - 若指纹命中同用户已有文件，直接返回秒传结果（instant=true），不必再传分片
   * - 否则建立任务并返回已收到的分片序号，供前端断点续传跳过
   */
  app.post('/api/uploads/init', { onRequest: [authGuard] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string
      size?: number | string
      parent?: string
      hash?: string
      chunkSize?: number
    }
    // basename 只挡住了目录穿越，挡不住非法字符 / 保留名；那些要等到 complete 合并时才炸，
    // 那时分片已经全传完了。在建任务这一步就拦掉，用户立刻就能看到原因。
    const rawName = path.basename(body.name ?? '')
    if (!rawName) throw new AppError('文件名不能为空', 400)
    const name = assertSafeName(rawName)
    const size = BigInt(body.size ?? 0)
    if (size <= BigInt(0)) throw new AppError('文件大小不合法', 400)
    if (size > BigInt(config.maxUploadSize)) {
      throw new AppError('文件超过单文件上限', 413)
    }

    /**
     * 配额按**承诺量**判定，而不是已落盘的字节。
     *
     * 这里必须把在途任务声明的大小（reserved）一起算进去：否则用户并发建 N 个任务，
     * 每个都只在「已用 + 本任务大小」的口径下检查，于是能同时接下 N 倍配额。
     * 分片随后照常落盘，配额就成了摆设。
     */
    const state = await quotaState(req.user.id)
    assertFits(state.remainingReserved, size)

    // 秒传：同用户 + 同指纹 + 同大小，且文件确实还在磁盘上
    if (body.hash) {
      const exist = await prisma.fileItem.findFirst({
        where: { userId: req.user.id, hash: body.hash, size, isDir: false },
      })
      if (exist) {
        const abs = safeJoin(userStorageDir(req.user.id), exist.relPath)
        if (fs.existsSync(abs) && fs.statSync(abs).size === Number(size)) {
          return reply.code(200).send({ instant: true, file: dto(exist) })
        }
      }
    }

    // 以服务端算出的值为准，init 会把它返回给前端，前端必须用它切片
    const { chunkSize, totalChunks } = resolveChunkSize(Number(body.chunkSize), Number(size))

    const task = await prisma.uploadTask.create({
      data: {
        userId: req.user.id,
        name,
        parent: normalizeRel(body.parent ?? ''),
        size,
        chunkSize,
        totalChunks,
        hash: body.hash ?? null,
      },
    })
    const dir = uploadTmpDir(req.user.id, task.id)
    void sweepExpired(req.user.id)

    return reply.code(201).send({
      instant: false,
      uploadId: task.id,
      chunkSize,
      totalChunks,
      uploaded: receivedChunks(dir, totalChunks),
      // 告知前端服务端能接受的边界，前端据此调整并发，避免白撞 429
      limits: {
        minChunkSize: config.minChunkSize,
        maxChunkSize: config.maxChunkSize,
        maxChunksPerTask: config.maxChunksPerTask,
        maxConcurrentChunks: config.maxConcurrentChunks,
      },
    })
  })

  /** 查询任务进度（断点续传时用） */
  app.get('/api/uploads/:id', { onRequest: [authGuard] }, async (req) => {
    const { id } = req.params as { id: string }
    const task = await prisma.uploadTask.findUnique({ where: { id } })
    if (!task || task.userId !== req.user.id) throw new AppError('上传任务不存在', 404)
    const dir = uploadTmpDir(task.userId, task.id)
    return {
      uploadId: task.id,
      name: task.name,
      size: task.size.toString(),
      chunkSize: task.chunkSize,
      totalChunks: task.totalChunks,
      uploaded: receivedChunks(dir, task.totalChunks),
    }
  })

  /**
   * 上传单个分片（multipart：index=序号, file=分片内容）
   *
   * 两个例外设置：
   * - bodyLimit：全局那个 1MB 是给 JSON API 的；multipart 走自己的 fileSize limits，
   *   这里再把路由级上限抬到单文件上限，确保分片不会被误判成 413。
   * - rateLimit: false：一个文件天然就是成百上千个分片请求，按请求数限流只会
   *   打到正常用户头上。真正的大小边界是下面逐请求的 fileSize limits，
   *   以及每个用户的在途分片数上限（acquireSlot）。
   */
  app.post('/api/uploads/:id/chunk', { onRequest: [authGuard], bodyLimit: config.maxUploadSize, config: { rateLimit: false } }, async (req) => {
    if (!req.isMultipart()) throw new AppError('请使用 multipart/form-data 上传分片', 415)
    const { id } = req.params as { id: string }
    const task = await prisma.uploadTask.findUnique({ where: { id } })
    if (!task || task.userId !== req.user.id) throw new AppError('上传任务不存在', 404)

    if (!acquireSlot(req.user.id)) {
      throw new AppError(
        `同时上传的分片过多（上限 ${config.maxConcurrentChunks}）`,
        429,
        { key: '同时上传的分片过多（上限 {}）', params: [config.maxConcurrentChunks] },
      )
    }
    try {
      const data = await req.file({ limits: { fileSize: task.chunkSize + config.minChunkSize } })
      if (!data) throw new AppError('没有收到分片内容')

      const field = (data.fields as Record<string, { value?: unknown }> | undefined)?.index
      const index = Number(typeof field?.value === 'string' ? field.value : NaN)
      if (!Number.isInteger(index) || index < 0 || index >= task.totalChunks) {
        throw new AppError('分片序号不合法', 400)
      }

      /**
       * 配额：在**写盘之前**算出本次最多还能写多少。
       *
       * 分片落在临时目录里同样占着磁盘，早先这里完全没有配额检查 —— 只要 init 放行了，
       * 后面成千上万个分片想传多少传多少。现在除了写盘前判定，还把额度写进
       * `ByteLimitStream`：写的过程中一旦逼近上限立刻中断，而不是写完了再删。
       */
      const state = await quotaState(req.user.id)
      const wanted = task.chunkSize + config.minChunkSize
      const allowance = allowanceBytes(state.remaining, wanted)
      if (allowance <= 0) {
        throw new AppError('存储空间不足', 413)
      }

      const dir = uploadTmpDir(task.userId, task.id)
      const final = chunkPath(dir, index)
      const staging = `${final}.writing`

      /**
       * 重传同一个分片时先把旧文件的字节退掉，否则重传几次 pending 就翻几倍，
       * 明明磁盘上只有一份，账面上却算了好几份，最后把自己卡死。
       */
      const existed = fs.existsSync(final)
      if (existed) {
        await addPending(task.id, -BigInt(fs.statSync(final).size))
        fs.rmSync(final, { force: true })
      }

      // 先按上限登记这笔在途占用：并发的其他分片请求立刻就能看到它，
      // 不会各自以为额度还空着。写完再按实际字节数校正回去。
      await addPending(task.id, BigInt(allowance))
      let limiter: ByteLimitStream
      try {
        // 先写临时文件再改名，避免中断留下的半截分片被当成已上传
        limiter = new ByteLimitStream(allowance)
        await pipeline(data.file, limiter, fs.createWriteStream(staging))
      } catch (e) {
        fs.rmSync(staging, { force: true })
        await addPending(task.id, -BigInt(allowance))
        throw e
      }
      if (limiter.exceeded) {
        fs.rmSync(staging, { force: true })
        await addPending(task.id, -BigInt(allowance))
        throw quotaExceeded()
      }
      const got = fs.statSync(staging).size
      if (got > wanted) {
        fs.rmSync(staging, { force: true })
        await addPending(task.id, -BigInt(allowance))
        throw new AppError('分片大小超出预期', 413)
      }
      fs.renameSync(staging, final)
      // 校正：按真正落盘的字节记账，别让「按上限预留」把额度算虚了
      await addPending(task.id, BigInt(got) - BigInt(allowance))

      await prisma.uploadTask.update({
        where: { id: task.id },
        data: { updatedAt: new Date() },
      })

      return { index, uploaded: receivedChunks(dir, task.totalChunks).length }
    } finally {
      releaseSlot(req.user.id)
    }
  })

  /** 合并分片，落库。缺分片时返回 missing 列表而不是报错了事 */
  app.post('/api/uploads/:id/complete', { onRequest: [authGuard] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const task = await prisma.uploadTask.findUnique({ where: { id } })
    if (!task || task.userId !== req.user.id) throw new AppError('上传任务不存在', 404)

    const dir = uploadTmpDir(task.userId, task.id)
    const have = new Set(receivedChunks(dir, task.totalChunks))
    const missing: number[] = []
    for (let i = 0; i < task.totalChunks; i++) if (!have.has(i)) missing.push(i)
    if (missing.length) {
      return reply
        .code(400)
        .send({ error: t(localeFromRequest(req), '还有分片未上传完成'), missing })
    }

    /**
     * 配额在**合并之前**判定。
     *
     * 分片此刻已经在临时目录里，且计入了 pending；合并只是把它们挪进正式目录，
     * 净增量 = size - receivedBytes（正常情况下两者相等，净增为 0）。
     * 早先这个判定放在合并写完之后 —— 那意味着磁盘先被真实占用一整个文件大小，
     * 判定不过再删掉，等于白写一遍大文件。
     */
    const state = await quotaState(task.userId)
    const net = task.size - task.receivedBytes
    assertFits(state.remaining, net > BigInt(0) ? net : BigInt(0))

    const root = userStorageDir(task.userId)
    const relPath = task.parent ? `${task.parent}/${task.name}` : task.name
    const dest = safeJoin(root, relPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    const staging = `${dest}.merging`
    const out = fs.createWriteStream(staging)
    try {
      for (let i = 0; i < task.totalChunks; i++) {
        await pipeline(fs.createReadStream(chunkPath(dir, i)), out, { end: false })
      }
    } catch (e) {
      out.destroy()
      fs.rmSync(staging, { force: true })
      throw e
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })

    const actual = fs.statSync(staging).size
    if (actual !== Number(task.size)) {
      fs.rmSync(staging, { force: true })
      throw new AppError(
        `合并后大小不一致（期望 ${task.size}，实际 ${actual}），请重新上传`,
        400,
        {
          key: '合并后大小不一致（期望 {}，实际 {}），请重新上传',
          params: [task.size.toString(), actual],
        },
      )
    }

    fs.renameSync(staging, dest)

    const item = await prisma.fileItem.upsert({
      where: { userId_relPath: { userId: task.userId, relPath } },
      create: {
        userId: task.userId,
        name: task.name,
        relPath,
        parent: task.parent,
        size: task.size,
        hash: task.hash,
        isDir: false,
      },
      update: { size: task.size, hash: task.hash, isDir: false },
    })

    fs.rmSync(dir, { recursive: true, force: true })
    await prisma.uploadTask.delete({ where: { id: task.id } })
    return reply.code(201).send(dto(item))
  })

  /** 取消上传，丢弃已收到的分片 */
  app.delete('/api/uploads/:id', { onRequest: [authGuard] }, async (req) => {
    const { id } = req.params as { id: string }
    const task = await prisma.uploadTask.findUnique({ where: { id } })
    if (!task || task.userId !== req.user.id) throw new AppError('上传任务不存在', 404)
    fs.rmSync(path.join(config.tmpRoot, task.userId, task.id), { recursive: true, force: true })
    await prisma.uploadTask.delete({ where: { id: task.id } })
    return { ok: true }
  })
}
