<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Menu as MenuIcon, ArrowDown } from '@element-plus/icons-vue'
import { useUserStore } from './stores/user'
import { ELEMENT_LOCALES, type AppLocale } from './i18n'
import { useIsMobile } from './composables/useIsMobile'
import ChangePasswordDialog from './components/ChangePasswordDialog.vue'
import NavMenu from './components/NavMenu.vue'

const route = useRoute()
const router = useRouter()
const store = useUserStore()
const { t, locale } = useI18n()

const pwdVisible = ref(false)

/** 紧凑布局（≤1023px）：侧栏改成抽屉，由顶部汉堡按钮唤出 */
const isMobile = useIsMobile()
const drawer = ref(false)

const isBare = computed(() => route.name === 'login' || route.name === 'public-share')

/** Element Plus 自带组件（确认框、分页、日期选择…）的文案跟着一起切 */
const elementLocale = computed(() => ELEMENT_LOCALES[locale.value as AppLocale])

/** 桌面端侧栏和手机抽屉共用同一个导航组件，点了就跳转；抽屉顺手关掉 */
function onNav(path: string) {
  drawer.value = false
  if (route.path !== path) void router.push(path)
}

// 路由变了（比如浏览器后退）抽屉不该留在屏幕上
watch(() => route.path, () => {
  drawer.value = false
})

// 从窄屏拉宽到桌面时，抽屉里的内容会跟着 aside 一起出现，这里把它关掉避免残留
watch(isMobile, (v) => {
  if (!v) drawer.value = false
})

onMounted(async () => {
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
      <!-- 桌面端：固定侧栏 -->
      <el-aside v-if="!isMobile" width="210px" class="aside">
        <NavMenu @select="onNav" />
      </el-aside>

      <el-container class="col">
        <el-header class="header">
          <div class="left">
            <el-button
              v-if="isMobile"
              class="hamburger"
              text
              :icon="MenuIcon"
              :aria-label="t('nav.menu')"
              @click="drawer = true"
            />
            <span class="title">{{ t('app.title') }}</span>
          </div>
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

    <!-- 手机端：侧滑抽屉。宽度由 CSS 的 max-width:82vw 兜住，不会占满整屏 -->
    <el-drawer
      v-model="drawer"
      class="nav-drawer"
      direction="ltr"
      size="280px"
      :with-header="false"
    >
      <NavMenu @select="onNav" />
    </el-drawer>

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
/* 手机浏览器的地址栏收起/展开会让 100vh 跳一下，dvh 跟着可视区走 */
.layout {
  height: 100vh;
  height: 100dvh;
}
.aside {
  background: #fff;
  border-right: 1px solid #ebeef5;
  display: flex;
  flex-direction: column;
}
.col {
  min-width: 0;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #ebeef5;
}
.left {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
/* 汉堡按钮的图标偏小，点起来不跟手，单独放大到 22px */
.hamburger {
  padding: 0 8px 0 0;
  font-size: 22px;
  color: #303133;
}
.title {
  font-size: 15px;
  color: #606266;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.user {
  cursor: pointer;
  color: #409eff;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.role {
  transform: scale(0.9);
}
.card {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
}
/* 抽屉内部不用 Element 的默认留白，导航自己带 padding */
.nav-drawer .el-drawer__body {
  padding: 0;
}
@media (max-width: 1023px) {
  .card {
    padding: 12px;
  }
  .title {
    font-size: 14px;
  }
}
</style>
