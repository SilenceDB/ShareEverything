/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { AppError, humanSize, normalizeRel, resolveInside } from '../utils/fs.js'
import { FailureThrottle, safeEqual } from '../utils/guard.js'
import { authGuard } from '../plugins/auth.js'
import { streamFile } from '../utils/stream.js'
import { createArchiveStream, planDirectory, type ZipMode } from '../utils/zip.js'
import {
  acquireSlot,
  createArchiveJob,
  getPlan,
  jobDto,
  removeJobFile,
  resolveShareTarget,
  type JobDto,
} from '../services/archive.js'
import { localeFromRequest, t, type Locale } from '../i18n/index.js'

/**
 * 打包任务的 error 是**落在数据库里**的中文原文 —— 写库时根本不知道将来谁会来看，
 * 所以只能在回给客户端这一跳按当前请求的语言翻一次。
 * 查不到表就原样返回（比如底层抛上来的自定义 message），不会把界面搞成空白。
 */
function jobFor(locale: Locale, job: JobDto): JobDto {
  return job.error ? { ...job, error: t(locale, job.error) } : job
}

function newCode(): string {
  return crypto.randomBytes(6).toString('base64url')
}

/**
 * 提取码的防爆破计数。只统计失败次数，校验成功即清零，
 * 所以正常浏览分享（一次访问会带出好几个请求）不会把自己撞进限流里。
 * key 里带分享 code，猜一个分享猜满不会影响同一个 IP 访问别的分享。
 */
const accessCodeThrottle = new FailureThrottle(
  config.accessCodeMaxFails,
  config.accessCodeWindowSeconds * 1000,
)

function dto(s: {
  id: string
  code: string
  title: string | null
  targetType: string
  isDir: boolean
  fileId: string | null
  mountId: string | null
  subPath: string
  accessCode: string | null
  expiresAt: Date | null
  maxDownloads: number | null
  downloadCount: number
  createdAt: Date
}) {
  const expired = s.expiresAt ? s.expiresAt.getTime() < Date.now() : false
  const exhausted = s.maxDownloads != null && s.downloadCount >= s.maxDownloads
  return {
    id: s.id,
    code: s.code,
    title: s.title,
    targetType: s.targetType,
    isDir: s.isDir,
    kind: s.isDir ? ('DIR' as const) : ('FILE' as const),
    subPath: s.subPath,
    hasAccessCode: !!s.accessCode,
    expiresAt: s.expiresAt,
    maxDownloads: s.maxDownloads,
    downloadCount: s.downloadCount,
    createdAt: s.createdAt,
    status: expired ? 'EXPIRED' : exhausted ? 'EXHAUSTED' : 'ACTIVE',
  }
}

/* 分享目标解析、预检缓存、并发名额与后台任务都在 services/archive.ts */

/** 从环境变量或请求参数里取压缩档位，非法值退回默认档 */
function parseMode(raw: unknown): ZipMode {
  const v = String(raw ?? '').toLowerCase()
  return v === 'store' || v === 'deflate' ? v : v === 'smart' ? 'smart' : config.zipDefaultMode
}

function zipNameOf(title: string | null, fallback: string): string {
  return `${(title || fallback || 'archive').replace(/[\\/:*?"<>|]/g, '_')}.zip`
}

/** 同步打包的节流：同一个分享两次打包之间的最小间隔 */
const lastArchiveAt = new Map<string, number>()

/** 是否建议改用后台打包任务：大目录用同步流式太容易中途断掉 */
function suggestAsync(plan: { fileCount: number; totalBytes: number }): boolean {
  return (
    plan.totalBytes >= config.archiveAsyncThresholdBytes ||
    plan.fileCount >= config.archiveAsyncThresholdFiles
  )
}

