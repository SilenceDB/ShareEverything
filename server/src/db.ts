/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
