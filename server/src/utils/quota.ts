/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { Transform, type TransformCallback } from 'node:stream'
import { prisma } from '../db.js'
import { AppError, humanSize } from './fs.js'

/**
 * 配额与已用空间的统一口径。
 *
 * 为什么要单独抽一个模块：配额判定散落在四个写盘入口（直传、init、chunk、complete），
 * 各自算各自的，很容易出现「A 处算进去了 B 处没算」的漏洞 —— 比如早期版本只统计
 * 已落库的 FileItem，于是并发建 N 个上传任务就能绕过 N 倍配额，而分片落在临时目录里
 * 更是完全不计入。现在所有入口都必须从这里取数。
 *
 * 三个口径，别混用：
 * - `stored`  已落库的文件字节（真正属于用户的文件）
 * - `pending` 在途上传任务**已落盘**的分片字节（在 tmp 里，但确实占着磁盘）
 * - `reserved` 在途上传任务**声明**的总大小（承诺量，用于建任务时判断还敢不敢接）
 *
 * 于是有两个「剩余」：
 * - `remaining`          = quota - stored - pending - inflight → **写盘**判定用它
 * - `remainingReserved`  = quota - stored - reserved            → **建任务**判定用它
 *
 * 用 reserved 而不是 pending 来接新任务，是因为一个声明 2GB 的任务只传了 10MB 时，
 * pending 只有 10MB，但它最终会占满 2GB；按 pending 放行等于超额承诺。
 */

/** 配额为 0 表示不限制，与 User.quotaBytes 的约定保持一致 */
const UNLIMITED = BigInt(0)

export interface QuotaState {
  /** 配额总量；0 表示不限 */
  quota: bigint
  /** 已落库文件的字节总和 */
  stored: bigint
  /** 在途任务已落盘的分片字节总和 */
  pending: bigint
  /** 在途任务声明的总大小 */
  reserved: bigint
  /** 本次进程内已为其它并发请求预留的字节（直传用） */
  inflight: bigint
  /** 还能写多少字节；不限额时为 null */
  remaining: bigint | null
  /** 还能再接多大的新任务；不限额时为 null */
  remainingReserved: bigint | null
}

/**
 * 直传（`/api/files/upload`）没有 UploadTask 记录，没法像分片那样把预留写进数据库。
 * 于是用进程内的计数器顶上：请求开始时登记额度，结束时释放。
 *
 * 它只在单进程内有效，跨进程（cluster / 多实例）会重复放行 —— 但本项目是 fork 单实例
 * （SQLite 单写进程，见部署约定），所以够用。真要多实例，得换成带原子自增的共享存储。
 */
const inflight = new Map<string, bigint>()

export function inflightBytes(userId: string): bigint {
  return inflight.get(userId) ?? BigInt(0)
}

/** 登记一笔进程内在途占用，返回释放函数（幂等，必须放到 finally 里调用） */
export function reserveInFlight(userId: string, bytes: bigint): () => void {
  if (bytes > BigInt(0)) inflight.set(userId, inflightBytes(userId) + bytes)
  let released = false
  return () => {
    if (released) return
    released = true
    if (bytes <= BigInt(0)) return
    const next = inflightBytes(userId) - bytes
    if (next <= BigInt(0)) inflight.delete(userId)
    else inflight.set(userId, next)
  }
}

export async function quotaState(userId: string): Promise<QuotaState> {
  const [user, storedAgg, pendingAgg, reservedAgg] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { quotaBytes: true } }),
    prisma.fileItem.aggregate({ where: { userId }, _sum: { size: true } }),
    prisma.uploadTask.aggregate({ where: { userId }, _sum: { receivedBytes: true } }),
    prisma.uploadTask.aggregate({ where: { userId }, _sum: { size: true } }),
  ])

  // 走到这里的请求都过了 authGuard（它会回读数据库比对 tokenVersion），用户必然存在；
  // 真查不到时按「不限」处理，宁可放过也不要因为一条查不到的记录卡住上传。
  const quota = user?.quotaBytes ?? UNLIMITED
  const stored = storedAgg._sum.size ?? BigInt(0)
  const pending = pendingAgg._sum.receivedBytes ?? BigInt(0)
  const reserved = reservedAgg._sum.size ?? BigInt(0)
  const inflightNow = inflightBytes(userId)

  const remaining = quota === UNLIMITED ? null : quota - stored - pending - inflightNow
  const remainingReserved = quota === UNLIMITED ? null : quota - stored - reserved

  return { quota, stored, pending, reserved, inflight: inflightNow, remaining, remainingReserved }
}

