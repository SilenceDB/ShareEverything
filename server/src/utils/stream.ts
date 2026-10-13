/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import fs from 'node:fs'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { localeFromRequest, t } from '../i18n/index.js'

/**
 * 以流式方式把文件写给客户端，支持 HTTP Range（断点续传 / 视频拖动）。
 */
export function streamFile(
  req: FastifyRequest,
  reply: FastifyReply,
  absPath: string,
  filename: string,
): FastifyReply {
  const locale = localeFromRequest(req)
  if (!fs.existsSync(absPath)) {
    return reply.code(404).send({ error: t(locale, '文件不存在') })
  }
  const stat = fs.statSync(absPath)
  if (stat.isDirectory()) {
    return reply.code(400).send({ error: t(locale, '不能直接下载目录') })
  }

  const size = stat.size
  const type = 'application/octet-stream'
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`

  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0
      const end = m[2] ? parseInt(m[2], 10) : size - 1
      if (start >= size || start > end) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${size}`)
          .send({ error: t(locale, 'Range 超出范围') })
      }
      const realEnd = Math.min(end, size - 1)
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${realEnd}/${size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Type', type)
        .header('Content-Disposition', disposition)
        .send(fs.createReadStream(absPath, { start, end: realEnd }))
    }
  }

  // 注意：async 路由里必须把 reply 返回出去，否则 Fastify 会发一个空响应体
  return reply
    .header('Accept-Ranges', 'bytes')
    .header('Content-Length', size)
    .header('Content-Type', type)
    .header('Content-Disposition', disposition)
    .send(fs.createReadStream(absPath))
}
