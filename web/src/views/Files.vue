<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox, type TableInstance } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, type FileItem } from '../api'
import { useUserStore } from '../stores/user'
import ShareDialog from '../components/ShareDialog.vue'
import TransferPanel from '../components/TransferPanel.vue'
import { uploadFile, type TransferControl, type TransferSnapshot } from '../utils/uploader'
import { nativeDownload, startDownload } from '../utils/downloader'
import { formatDateTime, humanSize as human } from '../utils/format'
import {
  getPolicy,
  loadPolicyName,
  POLICIES,
  policyKey,
  savePolicyName,
  type PolicyName,
} from '../utils/uploadPolicy'

const { t } = useI18n()
const store = useUserStore()
const parent = ref('')
const items = ref<FileItem[]>([])
const usage = ref({ usedBytes: '0', quotaBytes: '0' })
const mkdirVisible = ref(false)
const newDirName = ref('')
const shareVisible = ref(false)
const shareTarget = ref<{ targetType: 'FILE' | 'MOUNT'; fileId?: string }>({ targetType: 'FILE' })
const shareTitle = ref('')
const loading = ref(false)

const transfers = ref<TransferSnapshot[]>([])
const controls = new Map<string, TransferControl>()

/** 上传策略：只暴露档位，分片大小与并发数由文件体积自动推导；名字与说明来自语言包 */
const policyName = ref<PolicyName>(loadPolicyName())
const policyOptions = computed(() =>
  Object.values(POLICIES).map((p) => ({ name: p.name, label: t(policyKey(p.name, 'label')) })),
)
const policyDesc = computed(() => t(policyKey(policyName.value, 'desc')))

function changePolicy(name: PolicyName) {
  policyName.value = name
  savePolicyName(name)
  ElMessage.success(t('files.policySwitched', { label: t(policyKey(name, 'label')) }))
}

const crumbs = computed(() => (parent.value ? parent.value.split('/') : []))

function upsertTransfer(s: TransferSnapshot) {
  const i = transfers.value.findIndex((t) => t.key === s.key)
  if (i >= 0) transfers.value[i] = s
  else transfers.value.push(s)
}

/* ---------------- 搜索 ----------------
 * 目录是一次性整列返回的（没有分页），所以在前端过滤就够，
 * 不必为了一次「找文件」再打一个后端请求。
 */
const search = ref('')
const keyword = computed(() => search.value.trim().toLowerCase())

const filteredItems = computed(() => {
  const k = keyword.value
  if (!k) return items.value
  return items.value.filter((it) => it.name.toLowerCase().includes(k))
})

/* ---------------- 多选与批量删除 ---------------- */

const tableRef = ref<TableInstance>()
const selected = ref<FileItem[]>([])

function onSelectionChange(rows: FileItem[]) {
  selected.value = rows
}

/**
 * 清空选中。
 *
 * 列表数据一变（换目录、刷新、搜索过滤）就必须清一次：表格内部会记住被选中的
 * row 对象，而这些对象可能已经不在当前 data 里了 —— 那个状态下点「删除选中」
 * 删掉的是界面上看不见的项，属于最难排查的一类误操作。
 */
function resetSelection() {
  selected.value = []
  tableRef.value?.clearSelection()
}

watch(keyword, () => resetSelection())

async function load() {
  loading.value = true
  try {
    const [list, used] = await Promise.all([api.files.list(parent.value), api.files.usage()])
    items.value = list.items
    usage.value = used
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
    // 数据换了，选中的 row 对象也跟着失效，等表格渲染完再清
    await nextTick()
    resetSelection()
  }
}

function enterDir(row: FileItem) {
  if (row.isDir) {
    parent.value = row.relPath
    load()
  }
}

function goCrumb(index: number) {
  parent.value = crumbs.value.slice(0, index + 1).join('/')
  load()
}

function goRoot() {
  parent.value = ''
  load()
}

