/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../db.js'
import { config, userStorageDir } from '../config.js'
import { AppError, normalizeRel, realRoot, resolveInside, safeJoin } from '../utils/fs.js'
import { createArchiveStream, planDirectory, type ArchivePlan, type ZipMode } from '../utils/zip.js'

/**
 * 后台打包任务：先把 ZIP 生成到服务端的临时文件，再以普通文件方式提供下载。
 *
 * 为什么不直接用流式打包：几十 GB 的目录要维持一条 HTTP 连接几十分钟，
 * 中间断一次就得从头再来。拆成「先打包成文件 + 再下载」之后，
 * 下载阶段就是普通静态文件，现有的 Range 断点续传可以直接复用。
 *
 * 打包的字节流仍然是同一个 createArchiveStream()，只是把 pipe 的目标
 * 从 HTTP 响应换成了文件 —— 两种模式的打包逻辑只有这一处差别。
 */

/* ---------------- 并发名额（同步打包与后台任务共用） ---------------- */

let activeArchives = 0
const waiting: Array<() => void> = []

export function acquireSlot(): Promise<() => void> {
  if (activeArchives < Math.max(1, config.zipConcurrency)) {
    activeArchives++
    return Promise.resolve(release)
  }
  return new Promise<() => void>((resolve) => {
    waiting.push(() => {
      activeArchives++
      resolve(release)
    })
  })
}

function release(): void {
  activeArchives--
  const next = waiting.shift()
  if (next) next()
}

/* ---------------- 预检结果缓存 ---------------- */

const planCache = new Map<string, { exp: number; plan: ArchivePlan }>()
const PLAN_CACHE_MAX = 20

export function getPlan(
  shareId: string,
  mode: ZipMode,
  build: () => ArchivePlan,
): ArchivePlan {
  const key = `${shareId}:${mode}`
  const hit = planCache.get(key)
  if (hit && hit.exp > Date.now()) return hit.plan
  if (planCache.size >= PLAN_CACHE_MAX) {
    const oldest = [...planCache.entries()].sort((a, b) => a[1].exp - b[1].exp)[0]
    if (oldest) planCache.delete(oldest[0])
  }
  const plan = build()
  planCache.set(key, { exp: Date.now() + config.zipPlanCacheTtl * 1000, plan })
  return plan
}

export function dropPlanCache(shareId: string): void {
  for (const key of planCache.keys()) {
    if (key.startsWith(`${shareId}:`)) planCache.delete(key)
  }
}

/* ---------------- 分享目标解析 ---------------- */

export interface ShareTarget {
  abs: string
  filename: string
  /** 打包时的边界：软链接展开后仍要落在它里面才算合法 */
  rootAbs: string
  isDir: boolean
}

/**
 * 把一条分享解析成服务器上的真实路径。
 * 每次都重新解析，不信任任何缓存下来的绝对路径。
 */
export async function resolveShareTarget(
  share: { targetType: string; fileId: string | null; mountId: string | null; subPath: string },
): Promise<ShareTarget> {
  if (share.targetType === 'FILE') {
    const file = await prisma.fileItem.findUnique({ where: { id: share.fileId ?? '' } })
    if (!file) throw new AppError('源文件已被删除', 404)
    const root = userStorageDir(file.userId)
    const abs = safeJoin(root, file.relPath)
    return { abs, filename: file.name, rootAbs: root, isDir: !!file.isDir }
  }
  const mount = await prisma.mount.findUnique({ where: { id: share.mountId ?? '' } })
  if (!mount) throw new AppError('源目录已被删除', 404)
  // 逻辑文件夹没有磁盘路径；建分享时已拦掉，这里兜底处理历史数据
  if (!mount.absPath) throw new AppError('该分享指向的是逻辑文件夹，无法打包', 400)
  const rel = normalizeRel(share.subPath)
  const abs = resolveInside(mount.absPath, rel)
  return {
    abs,
    filename: rel.split('/').pop() || path.basename(abs),
    rootAbs: realRoot(mount.absPath),
    isDir: fs.statSync(abs).isDirectory(),
  }
}

