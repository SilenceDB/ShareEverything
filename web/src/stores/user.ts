/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { defineStore } from 'pinia'
import { api, TOKEN_KEY, type UserInfo } from '../api'

export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) ?? '',
    user: null as UserInfo | null,
    usedBytes: '0',
    /** 当前用户是否被允许发布磁盘目录（受服务端 MOUNT_CREATE_ROLE 控制） */
    canCreateMount: false,
  }),
  getters: {
    isLogin: (s) => !!s.token,
    isAdmin: (s) => s.user?.role === 'ADMIN',
  },
  actions: {
    setToken(token: string) {
      this.token = token
      localStorage.setItem(TOKEN_KEY, token)
    },
    logout() {
      this.token = ''
      this.user = null
      localStorage.removeItem(TOKEN_KEY)
    },
    async loadMe() {
      if (!this.token) return
      const data = await api.auth.me()
      this.user = data.user
      this.usedBytes = data.usedBytes
      this.canCreateMount = !!data.canCreateMount
    },
  },
})