export async function shareRoutes(app: FastifyInstance) {
  /** 创建分享（文件或目录都可以） */
  app.post('/api/shares', { onRequest: [authGuard] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      targetType?: string
      fileId?: string
      mountId?: string
      subPath?: string
      title?: string
      accessCode?: string
      expiresInHours?: number
      maxDownloads?: number
    }
    const { targetType, fileId, mountId, subPath } = body
    if (targetType !== 'FILE' && targetType !== 'MOUNT') {
      throw new AppError('targetType 只能是 FILE 或 MOUNT')
    }

    let isDir = false
    if (targetType === 'FILE') {
      const file = await prisma.fileItem.findUnique({ where: { id: fileId ?? '' } })
      if (!file || file.userId !== req.user.id) throw new AppError('文件不存在', 404)
      isDir = file.isDir
    } else {
      // 磁盘发布是全站共享资源库，任何登录用户都能就其中的文件建分享，
      // 不校验发布者是谁（否则共享就名不副实）
      const mount = await prisma.mount.findUnique({ where: { id: mountId ?? '' } })
      if (!mount) throw new AppError('发布不存在', 404)
      // 逻辑文件夹只是资源库里的分组，没有对应的磁盘路径，因而无法打包/下载
      if (!mount.absPath) throw new AppError('逻辑文件夹暂不支持分享，请分享具体的目录或文件', 400)
      // 空字符串是合法的：表示分享整个发布根目录（DIR 节点）或该文件本身（FILE 节点）
      if (typeof subPath !== 'string') throw new AppError('缺少 subPath')
      // 同样走 resolveInside：根内软链接照常分享原始内容，指向根外的直接 403
      const abs = resolveInside(mount.absPath, normalizeRel(subPath))
      if (!fs.existsSync(abs)) throw new AppError('该路径在磁盘上不存在', 404)
      isDir = fs.statSync(abs).isDirectory()
    }

    const share = await prisma.share.create({
      data: {
        code: newCode(),
        title: body.title ?? null,
        targetType,
        fileId: targetType === 'FILE' ? fileId! : null,
        mountId: targetType === 'MOUNT' ? mountId! : null,
        subPath: targetType === 'MOUNT' ? normalizeRel(subPath ?? '') : '',
        isDir,
        accessCode: body.accessCode || null,
        expiresAt:
          body.expiresInHours && body.expiresInHours > 0
            ? new Date(Date.now() + body.expiresInHours * 3600_000)
            : null,
        maxDownloads: body.maxDownloads ?? null,
        createdById: req.user.id,
      },
    })
    return reply.code(201).send(dto(share))
  })

  /** 我创建的分享 */
  app.get('/api/shares', { onRequest: [authGuard] }, async (req) => {
    const list = await prisma.share.findMany({
      where: { createdById: req.user.id },
      orderBy: { createdAt: 'desc' },
    })
    return list.map(dto)
  })

  app.delete('/api/shares/:id', { onRequest: [authGuard] }, async (req) => {
    const { id } = req.params as { id: string }
    const share = await prisma.share.findUnique({ where: { id } })
    if (!share || share.createdById !== req.user.id) throw new AppError('分享不存在', 404)
    // 记录由数据库级联删除，但临时文件得自己清
    const jobs = await prisma.archiveJob.findMany({
      where: { shareId: id },
      select: { zipPath: true },
    })
    for (const j of jobs) await removeJobFile(j.zipPath)
    await prisma.share.delete({ where: { id } })
    return { ok: true }
  })

  /** 公开：查看分享信息（不校验提取码，只告诉前端要不要填） */
  app.get('/api/s/:code', async (req) => {
    const { code } = req.params as { code: string }
    const share = await prisma.share.findUnique({ where: { code } })
    if (!share) throw new AppError('分享不存在或已被取消', 404)

    const target = await resolveShareTarget(share).catch(() => null)
    return {
      ...dto(share),
      title: share.title ?? (target?.filename ?? t(localeFromRequest(req), '未命名')),
      needAccessCode: !!share.accessCode,
      available: !!target && fs.existsSync(target.abs),
    }
  })

  /**
   * 公开：目录打包预检。先看清楚有多少文件、多大，再决定要不要下。
   * 不消耗下载次数，但需要提取码 —— 否则无关人员可以探测目录内容。
   */
  app.get('/api/s/:code/archive/plan', async (req) => {
    const { code } = req.params as { code: string }
    const { accessCode, mode } = (req.query ?? {}) as { accessCode?: string; mode?: string }
    const share = await getVerifiedShare(req, code, accessCode, false)
    const target = await resolveShareTarget(share)
    if (!share.isDir) throw new AppError('该分享不是目录，请直接下载', 400)
    if (!fs.existsSync(target.abs)) throw new AppError('源目录已不存在', 404)

    const m = parseMode(mode)
    const plan = getPlan(share.id, m, () => planDirectory(target.rootAbs, target.abs, target.filename, m))
    return {
      mode: m,
      suggestAsync: suggestAsync(plan),
      fileCount: plan.fileCount,
      dirCount: plan.dirCount,
      totalBytes: plan.totalBytes,
      zipBytes: plan.zipBytes,
      deflateCount: plan.deflateCount,
      skipped: plan.skipped,
      truncated: plan.truncated,
      truncatedBy: plan.truncatedBy,
      limits: {
        maxFiles: config.zipMaxFiles,
        maxTotalBytes: config.zipMaxTotalBytes,
        maxDepth: config.zipMaxDepth,
      },
    }
  })

  /** 公开：把整个目录打包成 ZIP 流式下载 */
  // 整目录打包是公开接口里最吃 CPU 的，单独压一个较低的每分钟上限
  app.get('/api/s/:code/archive', { config: { rateLimit: { max: config.rateLimitArchiveMax, timeWindow: 60_000 } } }, async (req, reply) => {
    const { code } = req.params as { code: string }
    const { accessCode, mode } = (req.query ?? {}) as { accessCode?: string; mode?: string }
    const share = await getVerifiedShare(req, code, accessCode, true)
    const target = await resolveShareTarget(share)
    if (!share.isDir) throw new AppError('该分享不是目录，请直接下载', 400)
    if (!fs.existsSync(target.abs)) throw new AppError('源目录已不存在', 404)

    // 防手抖：同一个分享短时间内重复打包会把磁盘和 CPU 吃满
    const now = Date.now()
    const last = lastArchiveAt.get(share.id) ?? 0
    if (now - last < config.zipThrottleSeconds * 1000) {
      const wait = Math.ceil((config.zipThrottleSeconds * 1000 - (now - last)) / 1000)
      throw new AppError(`打包过于频繁，请 ${wait} 秒后重试`, 429, {
        key: '打包过于频繁，请 {} 秒后重试',
        params: [wait],
      })
    }
    lastArchiveAt.set(share.id, now)

    const m = parseMode(mode)
    const plan = getPlan(share.id, m, () => planDirectory(target.rootAbs, target.abs, target.filename, m))
    if (plan.truncated) {
      // 三种「超限」各写一条完整文案，而不是把原因拼进去：
      // 拼出来的句子翻译层认不出来（模板里混着已经插值过的中文），只能整句给一个键
      if (plan.truncatedBy === 'files') {
        throw new AppError(
          `目录太大，文件数超过上限 ${config.zipMaxFiles}，已取消打包`,
          413,
          { key: '目录太大，文件数超过上限 {}，已取消打包', params: [config.zipMaxFiles] },
        )
      }
      if (plan.truncatedBy === 'bytes') {
        const limit = humanSize(config.zipMaxTotalBytes)
        throw new AppError(`目录太大，总大小超过上限 ${limit}，已取消打包`, 413, {
          key: '目录太大，总大小超过上限 {}，已取消打包',
          params: [limit],
        })
      }
      throw new AppError(
        `目录太大，目录层级超过上限 ${config.zipMaxDepth}，已取消打包`,
        413,
        { key: '目录太大，目录层级超过上限 {}，已取消打包', params: [config.zipMaxDepth] },
      )
    }

    const releaseSlot = await acquireSlot()
    const zipName = zipNameOf(share.title, target.filename)
    const headers: Record<string, string> = {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      'X-Archive-Files': String(plan.fileCount),
      // ZIP 是即时生成的，不支持 Range：明确关掉，免得客户端白试一次
      'Accept-Ranges': 'none',
    }
    if (plan.zipBytes != null) headers['Content-Length'] = String(plan.zipBytes)
    if (plan.skipped) headers['X-Archive-Skipped'] = String(plan.skipped)

    const stream = createArchiveStream(plan)
    // 名额必须在「流读完」和「连接断开」两条路径上都归还，
    // 否则 keep-alive 连接不会触发 close，名额就永久泄漏了。
    let released = false
    const releaseOnce = () => {
      if (released) return
      released = true
      releaseSlot()
    }
    stream.on('end', releaseOnce)
    stream.on('error', releaseOnce)
    req.raw.on('close', releaseOnce)

    reply.headers(headers)
    return reply.send(stream)
  })

  /**
   * 公开：为目录建一个后台打包任务。
   * 大目录走这条路——先在服务端把 ZIP 生成好，下载阶段就是普通文件，能断点续传。
   * 任务不消耗下载次数，次数在真正下载结果时才计一次。
   */
  app.post('/api/s/:code/archive/jobs', { config: { rateLimit: { max: config.rateLimitArchiveMax, timeWindow: 60_000 } } }, async (req, reply) => {
    const { code } = req.params as { code: string }
    const { accessCode, mode } = (req.body ?? {}) as { accessCode?: string; mode?: string }
    const share = await getVerifiedShare(req, code, accessCode, false)
    if (!share.isDir) throw new AppError('该分享不是目录，请直接下载', 400)
    const target = await resolveShareTarget(share)
    if (!fs.existsSync(target.abs)) throw new AppError('源目录已不存在', 404)

    const m = parseMode(mode)
    const plan = getPlan(share.id, m, () => planDirectory(target.rootAbs, target.abs, target.filename, m))
    if (plan.truncated) {
      throw new AppError(
        plan.truncatedBy === 'files'
          ? '目录太大（文件数超过上限），已取消打包'
          : '目录太大（总大小超过上限），已取消打包',
        413,
      )
    }

    const job = await createArchiveJob(share.id, m, plan)
    return reply.code(202).send(jobFor(localeFromRequest(req), job))
  })

  /** 公开：查询打包任务进度（前端据此轮询） */
  app.get('/api/s/:code/archive/jobs/:jobId', async (req) => {
    const { code, jobId } = req.params as { code: string; jobId: string }
    const { accessCode } = (req.query ?? {}) as { accessCode?: string }
    const share = await getVerifiedShare(req, code, accessCode, false)
    const job = await prisma.archiveJob.findUnique({ where: { id: jobId } })
    if (!job || job.shareId !== share.id) throw new AppError('打包任务不存在', 404)
    return jobFor(localeFromRequest(req), jobDto(job))
  })

  /** 公开：下载打包结果。是普通文件，所以支持 Range 断点续传 */
  // 支持 Range 就等于一次下载会发出很多请求，不按请求数限流
  app.get('/api/s/:code/archive/jobs/:jobId/file', { config: { rateLimit: false } }, async (req, reply) => {
    const { code, jobId } = req.params as { code: string; jobId: string }
    const { accessCode } = (req.query ?? {}) as { accessCode?: string }
    const share = await getVerifiedShare(req, code, accessCode, false)
    const job = await prisma.archiveJob.findUnique({ where: { id: jobId } })
    if (!job || job.shareId !== share.id) throw new AppError('打包任务不存在', 404)
    if (job.status !== 'READY' || !job.zipPath) throw new AppError('打包尚未完成', 409)
    if (!fs.existsSync(job.zipPath)) throw new AppError('打包文件已过期，请重新打包', 410)

    // 断点续传会发出多个 Range 请求，所以次数只在第一次下载时累加一次
    if (!job.counted) {
      await prisma.archiveJob.update({ where: { id: job.id }, data: { counted: true } })
      await prisma.share.update({
        where: { id: share.id },
        data: { downloadCount: { increment: 1 } },
      })
    }

    const target = await resolveShareTarget(share)
    return streamFile(req, reply, job.zipPath, zipNameOf(share.title, target.filename))
  })

  /** 取消或删除一个打包任务（同时删掉临时文件） */
  app.delete('/api/s/:code/archive/jobs/:jobId', async (req) => {
    const { code, jobId } = req.params as { code: string; jobId: string }
    const { accessCode } = (req.query ?? {}) as { accessCode?: string }
    const share = await getVerifiedShare(req, code, accessCode, false)
    const job = await prisma.archiveJob.findUnique({ where: { id: jobId } })
    if (!job || job.shareId !== share.id) throw new AppError('打包任务不存在', 404)
    await removeJobFile(job.zipPath)
    await prisma.archiveJob.delete({ where: { id: job.id } })
    return { ok: true }
  })

  /** 公开：下载（需要提取码时校验） */
  // 不按请求数限流：可续传下载是前端按 4MB 一段顺序发 Range，一次下载 = 成百上千个请求
  app.get('/api/s/:code/download', { config: { rateLimit: false } }, async (req, reply) => {
    const { code } = req.params as { code: string }
    const { accessCode } = (req.query ?? {}) as { accessCode?: string }
    const share = await getVerifiedShare(req, code, accessCode, true)
    const target = await resolveShareTarget(share)
    if (!fs.existsSync(target.abs)) throw new AppError('源文件已不存在', 404)
    if (share.isDir) throw new AppError('这是目录分享，请使用打包下载', 400)

    return streamFile(req, reply, target.abs, target.filename)
  })
}

