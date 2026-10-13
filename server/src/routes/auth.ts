/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../db.js'
import { canCreateMount, config } from '../config.js'
import { AppError } from '../utils/fs.js'
import { describeClient, isLocalRequest } from '../utils/request.js'
import { authGuard } from '../plugins/auth.js'

function issueToken(
  app: FastifyInstance,
  user: { id: string; username: string; role: string; tokenVersion: number },
) {
  return app.jwt.sign({
    id: user.id,
    username: user.username,
    role: user.role,
    // 带上令牌版本号，鉴权时会与库里的值比对；密码一改它就作废
    tokenVersion: user.tokenVersion,
  })
}

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

export async function authRoutes(app: FastifyInstance) {
  /**
   * 公开的登录页配置，不暴露任何敏感信息，只告诉前端该渲染什么。
   *
   * 注册入口是否出现，完全由「系统里有没有管理员」决定 —— 不再有配置开关：
   * 第一个注册的账号就是管理员，它一旦建立，注册入口就永久消失。
   */
  app.get('/api/auth/config', async (req) => {
    const admins = await prisma.user.count({ where: { role: 'ADMIN' } })
    return {
      /** 只有系统里还没有管理员时才允许注册（也就是那个「第一个账号」） */
      canRegister: admins === 0,
      hasAdmin: admins > 0,
      /** 是否开启了管理员密码找回 */
      adminResetEnabled: config.allowAdminResetPassword,
      /** 密码找回恒定为「仅本机可用」，前端据此提示，不需要再配置 */
      adminResetLocalOnly: true,
      /** 本次请求是不是从服务器本机发出的（供登录页给出准确提示） */
      fromLocalhost: isLocalRequest(req),
    }
  })

  /**
   * 注册。同样压一个限流：bcrypt 是在校验「系统是否已初始化」**之前**跑的，
   * 不挡的话，任何人都能用一堆注册请求把 CPU 烧掉。限流值与登录一致。
   */
  app.post('/api/auth/register', {
    config: {
      rateLimit: {
        max: config.rateLimitLoginMax,
        timeWindow: config.rateLimitLoginWindowMinutes * 60_000,
      },
    },
  }, async (req, reply) => {
    const { email, username, password } = (req.body ?? {}) as {
      email?: string
      username?: string
      password?: string
    }
    if (!email || !username || !password) throw new AppError('邮箱、用户名、密码不能为空')
    if (password.length < 6) throw new AppError('密码至少 6 位')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('邮箱格式不正确')

    // 哈希放事务外算，别把 bcrypt 的耗时算进持锁时间里
    const hashed = await bcrypt.hash(password, 10)

    // 只有「系统里还没有管理员」时才允许注册，且第一个账号必然是 ADMIN。
    // 检查与建号放进同一个事务：否则两个并发请求会同时读到空库，各建一个管理员。
    const user = await prisma.$transaction(async (tx) => {
      const admins = await tx.user.count({ where: { role: 'ADMIN' } })
      if (admins > 0) {
        throw new AppError('系统已完成初始化，管理员账号已存在，请联系管理员开通账号', 403)
      }
      const exist = await tx.user.findFirst({ where: { OR: [{ email }, { username }] } })
      if (exist) throw new AppError('邮箱或用户名已被占用', 409)
      return tx.user.create({ data: { email, username, password: hashed, role: 'ADMIN' } })
    })

    return reply.code(201).send({ token: issueToken(app, user), user: publicUser(user) })
  })

  /**
   * 登录。全项目唯一「靠猜就能拿到权限」的入口，压最严的限流：
   * 默认 10 次 / 5 分钟。正常人手速远远够用，脚本级的爆破则直接被挡。
   * 窗口和次数都能用 RATE_LIMIT_LOGIN_MAX / RATE_LIMIT_LOGIN_WINDOW_MINUTES 调。
   */
  app.post('/api/auth/login', {
    config: {
      rateLimit: {
        max: config.rateLimitLoginMax,
        timeWindow: config.rateLimitLoginWindowMinutes * 60_000,
      },
    },
  }, async (req, reply) => {
    const { account, password } = (req.body ?? {}) as { account?: string; password?: string }
    if (!account || !password) throw new AppError('账号和密码不能为空')

    const user = await prisma.user.findFirst({
      where: { OR: [{ username: account }, { email: account }] },
    })
    if (!user) throw new AppError('账号或密码错误', 401)

    let resetPassword = false
    if (!(await bcrypt.compare(password, user.password))) {
      // 管理员密码找回（应对「密码忘了进不去」）：
      // 只在「旧密码校验不通过」时走这条路，所以正常登录绝不会被顺手改掉密码。
      // 开关关闭（默认）或目标账号不是管理员时，一律按普通的密码错误处理。
      if (!config.allowAdminResetPassword || user.role !== 'ADMIN') {
        throw new AppError('账号或密码错误', 401)
      }
      // 再一道闸：密码找回只允许**从服务器本机**发起。
      // 否则开关一开，任何能访问到本服务的人，只要知道管理员邮箱就能把它的密码改掉。
      // 非本机一律按普通的密码错误回绝（不透露「其实有这个通道」），仅服务端留痕。
      if (!isLocalRequest(req)) {
        console.warn(
          `[auth] 已拒绝非本机的管理员密码找回（仅允许 127.0.0.1 / localhost）：` +
            `来源 ${describeClient(req)}，账号 ${user.username} <${user.email}>`,
        )
        throw new AppError('账号或密码错误', 401)
      }
      if (password.length < 6) throw new AppError('新密码至少 6 位')
      // 改密的同时把令牌版本 +1：这个账号此前签发的所有令牌（别的浏览器、别的设备）立即失效
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { password: await bcrypt.hash(password, 10), tokenVersion: { increment: 1 } },
        select: { tokenVersion: true },
      })
      user.tokenVersion = updated.tokenVersion
      // console 已被 logger 接管，会落进 logs/app-YYYY-MM-DD.log，留个痕
      console.warn(
        `[auth] 管理员密码已通过「密码找回」重设（本机 ${describeClient(req)}）：` +
          `${user.username} <${user.email}>`,
      )
      resetPassword = true
    }

    return { token: issueToken(app, user), user: publicUser(user), resetPassword }
  })

  app.get('/api/auth/me', { onRequest: [authGuard] }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!user) throw new AppError('用户不存在', 404)

    const used = await prisma.fileItem.aggregate({
      where: { userId: user.id },
      _sum: { size: true },
    })
    return {
      user: publicUser(user),
      usedBytes: (used._sum.size ?? BigInt(0)).toString(),
      // 前端据此决定要不要显示「发布磁盘目录」按钮
      canCreateMount: canCreateMount(user.role),
    }
  })

  /**
   * 本人修改自己的密码：必须提供原密码。
   *
   * 改完把令牌版本 +1，于是该账号在其他浏览器 / 其他设备上的登录态全部失效；
   * 但当前这台机器不能把自己也踢掉，所以顺手签发一枚新令牌回给前端替换。
   */
  app.post('/api/auth/password', { onRequest: [authGuard] }, async (req) => {
    const { oldPassword, newPassword } = (req.body ?? {}) as {
      oldPassword?: string
      newPassword?: string
    }
    if (!oldPassword || !newPassword) throw new AppError('请填写原密码和新密码')
    if (newPassword.length < 6) throw new AppError('新密码至少 6 位')
    if (newPassword === oldPassword) throw new AppError('新密码不能与原密码相同')

    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!user) throw new AppError('用户不存在', 404)
    if (!(await bcrypt.compare(oldPassword, user.password))) {
      throw new AppError('原密码不正确', 401)
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(newPassword, 10), tokenVersion: { increment: 1 } },
      select: { id: true, username: true, role: true, tokenVersion: true },
    })
    console.warn(`[auth] ${user.username} <${user.email}> 修改了本人密码，其余已登录会话已失效`)
    // 当前会话用这枚新令牌续上，其他会话则因为版本号对不上而失效
    return { ok: true, token: issueToken(app, updated) }
  })
}
