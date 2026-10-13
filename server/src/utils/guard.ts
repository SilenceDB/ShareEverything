/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import crypto from 'node:crypto'

/**
 * 「连续失败」节流器。
 *
 * 与路由级限流（按请求总数）的关键区别：**只统计失败的尝试，成功一次即清零**。
 *
 * 分享提取码必须这样做。一次正常的目录浏览会带出好几个请求 —— 预检、建打包任务、
 * 轮询进度、以及下载时的若干个 Range 请求 —— 如果按请求数限流，正常用户会先被
 * 自己的正常操作挡在门外；而真正要防的只是「同一个人对着一个分享反复猜提取码」。
 *
 * 计数按调用方给的 key 分开（这里是 `IP|分享code`），互不干扰：
 * 猜一个分享猜满了，不影响同一个 IP 访问别的分享。
 *
 * 状态全在内存里，进程重启即清空。对单实例部署足够；真要多实例部署，
 * 得把这里换成 Redis 之类的共享存储，否则限流会被按实例数放大。
 */
export class FailureThrottle {
  /** key → 窗口内失败时刻的列表（升序加入，天然有序） */
  private hits = new Map<string, number[]>()
  /** 上次全表清理的时间，避免每次调用都扫一遍 */
  private lastSweep = 0

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** 取出窗口内仍然有效的失败记录，顺手丢掉过期的 */
  private recent(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (kept.length) this.hits.set(key, kept)
    else this.hits.delete(key)
    return kept
  }

  /** 现在还可以再试一次吗 */
  allowed(key: string, now = Date.now()): boolean {
    this.sweep(now)
    return this.recent(key, now).length < this.max
  }

  /** 记一次失败 */
  fail(key: string, now = Date.now()): void {
    const list = this.recent(key, now)
    list.push(now)
    this.hits.set(key, list)
  }

  /** 校验成功：清零。正常用户永远不会被自己之前的操作连累 */
  reset(key: string): void {
    this.hits.delete(key)
  }

  /** 撞满之后还要等多少秒，用来给用户一个明确的提示 */
  retryAfter(key: string, now = Date.now()): number {
    const list = this.recent(key, now)
    if (list.length < this.max) return 0
    const oldest = list[0]
    if (oldest === undefined) return 0
    return Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000))
  }

  /** 整表扫一遍过期条目，避免长期运行后 Map 无限膨胀 */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return
    this.lastSweep = now
    for (const key of [...this.hits.keys()]) this.recent(key, now)
  }
}

/**
 * 定长时间的字符串比较。
 *
 * 普通的 `!==` 会在第一个不同的字符处就返回，比较耗时与「前多少个字符猜对了」
 * 相关，理论上可以用来一位一位地试出提取码。这里改用固定耗时的比较。
 * 长度不同时直接返回 false —— 长度本身不是秘密，提前返回不会泄露可用信息。
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}