/* ---------------- 任务生命周期 ---------------- */

export function jobPath(id: string): string {
  return path.join(config.archiveRoot, `${id}.zip`)
}

export function jobDto(job: {
  id: string
  mode: string
  status: string
  fileCount: number
  totalBytes: bigint
  zipBytes: bigint | null
  processedFiles: number
  processedBytes: bigint
  error: string | null
  createdAt: Date
  expiresAt: Date
}) {
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    fileCount: job.fileCount,
    totalBytes: job.totalBytes.toString(),
    zipBytes: job.zipBytes == null ? null : job.zipBytes.toString(),
    processedFiles: job.processedFiles,
    processedBytes: job.processedBytes.toString(),
    error: job.error,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    // 条目进度优先（数字直观），没有条目数时退回字节进度
    percent:
      job.fileCount > 0
        ? Math.min(100, Math.round((job.processedFiles * 100) / job.fileCount))
        : job.totalBytes > 0n
          ? Math.min(100, Number((job.processedBytes * 100n) / job.totalBytes))
          : 0,
  }
}

export type JobDto = ReturnType<typeof jobDto>

/**
 * 建一个打包任务。同一个分享 + 同一种档位会复用已有任务：
 * 已经打包好的直接返回（秒开），正在打包的共享同一份进度。
 */
