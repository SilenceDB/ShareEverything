<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Folder, FolderOpened, Share, UserFilled } from '@element-plus/icons-vue'
import { useUserStore } from '../stores/user'
import { appBuiltAt, appVersion, loadAppVersion } from '../utils/buildInfo'
import LocaleSwitcher from './LocaleSwitcher.vue'

/**
 * 侧栏导航。桌面端直接放在 el-aside 里，手机端放进 el-drawer ——
 * 两处共用同一个组件，避免「桌面菜单改了、抽屉里还是旧的」。
 *
 * 导航用 emit 交给父级执行：抽屉需要在点完菜单后自己关掉，
 * 而 el-menu 的 :router 模式没法插这个动作。
 */
const emit = defineEmits<{ select: [path: string] }>()

const route = useRoute()
const store = useUserStore()
const { t } = useI18n()

const items = computed(() => {
  const list = [
    { path: '/files', label: t('nav.files'), icon: Folder },
    { path: '/mounts', label: t('nav.mounts'), icon: FolderOpened },
    { path: '/shares', label: t('nav.shares'), icon: Share },
  ]
  if (store.isAdmin) list.push({ path: '/users', label: t('nav.users'), icon: UserFilled })
  return list
})

/** 版本号 = 最后一次打包的时刻；开发模式下接口返回 dev */
const versionText = computed(() =>
  !appVersion.value
    ? ''
    : appVersion.value === 'dev'
      ? t('app.devMode')
      : t('app.version', { v: appVersion.value }),
)

onMounted(() => {
  // 内部有 pending 去重，桌面+抽屉各挂一次也只会请求一次
  void loadAppVersion()
})
</script>

<template>
  <div class="nav">
    <div class="logo">ShareEverything</div>
    <el-menu :default-active="route.path" class="menu" @select="(i: string) => emit('select', i)">
      <el-menu-item v-for="it in items" :key="it.path" :index="it.path">
        <el-icon><component :is="it.icon" /></el-icon>
        <span>{{ it.label }}</span>
      </el-menu-item>
    </el-menu>
    <div class="foot">
      <LocaleSwitcher class="lang" />
      <div
        v-if="versionText"
        class="build"
        :title="appBuiltAt ? t('app.builtAt', { at: appBuiltAt }) : t('app.srcMode')"
      >
        {{ versionText }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.nav {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;
}
.logo {
  padding: 20px;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  border-bottom: 1px solid #ebeef5;
}
.menu {
  border-right: none;
  flex: 1;
  overflow-y: auto;
}
.foot {
  border-top: 1px solid #ebeef5;
  padding: 10px 20px;
}
.lang {
  display: block;
  margin-bottom: 6px;
}
.build {
  font-size: 12px;
  color: #c0c4cc;
  user-select: text;
}
/* 手机抽屉里没有外层的 border-right，内部也不用留白，靠抽屉自己的 padding */
@media (max-width: 1023px) {
  .logo {
    padding: 16px;
    font-size: 15px;
  }
  .foot {
    padding: 10px 16px;
  }
}
</style>