/**
 * 写盘前的硬判定：剩余额度不够就抛 413，**一个字节都不许落盘**。
 *
 * 传 `remaining` 还是 `remainingReserved` 由调用方决定 —— 建任务用后者（看承诺），
 * 写盘用前者（看实际占用）。
 */
export function assertFits(remaining: bigint | null, bytes: bigint): void {
  if (remaining === null) return
  if (bytes <= remaining) return
  const left = remaining > BigInt(0) ? remaining : BigInt(0)
  throw new AppError(`存储空间不足（剩余额度 ${humanSize(left)}）`, 413, {
    key: '存储空间不足（剩余额度 {}）',
    params: [humanSize(left)],
  })
}

/**
 * 本次最多允许往盘上写多少字节。
 *
 * 它同时被用在两个地方：作为写盘前的额度判断，以及作为 `ByteLimitStream` 的截断上限 ——
 * 这样写盘**过程中**一旦逼近额度就立刻中断，而不是写完整个文件再回滚。
 * 返回 0 表示一点空间都没有了。
 */
export function allowanceBytes(remaining: bigint | null, wantMax: number): number {
  if (remaining === null) return wantMax
  if (remaining <= BigInt(0)) return 0
  return remaining > BigInt(wantMax) ? wantMax : Number(remaining)
}

/**
 * 按字节上限截断的透传流。
 *
 * 插在 `pipeline(源, 本流, 目标文件)` 中间：累计写入量在上限之内照常透传，
 * 越过上限之后**继续消费但直接丢弃**，并把 `exceeded` 置上。
 *
 * 光靠「写盘前判定」是不够的：客户端声明的大小可以撒谎，`Content-Length` 也可能与
 * 实际流式内容不一致。只有边写边数才能真正保证「磁盘占用不会越过配额」。
 *
 * 为什么不超限就立刻抛错中断：那会让请求体剩下一大截没读，Node 随即重置连接，
 * 客户端拿到的是 `ECONNRESET` 而不是我们精心准备的 413 —— 前端连错误文案都收不到。
 * 所以这里忍痛把剩下的数据读完（只是不再往盘上写），换取一次干净的错误响应。
 * 能读多少仍受 multipart 的 fileSize 与路由 bodyLimit 约束，不存在被无限拖住的风险。
 *
 * 用法：pipeline 结束后必须检查 `exceeded`，为真则删掉目标文件并回 413。
 */
export class ByteLimitStream extends Transform {
  private seen = 0
  /** 写入过程中是否越过了上限 */
  exceeded = false

  constructor(private readonly maxBytes: number) {
    super()
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.exceeded) {
      // 已经越线：把剩下的数据吞掉，让请求体被完整消费
      cb()
      return
    }
    this.seen += chunk.length
    if (this.seen <= this.maxBytes) {
      cb(null, chunk)
      return
    }
    this.exceeded = true
    // 只把没越线的那部分写下去，超出部分丢弃
    const over = this.seen - this.maxBytes
    const allow = chunk.length - over
    cb(null, allow > 0 ? chunk.subarray(0, allow) : undefined)
  }
}

/** 配额越线时统一抛出的错误：调用方在 pipeline 之后检查 `exceeded` 再调用它 */
export function quotaExceeded(): AppError {
  return new AppError('存储空间不足', 413)
}

/**
 * 调整某个在途任务的已收字节数（正数增加、负数回滚）。
 *
 * 失败要静默：任务可能已经因为合并完成或用户取消而被删掉，那时再更新它没有意义，
 * 更不能因此让上传请求本身报错。
 */
export async function addPending(taskId: string, delta: bigint): Promise<void> {
  if (delta === BigInt(0)) return
  await prisma.uploadTask
    .update({ where: { id: taskId }, data: { receivedBytes: { increment: delta } } })
    .catch(() => {})
}
