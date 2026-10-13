<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { setLocale, SUPPORTED_LOCALES, type AppLocale } from '../i18n'

const { t, locale } = useI18n()

/** 按钮上显示的语言名**不随界面语言翻译**（中文界面下也要认出 "English"），见 i18n/index.ts */
const currentLabel = computed(
  () => SUPPORTED_LOCALES.find((l) => l.value === locale.value)?.label ?? SUPPORTED_LOCALES[0].label,
)

function onSelect(value: string) {
  setLocale(value as AppLocale)
}
</script>

<template>
  <el-dropdown trigger="click" @command="onSelect">
    <span class="locale-switch" :title="t('app.language')">
      <slot name="prefix" />
      {{ currentLabel }}
      <el-icon><ArrowDown /></el-icon>
    </span>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="l in SUPPORTED_LOCALES"
          :key="l.value"
          :command="l.value"
          :disabled="l.value === locale"
        >
          {{ l.label }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.locale-switch {
  cursor: pointer;
  color: #606266;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  outline: none;
}
.locale-switch:hover {
  color: #409eff;
}
</style>
