/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'
import { i18n, syncDocumentLang } from './i18n'

const app = createApp(App)
for (const [key, comp] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, comp)
}
app.use(createPinia())
app.use(router)
app.use(i18n)
app.use(ElementPlus)
// index.html 里写死 lang="zh-CN"；用户选过英文时这里要改过来（影响字体、断行、朗读）
syncDocumentLang()
app.mount('#app')
