/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import type { FastifyRequest } from 'fastify'

/**
 * 请求来源判定，用于「只允许本机操作」这类保护。
 *
 * 设计原则是 **fail-closed**：只要能确定对面不是本机，就返回 false。
 * 所以这里不采信任何可以被客户端伪造的信息：
 *
 * - 只看 TCP 对端的真实地址（`socket.remoteAddress`），不看 `Host`、不解析
 *   `X-Forwarded-For`。本服务没有开 Fastify 的 `trustProxy`，`req.ip` 与
 *   `socket.remoteAddress` 等价，但我们仍然直接读 socket，免得哪天有人打开
 *   `trustProxy` 之后，这个保护被一个伪造的 `X-Forwarded-For: 127.0.0.1` 骗过去。
 * - 反过来，只要请求里**带了任何转发头**，就认定为「经过了代理」，一律不算本机。
 *   正常情况下直连本机的浏览器不会带这些头；而它一旦出现，说明前面挂了反向代理
 *   —— 此时所有外部请求在 TCP 层面都来自 127.0.0.1，本机判定就失去意义了。
 *   这条规则让那种部署变成「直接拒绝」，而不是「悄悄放行所有人」。
 */

/** 归一化地址：去掉 IPv4-mapped 前缀、IPv6 zone id、方括号，统一小写 */
export function normalizeIp(raw: string | undefined | null): string {
  let ip = (raw ?? '').trim()
  if (!ip) return ''
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  return ip.toLowerCase()
}

/** 是否是回环地址：IPv4 的 127.0.0.0/8，或 IPv6 的 ::1 */
export function isLoopbackIp(raw: string | undefined | null): boolean {
  const ip = normalizeIp(raw)
  if (!ip) return false
  if (ip === '::1') return true
  // ::ffff:0:0/96 之类的展开写法
  if (/^(0+:){7}0*1$/.test(ip)) return true
  if (/^127\./.test(ip)) return true
  return false
}

/** 请求是否带转发头（说明前面有代理，本机判定不可信） */
export function hasForwardingHeader(req: FastifyRequest): boolean {
  const h = req.headers
  return Boolean(
    h['x-forwarded-for'] ||
      h['x-real-ip'] ||
      h['forwarded'] ||
      h['x-forwarded-host'] ||
      h['x-forwarded-proto'],
  )
}

/**
 * 请求是否来自本机（回环地址 + 未经过代理）。
 *
 * 反向代理部署（nginx 与后端在同一台机器）时这里会恒为 false —— 这是刻意的，
 * 因为那种部署下 TCP 地址无法区分内外网。真要放开，得改用别的手段
 * （如前置代理注入的共享密钥），不能靠 IP。
 */
export function isLocalRequest(req: FastifyRequest): boolean {
  if (hasForwardingHeader(req)) return false
  return isLoopbackIp(req.socket?.remoteAddress)
}

/** 供日志使用：把来源描述成可读的一段 */
export function describeClient(req: FastifyRequest): string {
  const addr = normalizeIp(req.socket?.remoteAddress) || '未知'
  return hasForwardingHeader(req) ? `${addr}（经代理）` : addr
}