function uploadRequest(opt: any) {
  const control = uploadFile(opt.file, parent.value, {
    policy: getPolicy(policyName.value),
    onUpdate: upsertTransfer,
    onDone: async () => {
      ElMessage.success(t('files.uploadDone'))
      await load()
      await store.loadMe()
    },
  })
  controls.set(control.key, control)
}

async function doMkdir() {
  // 先抹掉首尾空格：粘贴出来的名字最容易带上，而服务端是拒绝而不是替你 trim 的
  const name = newDirName.value.trim()
  if (!name) return
  try {
    await api.files.mkdir(parent.value, name)
    mkdirVisible.value = false
    newDirName.value = ''
    ElMessage.success(t('files.mkdirDone'))
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

function download(row: FileItem) {
  const url = api.files.downloadUrl(row.id)
  const control = startDownload(url, row.name, {
    onUpdate: upsertTransfer,
    onDone: () => ElMessage.success(t('common.downloadDone')),
    onFallback: () => nativeDownload(url),
  })
  // 浏览器不支持流式落盘时已经走了原生下载，交给浏览器自己的续传
  if (!control) return
  controls.set(control.key, control)
}

async function remove(row: FileItem) {
  try {
    await ElMessageBox.confirm(t('files.confirmDelete', { name: row.name }), t('common.alertTitle'), {
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }
  try {
    await api.files.remove(row.id)
    ElMessage.success(t('common.deleted'))
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

/** 批量删除：勾选多条后一次删完，目录连同里面的内容一起删 */
async function removeSelected() {
  const rows = selected.value
  if (!rows.length) return

  const dirCount = rows.filter((r) => r.isDir).length
  const message = dirCount
    ? t('files.confirmBatchDeleteDirs', { n: rows.length, d: dirCount })
    : t('files.confirmBatchDelete', { n: rows.length })
  try {
    await ElMessageBox.confirm(message, t('common.alertTitle'), { type: 'warning' })
  } catch {
    return
  }

  try {
    const res = await api.files.batchRemove(rows.map((r) => r.id))
    if (res.failed.length) {
      // 名称太多会把提示条撑爆，只报前三个，后面用省略号带过
      const names =
        res.failed.slice(0, 3).join('、') + (res.failed.length > 3 ? '…' : '')
      ElMessage.warning(t('common.batchDeletePartial', { n: res.removed, names }))
    } else {
      // 这条文案在英文里是复数形式，第二个参数必须直接传数字才会选对分支
      ElMessage.success(t('common.batchDeleted', res.removed))
    }
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

function openShare(row: FileItem) {
  shareTarget.value = { targetType: 'FILE', fileId: row.id }
  shareTitle.value = row.name
  shareVisible.value = true
}

onMounted(load)
</script>

<template>
  <div class="card">
    <TransferPanel
      :tasks="transfers"
      @pause="(k) => controls.get(k)?.pause()"
      @resume="(k) => controls.get(k)?.resume()"
      @cancel="(k) => controls.get(k)?.cancel()"
    />

    <div class="bar">
      <el-tooltip :content="t('files.uploadTip')" placement="bottom">
        <el-upload
          :http-request="uploadRequest"
          :show-file-list="false"
          :multiple="false"
          accept=""
        >
          <el-button type="primary">{{ t('files.upload') }}</el-button>
        </el-upload>
      </el-tooltip>
      <el-button @click="mkdirVisible = true">{{ t('files.newFolder') }}</el-button>
      <el-button @click="load">{{ t('common.refresh') }}</el-button>
      <el-input
        v-model="search"
        class="search"
        :placeholder="t('common.searchPlaceholder')"
        clearable
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-tooltip :content="policyDesc" placement="bottom">
        <el-select v-model="policyName" size="default" class="policy" @change="changePolicy">
          <el-option
            v-for="p in policyOptions"
            :key="p.name"
            :label="t('files.policyPrefix', { label: p.label })"
            :value="p.name"
          />
        </el-select>
      </el-tooltip>
      <span class="space">
        {{ t('files.usage', { used: human(usage.usedBytes), quota: human(usage.quotaBytes) }) }}
      </span>
    </div>

    <div class="crumb-row">
      <el-breadcrumb separator="/" class="crumb">
        <el-breadcrumb-item>
          <a @click="goRoot">{{ t('common.rootDir') }}</a>
        </el-breadcrumb-item>
        <el-breadcrumb-item v-for="(c, i) in crumbs" :key="i">
          <a @click="goCrumb(i)">{{ c }}</a>
        </el-breadcrumb-item>
      </el-breadcrumb>
      <span v-if="keyword" class="match-tip">
        {{ t('common.searchMatches', { n: filteredItems.length, total: items.length }) }}
      </span>
    </div>

    <div v-if="selected.length" class="bulk-bar">
      <span class="bulk-count">{{ t('common.selectedCount', { n: selected.length }) }}</span>
      <el-button size="small" type="danger" @click="removeSelected">
        {{ t('common.batchDelete') }}
      </el-button>
      <el-button size="small" @click="resetSelection">
        {{ t('common.clearSelection') }}
      </el-button>
    </div>

    <el-table
      ref="tableRef"
      v-loading="loading"
      :data="filteredItems"
      style="width: 100%"
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="46" />
      <el-table-column :label="t('common.name')" min-width="220">
        <template #default="{ row }">
          <el-link v-if="row.isDir" type="primary" @click="enterDir(row)">{{ row.name }}</el-link>
          <span v-else>{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('common.size')" width="110">
        <template #default="{ row }">{{ row.isDir ? '-' : human(row.size) }}</template>
      </el-table-column>
      <el-table-column :label="t('files.uploadedAt')" width="180">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="260">
        <template #default="{ row }">
          <el-button v-if="!row.isDir" size="small" @click="openShare(row)">
            {{ t('common.share') }}
          </el-button>
          <el-button v-if="!row.isDir" size="small" type="success" @click="download(row)">
            {{ t('common.download') }}
          </el-button>
          <el-button size="small" type="danger" @click="remove(row)">{{ t('common.delete') }}</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <!-- 搜索时不能沿用「这里还没有文件」，否则会让人以为目录被清空了 -->
        <el-empty
          :description="
            keyword ? t('common.searchEmpty', { q: search.trim() }) : t('files.empty')
          "
        />
      </template>
    </el-table>
  </div>

  <el-dialog v-model="mkdirVisible" :title="t('files.newFolder')" width="360px">
    <el-input v-model="newDirName" :placeholder="t('files.folderNamePlaceholder')" />
    <template #footer>
      <el-button @click="mkdirVisible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" @click="doMkdir">{{ t('common.confirm') }}</el-button>
    </template>
  </el-dialog>

  <ShareDialog
    v-model="shareVisible"
    :target="shareTarget"
    :default-title="shareTitle"
    @created="load"
  />
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  /* 窄屏下搜索框会把整行挤出去，宁可折行也不出现横向滚动 */
  flex-wrap: wrap;
}
.search {
  width: 200px;
}
.policy {
  /* 宽度按较长的英文标签（"Upload mode: Balanced"）留够，中文下多出的空白无妨 */
  width: 210px;
}
.space {
  margin-left: auto;
  font-size: 13px;
  color: #909399;
}
.crumb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.crumb {
  margin-bottom: 0;
}
.crumb a {
  cursor: pointer;
}
.match-tip {
  margin-left: auto;
  font-size: 12px;
  color: #909399;
}
/* 多选后出现的操作条：贴着表格，避免和顶部工具栏抢注意力 */
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  padding: 6px 10px;
  border: 1px solid var(--el-color-danger-light-7);
  border-radius: 4px;
  background: var(--el-color-danger-light-9);
}
.bulk-count {
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>
