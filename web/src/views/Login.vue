<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useUserStore } from '../stores/user'
import { appVersion } from '../utils/buildInfo'
import LocaleSwitcher from '../components/LocaleSwitcher.vue'

const route = useRoute()
const router = useRouter()
const store = useUserStore()
const { t } = useI18n()

const mode = ref<'login' | 'register'>('login')
const loading = ref(false)
const form = reactive({ account: '', email: '', username: '', password: '' })

/**
 * 注册入口是否出现，由后端按「系统里有没有管理员」决定，前端不再有开关。
 *
 * 默认按可注册处理（fail-open）：万一这个公开接口没请求到，至少别把全新部署的
 * 第一次注册也堵死。真已经有管理员时，提交注册会被后端 403 挡下，不会建出账号。
 */
const canRegister = ref(true)
const adminResetEnabled = ref(false)
/** 密码找回是否只允许在服务器本机使用（后端恒定开启这道限制） */
const adminResetLocalOnly = ref(true)
/** 当前这次访问是不是从服务器本机发起的 */
const fromLocalhost = ref(true)

onMounted(async () => {
  try {
    const cfg = await api.auth.publicConfig()
    canRegister.value = cfg.canRegister
    adminResetEnabled.value = cfg.adminResetEnabled
    adminResetLocalOnly.value = cfg.adminResetLocalOnly
    fromLocalhost.value = cfg.fromLocalhost
    // 注册入口已经不该出现，就别让表单停在注册模式
    if (!cfg.canRegister) mode.value = 'login'
  } catch {
    // 拿不到配置就维持默认，不打扰用户
  }
})

/**
 * 密码找回提示。三种状态：
 * ① 开关关着 → 不提示
 * ② 开关开着、且确实在本机 → 橙色提示，说明本次密码会被设为新密码
 * ③ 开关开着、但当前不是本机 → 明确告知这里用不了，别白填
 */
const resetHint = computed(() => {
  if (!adminResetEnabled.value) return null
  if (adminResetLocalOnly.value && !fromLocalhost.value) {
    return {
      type: 'error' as const,
      title: t('login.hintResetOffsite.title'),
      description: t('login.hintResetOffsite.desc'),
    }
  }
  const key = adminResetLocalOnly.value ? 'login.hintResetOn' : 'login.hintResetOnRemote'
  return {
    type: 'warning' as const,
    title: t(`${key}.title`),
    description: t(`${key}.desc`),
  }
})

const submitText = computed(() => (mode.value === 'login' ? t('login.submit') : t('login.submitRegister')))

async function submit() {
  loading.value = true
  try {
    if (mode.value === 'login') {
      const res = await api.auth.login({ account: form.account, password: form.password })
      store.setToken(res.token)
      await store.loadMe()
      ElMessage.success(res.resetPassword ? t('login.resetAndLogin') : t('login.ok'))
    } else {
      const res = await api.auth.register({
        email: form.email,
        username: form.username,
        password: form.password,
      })
      store.setToken(res.token)
      await store.loadMe()
      ElMessage.success(t('login.registered'))
    }
    const redirect = (route.query.redirect as string) || '/files'
    router.push(redirect)
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="lang-bar">
      <LocaleSwitcher />
    </div>

    <div class="box">
      <h2>ShareEverything</h2>

      <el-tabs v-model="mode">
        <el-tab-pane :label="t('login.tabLogin')" name="login" />
        <el-tab-pane v-if="canRegister" :label="t('login.tabRegister')" name="register" />
      </el-tabs>

      <el-alert
        v-if="resetHint"
        class="hint"
        :type="resetHint.type"
        :closable="false"
        show-icon
        :title="resetHint.title"
        :description="resetHint.description"
      />

      <el-form label-position="top" @submit.prevent="submit">
        <template v-if="mode === 'login'">
          <el-form-item :label="t('login.account')">
            <el-input v-model="form.account" :placeholder="t('login.accountPlaceholder')" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item :label="t('common.email')">
            <el-input v-model="form.email" placeholder="you@example.com" />
          </el-form-item>
          <el-form-item :label="t('common.username')">
            <el-input v-model="form.username" :placeholder="t('login.usernamePlaceholder')" />
          </el-form-item>
        </template>
        <el-form-item :label="t('common.password')">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            :placeholder="t('common.passwordMinHint')"
          />
        </el-form-item>
        <el-button type="primary" class="submit" :loading="loading" @click="submit">
          {{ submitText }}
        </el-button>
      </el-form>

      <p v-if="canRegister" class="tip">{{ t('login.registerTip') }}</p>
      <p v-else class="tip">{{ t('login.closedTip') }}</p>
      <p v-if="appVersion" class="build">
        {{ appVersion === 'dev' ? t('app.devMode') : t('app.version', { v: appVersion }) }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.lang-bar {
  position: absolute;
  top: 18px;
  right: 24px;
}
.box {
  width: 380px;
  background: #fff;
  padding: 28px;
  border-radius: 10px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}
h2 {
  margin: 0 0 12px;
  font-size: 20px;
  text-align: center;
}
.hint {
  margin-bottom: 16px;
}
.submit {
  width: 100%;
}
.tip {
  margin-top: 14px;
  font-size: 12px;
  color: #909399;
  text-align: center;
}
.build {
  margin: 6px 0 0;
  font-size: 12px;
  color: #c0c4cc;
  text-align: center;
  user-select: text;
}
</style>
