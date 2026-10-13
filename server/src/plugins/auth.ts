/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import jwt from '@fastify/jwt'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { localeFromRequest, t } from '../i18n/index.js'

export async function registerJwt(app: FastifyInstance) {
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
  })
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  // 浏览器直接打开下载链接时带不上请求头，允许用 ?token= 透传
  const query = (request.query ?? {}) as { token?: string }
  return query.token
}

interface AuthedUser {
  id: string
  username: string
  role: string
}

/**
 * 校验令牌并回读用户当前状态，未通过时**已经写好响应**并返回 null。
 *
 * 为什么不只看 JWT 本身：JWT 是无状态的，签发之后无法撤回。这里的处理是
 * 每个请求都拿库里的 role / tokenVersion 复核一次 ——
 *   · tokenVersion 不等 → 令牌是在某次改密之前签发的，立即作废（改密即踢下线）；
 *   · role 以库为准 → 管理员被降权后，手里的旧令牌当场失去管理员权能。
 * 代价是每请求多一次按主键的查询，SQLite 本地读，可忽略。
 *
 * 载荷里没有 tokenVersion 字段的令牌（本次改动之前签发的）一律判为作废，
 * 也就是说升级后所有人需要重新登录一次 —— 宁可多登一次，也不放过旧令牌。
 */
async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthedUser | null> {
  const token = extractToken(request)
  if (!token) {
    reply.code(401).send({ error: t(localeFromRequest(request), '未登录或登录已过期') })
    return null
  }

  let payload: { id: string; tokenVersion: number }
  try {
    payload = request.server.jwt.verify(token) as { id: string; tokenVersion: number }
  } catch {
    reply.code(401).send({ error: t(localeFromRequest(request), '未登录或登录已过期') })
    return null
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.id },
    select: { id: true, username: true, role: true, tokenVersion: true },
  })
  if (!user) {
    reply.code(401).send({ error: t(localeFromRequest(request), '账号不存在或已被删除') })
    return null
  }
  if (payload.tokenVersion !== user.tokenVersion) {
    reply.code(401).send({ error: t(localeFromRequest(request), '登录状态已失效，请重新登录') })
    return null
  }
  return { id: user.id, username: user.username, role: user.role }
}

/** 需要登录：挂在 onRequest 上 */
export async function authGuard(request: FastifyRequest, reply: FastifyReply) {
  const user = await authenticate(request, reply)
  if (!user) return reply
  request.user = user
}

/** 需要管理员 */
export async function adminGuard(request: FastifyRequest, reply: FastifyReply) {
  const user = await authenticate(request, reply)
  if (!user) return reply
  if (user.role !== 'ADMIN') {
    return reply.code(403).send({ error: t(localeFromRequest(request), '需要管理员权限') })
  }
  request.user = user
}