/**
 * 校验分享的公开访问条件；count 为 true 时累加下载次数。
 *
 * 需要整个 req 是为了拿来源 IP：提取码的失败计数按 `IP|分享code` 分开统计。
 */
async function getVerifiedShare(
  req: FastifyRequest,
  code: string,
  accessCode: string | undefined,
  count: boolean,
) {
  const share = await prisma.share.findUnique({ where: { code } })
  if (!share) throw new AppError('分享不存在或已被取消', 404)

  if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
    throw new AppError('分享已过期', 410)
  }
  if (share.maxDownloads != null && share.downloadCount >= share.maxDownloads) {
    throw new AppError('下载次数已达上限', 410)
  }
  if (share.accessCode) {
    const throttleKey = `${req.ip}|${code}`
    // 猜满就先拒绝，别让它继续拿 bcrypt 之外的廉价比较去撞
    if (!accessCodeThrottle.allowed(throttleKey)) {
      const wait = accessCodeThrottle.retryAfter(throttleKey)
      throw new AppError(
        `提取码错误次数过多，请 ${wait} 秒后再试`,
        429,
        { key: '提取码错误次数过多，请 {} 秒后再试', params: [wait] },
      )
    }
    // 定长比较：普通的 !== 在第一个不同的字符处就返回，理论上能被逐位试出来
    if (!safeEqual(share.accessCode, accessCode ?? '')) {
      accessCodeThrottle.fail(throttleKey)
      throw new AppError('提取码不正确', 401)
    }
    accessCodeThrottle.reset(throttleKey)
  }

  if (count) {
    await prisma.share.update({ where: { id: share.id }, data: { downloadCount: { increment: 1 } } })
  }
  return share
}
