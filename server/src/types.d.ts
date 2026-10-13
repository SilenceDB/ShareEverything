/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import '@fastify/jwt'

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      id: string
      username: string
      role: string
      /** 签发时的令牌版本号，用于「改密即踢下线」 */
      tokenVersion: number
    }
    user: {
      id: string
      username: string
      role: string
    }
  }
}
