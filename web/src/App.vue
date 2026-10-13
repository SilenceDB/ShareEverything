<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useUserStore } from './stores/user'
import { appBuiltAt, appVersion, loadAppVersion } from './utils/buildInfo'
import { ELEMENT_LOCALES, type AppLocale } from './i18n'
import ChangePasswordDialog from './components/ChangePasswordDialog.vue'
import LocaleSwitcher from './components/LocaleSwitcher.vue'

const route = useRoute()
const router = useRouter()
const store = useUserStore()
const { t, locale } = useI18n()

const pwdVisible = ref(false)

const isBare = computed(() => route.name === 'login' || route.name === 'public-share')

/** Element Plus 自带组件（确认框、分页、日期选择…）的文案跟着一起切 */
const elementLocale = computed(() => ELEMENT_LOCALES[locale.value as AppLocale])

/** 版本号 = 最后一次打包的时刻；开发模式下接口返回 dev */
const versionText = computed(() =>
  !appVersion.value
    ? ''
    : appVersion.value === 'dev'
      ? t('app.devMode')
      : t('app.version', { v: appVersion.value }),
)

onMounted(async () => {
  // 版本信息与登录状态无关，拿到就显示在侧边栏角落
  void loadAppVersion()
  if (store.isLogin && !store.user) {
    try {
      await store.loadMe()
    } catch {
      store.logout()
    }
  }
})

function onCommand(cmd: string) {
  if (cmd === 'logout') {
    store.logout()
    router.push('/login')
  } else if (cmd === 'password') {
    pwdVisible.value = true
  }
}
</script>

<template>
  <el-config-provider :locale="elementLocale">
    <router-view v-if="isBare" />

    <el-container v-else class="layout">
      <el-aside width="210px" class="aside">
        <div class="logo">ShareEverything</div>
        <el-menu :router="true" :default-active="route.path" class="menu">
          <el-menu-item index="/files">
            <el-icon><Folder /></el-icon>
            <span>{{ t('nav.files') }}</span>
          </el-menu-item>
          <el-menu-item index="/mounts">
            <el-icon><FolderOpened /></el-icon>
            <span>{{ t('nav.mounts') }}</span>
          </el-menu-item>
          <el-menu-item index="/shares">
            <el-icon><Share /></el-icon>
            <span>{{ t('nav.shares') }}</span>
          </el-menu-item>
          <el-menu-item v-if="store.isAdmin" index="/users">
            <el-icon><UserFilled /></el-icon>
            <span>{{ t('nav.users') }}</span>
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
      </el-aside>

      <el-container>
        <el-header class="header">
          <span class="title">{{ t('app.title') }}</span>
          <el-dropdown @command="onCommand">
            <span class="user">
              {{ store.user?.username ?? t('app.notLoggedIn') }}
              <el-tag v-if="store.isAdmin" size="small" type="danger" class="role">
                {{ t('common.admin') }}
              </el-tag>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="password">{{ t('account.changePassword') }}</el-dropdown-item>
                <el-dropdown-item command="logout" divided>{{ t('account.logout') }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </el-header>
        <el-main>
          <router-view />
        </el-main>
      </el-container>
    </el-container>

    <!-- 已登录用户改自己的密码（需要原密码），与用户管理页里的「替他人重置」不是一回事 -->
    <ChangePasswordDialog v-model="pwdVisible" />
  </el-config-provider>
</template>

<style>
body {
  margin: 0;
  font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  background: #f5f7fa;
}
.layout {
  height: 100vh;
}
.aside {
  background: #fff;
  border-right: 1px solid #ebeef5;
  display: flex;
  flex-direction: column;
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
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #ebeef5;
}
.title {
  font-size: 15px;
  color: #606266;
}
.user {
  cursor: pointer;
  color: #409eff;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.role {
  transform: scale(0.9);
}
.card {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
}
</style>
