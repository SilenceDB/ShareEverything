/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '../stores/user'

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/Login.vue') },
  { path: '/files', name: 'files', component: () => import('../views/Files.vue'), meta: { auth: true } },
  { path: '/mounts', name: 'mounts', component: () => import('../views/Mounts.vue'), meta: { auth: true } },
  { path: '/shares', name: 'shares', component: () => import('../views/Shares.vue'), meta: { auth: true } },
  {
    path: '/users',
    name: 'users',
    component: () => import('../views/Users.vue'),
    meta: { auth: true, admin: true },
  },
  { path: '/s/:code', name: 'public-share', component: () => import('../views/PublicShare.vue') },
  { path: '/', redirect: '/files' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  if (!to.meta.auth) return true
  const store = useUserStore()
  if (!store.isLogin) return { name: 'login', query: { redirect: to.fullPath } }
  // 管理员页面要先知道当前用户的角色。刷新页面时 store.user 还是空的，
  // 这里补一次拉取；App.vue 挂载时看到 user 已存在就不会重复请求。
  if (to.meta.admin && !store.user) {
    try {
      await store.loadMe()
    } catch {
      /* 401 已由响应拦截器统一处理（清 token 并跳登录） */
    }
  }
  if (to.meta.admin && !store.isAdmin) return { name: 'files' }
  return true
})

export default router