export async function createArchiveJob(
  shareId: string,
  mode: ZipMode,
  plan: ArchivePlan,
): Promise<JobDto> {
  const reusable = await prisma.archiveJob.findFirst({
    where: {
      shareId,
      mode,
      status: { in: ['QUEUED', 'RUNNING', 'READY'] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (reusable) return jobDto(reusable)

  const busy = await prisma.archiveJob.count({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
  })
  if (busy >= Math.max(1, config.archiveMaxJobs)) {
    throw new AppError('当前打包任务已满，请稍后再试', 429)
  }

  const job = await prisma.archiveJob.create({
    data: {
      shareId,
      mode,
      status: 'QUEUED',
      fileCount: plan.fileCount,
      totalBytes: BigInt(plan.totalBytes),
      expiresAt: new Date(Date.now() + config.archiveJobTtlHours * 3600_000),
    },
  })
  // 不 await：任务在后台跑，接口立刻返回给前端去轮询
  void runJob(job.id)
  return jobDto(job)
}

/** 真正干活的地方：生成 ZIP 到临时文件，期间按节流更新进度 */
async function runJob(id: string): Promise<void> {
  const release = await acquireSlot()
  try {
    const job = await prisma.archiveJob.findUnique({ where: { id } })
    if (!job) return
    const share = await prisma.share.findUnique({ where: { id: job.shareId } })
    if (!share) {
      await prisma.archiveJob.update({
        where: { id },
        data: { status: 'FAILED', error: '分享已被删除' },
      })
      return
    }

    const target = await resolveShareTarget(share)
    const mode = job.mode as ZipMode
    const plan = getPlan(share.id, mode, () =>
      planDirectory(target.rootAbs, target.abs, target.filename, mode),
    )

    await prisma.archiveJob.update({
      where: { id },
      data: { status: 'RUNNING', fileCount: plan.fileCount, totalBytes: BigInt(plan.totalBytes) },
    })

    const finalPath = jobPath(id)
    const tmpPath = `${finalPath}.part`
    await fsp.mkdir(path.dirname(finalPath), { recursive: true })
    const out = fs.createWriteStream(tmpPath)

    let last = 0
    let lastFiles = 0
    const flush = (files: number, bytes: number, force = false) => {
      const now = Date.now()
      // 每 500ms 最多写一次库：进度上报的频率不该超过人眼能感知的范围，
      // 更不能因为写库把打包过程拖慢
      if (!force && now - last < 500 && files - lastFiles < 50) return
      last = now
      lastFiles = files
      void prisma.archiveJob
        .update({ where: { id }, data: { processedFiles: files, processedBytes: BigInt(bytes) } })
        .catch(() => {})
    }

    await new Promise<void>((resolve, reject) => {
      const stream = createArchiveStream(plan, {
        onEntry: (done, bytesWritten) => flush(done, bytesWritten),
      })
      stream.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => resolve())
      stream.pipe(out)
    })

    const stat = await fsp.stat(tmpPath)
    await fsp.rename(tmpPath, finalPath)
    await prisma.archiveJob.update({
      where: { id },
      data: {
        status: 'READY',
        zipPath: finalPath,
        zipBytes: BigInt(stat.size),
        processedFiles: plan.fileCount,
        processedBytes: BigInt(plan.totalBytes),
      },
    })
  } catch (e: any) {
    const tmpPath = `${jobPath(id)}.part`
    await fsp.rm(tmpPath, { force: true }).catch(() => {})
    await prisma.archiveJob
      .update({ where: { id }, data: { status: 'FAILED', error: e?.message ?? '打包失败' } })
      .catch(() => {})
  } finally {
    release()
  }
}

/** 删除任务的临时文件（记录由调用方或级联删除处理） */
export async function removeJobFile(zipPath: string | null): Promise<void> {
  if (!zipPath) return
  const root = path.resolve(config.archiveRoot)
  const abs = path.resolve(zipPath)
  // 只允许删自己目录里的文件，避免被存进来的路径带偏
  if (abs !== root && !abs.startsWith(root + path.sep)) return
  await fsp.rm(abs, { force: true }).catch(() => {})
  await fsp.rm(`${abs}.part`, { force: true }).catch(() => {})
}

/** 清理过期任务；顺带清理没有对应记录的孤儿文件 */
export async function cleanupExpiredJobs(): Promise<number> {
  const now = new Date()
  const stale = await prisma.archiveJob.findMany({
    where: { expiresAt: { lt: now }, status: { not: 'RUNNING' } },
  })
  for (const job of stale) {
    await removeJobFile(job.zipPath)
    await prisma.archiveJob.delete({ where: { id: job.id } }).catch(() => {})
  }

  // 服务重启后，数据库里可能已经没有记录但文件还在
  try {
    const known = new Set(
      (await prisma.archiveJob.findMany({ select: { zipPath: true } }))
        .map((j) => j.zipPath)
        .filter(Boolean)
        .map((p) => path.resolve(String(p))),
    )
    const files = await fsp.readdir(config.archiveRoot)
    const cutoff = Date.now() - config.archiveJobTtlHours * 3600_000
    for (const f of files) {
      const abs = path.join(config.archiveRoot, f)
      if (known.has(path.resolve(abs))) continue
      const st = await fsp.stat(abs).catch(() => null)
      if (st && st.mtimeMs < cutoff) await fsp.rm(abs, { force: true }).catch(() => {})
    }
  } catch {
    /* 目录还不存在，跳过 */
  }

  return stale.length
}

/**
 * 进程重启后，数据库里可能还留着 RUNNING 状态的任务，但已经没有人在跑它们了。
 * 这些任务既不推进也不会被清理（清理会跳过 RUNNING），必须重置掉。
 */
async function resetRunningJobs(): Promise<void> {
  const stuck = await prisma.archiveJob.findMany({ where: { status: 'RUNNING' } })
  for (const job of stuck) {
    await removeJobFile(job.zipPath)
    await prisma.archiveJob
      .update({
        where: { id: job.id },
        data: { status: 'FAILED', error: '服务重启，打包已中断' },
      })
      .catch(() => {})
  }
}

/** 启动时挂一个定时清理 */
export function startArchiveCleanup(): void {
  void resetRunningJobs()
  void cleanupExpiredJobs()
  const ms = Math.max(1, config.archiveCleanupIntervalMinutes) * 60_000
  const timer = setInterval(() => {
    void cleanupExpiredJobs()
  }, ms)
  timer.unref?.()
}
