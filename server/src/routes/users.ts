/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import path from 'node:path'
import fs from 'node:fs'
import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { AppError } from '../utils/fs.js'
import { adminGuard } from '../plugins/auth.js'

/**
 * 用户管理（管理员）。
 *
 * 这里只管「账号本身」：建立账号、重置他人密码、删除账号。
 * 任何人改**自己**的密码走的是 /api/auth/password（需要原密码），不在这里。
 *
 * 所有改动密码的入口都会把 User.tokenVersion +1，也就是改密即踢下线：
 * 该账号此前签发的令牌立刻作废，用户必须用新密码重新登录。
 */

const ROLES = ['USER', 'ADMIN'] as const

function publicUser(u: {
  id: string
  email: string
  username: string
  role: string
  quotaBytes: bigint
  createdAt: Date
}) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    quotaBytes: u.quotaBytes.toString(),
    createdAt: u.createdAt,
  }
}

/** 把请求里传来的配额解析成字节数；没传则返回 undefined（交给数据库默认值） */
function parseQuota(raw: unknown): bigint | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new AppError('配额必须是不小于 0 的数字')
  return BigInt(Math.floor(n))
}

export async function userRoutes(app: FastifyInstance) {
  /** 用户列表。顺带把每个用户已占用的空间算出来，管理员一眼能看出谁把盘塞满了 */
  app.get('/api/users', { onRequest: [adminGuard] }, async () => {
    const users = await prisma.user.findMany({
      // 管理员排前面，同级按创建时间
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    })
    // 一次 groupBy 算完全部用户的用量，别在循环里逐个查询
    const usage = await prisma.fileItem.groupBy({ by: ['userId'], _sum: { size: true } })
    const usedMap = new Map(usage.map((u) => [u.userId, u._sum.size ?? BigInt(0)]))
    return users.map((u) => ({
      ...publicUser(u),
      usedBytes: (usedMap.get(u.id) ?? BigInt(0)).toString(),
    }))
  })

  /** 新增用户：邮箱 / 用户名 / 密码必填，角色与配额可选 */
  app.post('/api/users', { onRequest: [adminGuard] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      email?: string
      username?: string
      password?: string
      role?: string
      quotaBytes?: number | string
    }
    const email = (body.email ?? '').trim()
    const username = (body.username ?? '').trim()
    const password = body.password ?? ''
    const role = (body.role ?? 'USER').toUpperCase()

    if (!email || !username || !password) throw new AppError('邮箱、用户名、密码不能为空')
    if (password.length < 6) throw new AppError('密码至少 6 位')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('邮箱格式不正确')
    if (!ROLES.includes(role as (typeof ROLES)[number])) throw new AppError('角色只能是 USER 或 ADMIN')
    const quotaBytes = parseQuota(body.quotaBytes)

    // 哈希放事务外算，别把 bcrypt 的耗时算进持锁时间里
    const hashed = await bcrypt.hash(password, 10)

    // 唯一性检查与建号放同一事务：否则两个并发请求会同时读不到重名，各建一个
    const created = await prisma.$transaction(async (tx) => {
      const exist = await tx.user.findFirst({ where: { OR: [{ email }, { username }] } })
      if (exist) {
        throw new AppError(
          exist.email === email ? '该邮箱已被占用' : '该用户名已被占用',
          409,
        )
      }
      return tx.user.create({
        data: { email, username, password: hashed, role, ...(quotaBytes !== undefined ? { quotaBytes } : {}) },
      })
    })

    console.warn(
      `[users] 管理员 ${req.user.username} 新建了账号 ${created.username} <${created.email}>（${created.role}）`,
    )
    return reply.code(201).send({ ...publicUser(created), usedBytes: '0' })
  })

  /** 重置某个用户的密码（管理员，不需要原密码）。改完该用户的登录态立即失效 */
  app.patch('/api/users/:id/password', { onRequest: [adminGuard] }, async (req) => {
    const { id } = req.params as { id: string }
    const { password } = (req.body ?? {}) as { password?: string }
    if (!password) throw new AppError('新密码不能为空')
    if (password.length < 6) throw new AppError('新密码至少 6 位')

    const target = await prisma.user.findUnique({ where: { id } })
    if (!target) throw new AppError('用户不存在', 404)

    await prisma.user.update({
      where: { id },
      data: { password: await bcrypt.hash(password, 10), tokenVersion: { increment: 1 } },
    })
    console.warn(
      `[users] 管理员 ${req.user.username} 重置了 ${target.username} <${target.email}> 的密码，` +
        `其已有登录态已全部失效`,
    )
    return { ok: true }
  })

  /** 删除用户：其文件库、分享、磁盘发布记录由数据库级联删除，磁盘上的个人目录另行清理 */
  app.delete('/api/users/:id', { onRequest: [adminGuard] }, async (req) => {
    const { id } = req.params as { id: string }
    if (id === req.user.id) throw new AppError('不能删除当前登录的账号', 400)

    const target = await prisma.user.findUnique({ where: { id } })
    if (!target) throw new AppError('用户不存在', 404)

    // 检查「是不是最后一个管理员」与删除放同一事务，避免并发各删一个把管理员删空
    await prisma.$transaction(async (tx) => {
      if (target.role === 'ADMIN') {
        const admins = await tx.user.count({ where: { role: 'ADMIN' } })
        if (admins <= 1) throw new AppError('系统至少需要保留一个管理员账号', 400)
      }
      await tx.user.delete({ where: { id } })
    })

    // 数据库记录已随级联删掉，但磁盘上的个人文件目录没人管，这里顺手清掉。
    // 删库成功、清盘失败只是留下垃圾，不该让整个请求失败，所以吞掉异常只记日志。
    const dir = path.join(config.storageRoot, 'users', id)
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch (err) {
      console.warn(`[users] 已删除账号但未能清理其文件目录 ${dir}：${String(err)}`)
    }

    console.warn(`[users] 管理员 ${req.user.username} 删除了账号 ${target.username} <${target.email}>`)
    return { ok: true }
  })
}
