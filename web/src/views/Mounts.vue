<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  api,
  type DiskEntry,
  type GrantableUser,
  type MountItem,
  type MountKind,
  type MountVisibility,
} from '../api'
import { useUserStore } from '../stores/user'
import { humanSize } from '../utils/format'
import ShareDialog from '../components/ShareDialog.vue'
import DiskPicker from '../components/DiskPicker.vue'

const { t } = useI18n()
const store = useUserStore()

/** 资源库根节点在树里的占位 id；parentId 为空表示挂在根下 */
const ROOT_ID = '__root__'

const all = ref<MountItem[]>([])
const selectedId = ref<string>(ROOT_ID)
const loading = ref(false)

/* ---------------- 树与列表 ---------------- */

interface TreeNode {
  id: string
  label: string
  children: TreeNode[]
}

const byId = computed(() => new Map(all.value.map((m) => [m.id, m])))

const currentParentId = computed(() => (selectedId.value === ROOT_ID ? null : selectedId.value))

function folderChildren(parentId: string | null): TreeNode[] {
  return all.value
    .filter((m) => m.kind === 'FOLDER' && (m.parentId ?? null) === parentId)
    .map((m) => ({ id: m.id, label: m.name, children: folderChildren(m.id) }))
}

const treeData = computed<TreeNode[]>(() => [
  { id: ROOT_ID, label: t('mounts.root'), children: folderChildren(null) },
])

/** 当前文件夹下的内容：文件夹排在前面，其余按名称排 */
const rows = computed(() => {
  const list = all.value.filter((m) => (m.parentId ?? null) === currentParentId.value)
  const rank = (m: MountItem) => (m.kind === 'FOLDER' ? 0 : 1)
  return list
    .slice()
    .sort((a, b) => (rank(a) === rank(b) ? a.name.localeCompare(b.name) : rank(a) - rank(b)))
})

/** 面包屑：从根走到当前文件夹 */
const breadcrumb = computed(() => {
  const parts: { id: string; name: string }[] = [{ id: ROOT_ID, name: t('mounts.root') }]
  const chain: { id: string; name: string }[] = []
  let cur = currentParentId.value
  let guard = 0
  while (cur && guard++ < 100) {
    const node = byId.value.get(cur)
    if (!node) break
    chain.unshift({ id: node.id, name: node.name })
    cur = node.parentId
  }
  return [...parts, ...chain]
})

/** 全部文件夹的「全路径」选项，用于「发布到 / 移动到」 */
const folderOptions = computed(() => {
  const pathOf = (id: string): string => {
    const chain: string[] = []
    let cur: string | null = id
    let guard = 0
    while (cur && guard++ < 100) {
      const node = byId.value.get(cur)
      if (!node) break
      chain.unshift(node.name)
      cur = node.parentId
    }
    return [t('mounts.root'), ...chain].join(' / ')
  }
  return [
    { id: ROOT_ID, label: t('mounts.root') },
    ...all.value.filter((m) => m.kind === 'FOLDER').map((m) => ({ id: m.id, label: pathOf(m.id) })),
  ]
})

function descendantIds(id: string): string[] {
  const out: string[] = []
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const m of all.value) {
      if (m.parentId === cur) {
        out.push(m.id)
        stack.push(m.id)
      }
    }
  }
  return out
}

const kindLabel = computed<Record<MountKind, string>>(() => ({
  FOLDER: t('mounts.kind.folder'),
  DIR: t('mounts.kind.dir'),
  FILE: t('mounts.kind.file'),
}))
const KIND_TAG: Record<MountKind, 'info' | 'warning' | 'success'> = {
  FOLDER: 'info',
  DIR: 'warning',
  FILE: 'success',
}

/* ---------------- 可见范围 ---------------- */

const VIS_OPTIONS: MountVisibility[] = ['PUBLIC', 'PRIVATE', 'PROTECTED']
const VIS_TAG: Record<MountVisibility, 'success' | 'info' | 'warning'> = {
  PUBLIC: 'success',
  PRIVATE: 'info',
  PROTECTED: 'warning',
}
const visibilityLabel = computed<Record<MountVisibility, string>>(() => ({
  PUBLIC: t('mounts.visibilityPublic'),
  PRIVATE: t('mounts.visibilityPrivate'),
  PROTECTED: t('mounts.visibilityProtected'),
}))

/** 授权候选名单，只在真正要用（新建 / 改可见范围）时才拉一次 */
const users = ref<GrantableUser[]>([])
async function loadUsers() {
  if (users.value.length) return
  try {
    users.value = await api.mounts.grantableUsers()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

async function load() {
  loading.value = true
  try {
    all.value = await api.mounts.list()
    // 选中的文件夹可能刚被删掉，回退到根
    if (selectedId.value !== ROOT_ID && !byId.value.has(selectedId.value)) {
      selectedId.value = ROOT_ID
    }
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function selectNode(node: TreeNode) {
  selectedId.value = node.id
}

/** 表格里点「打开」：文件夹进入下一层，目录/文件直接浏览 */
function openRow(row: MountItem) {
  if (row.kind === 'FOLDER') {
    selectedId.value = row.id
    return
  }
  if (row.kind === 'DIR') {
    void browse(row)
    return
  }
  download(row)
}

/* ---------------- 新建 ---------------- */

const createVisible = ref(false)
const createForm = ref<{
  kind: MountKind
  name: string
  absPath: string
  parentId: string
  visibility: MountVisibility
  grants: string[]
}>({
  kind: 'FOLDER',
  name: '',
  absPath: '',
  parentId: ROOT_ID,
  visibility: 'PUBLIC',
  grants: [],
})
const pickerVisible = ref(false)

function openCreate(kind: MountKind) {
  createForm.value = {
    kind,
    name: '',
    absPath: '',
    parentId: selectedId.value,
    visibility: 'PUBLIC',
    grants: [],
  }
  createVisible.value = true
  void loadUsers()
}

function onPicked(path: string) {
  createForm.value.absPath = path
  // 名字留空时用路径末段自动填一个，省一次输入
  if (!createForm.value.name.trim()) {
    const seg = path.split(/[\\/]/).filter(Boolean).pop() ?? ''
    createForm.value.name = seg
  }
}

async function submitCreate() {
  const f = createForm.value
  if (!f.name.trim()) {
    ElMessage.warning(t('mounts.nameRequired'))
    return
  }
  if (f.kind !== 'FOLDER' && !f.absPath) {
    ElMessage.warning(f.kind === 'DIR' ? t('mounts.selectDir') : t('mounts.selectFile'))
    return
  }
  try {
    await api.mounts.create({
      name: f.name.trim(),
      kind: f.kind,
      parentId: f.parentId === ROOT_ID ? null : f.parentId,
      absPath: f.kind === 'FOLDER' ? undefined : f.absPath,
      visibility: f.visibility,
      grants: f.visibility === 'PROTECTED' ? f.grants : [],
    })
    createVisible.value = false
    ElMessage.success(t('mounts.added'))
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

/* ---------------- 重命名 / 移动 / 删除 ---------------- */

async function rename(row: MountItem) {
  try {
    const { value } = await ElMessageBox.prompt(t('mounts.renamePrompt'), t('mounts.rename'), {
      inputValue: row.name,
      inputValidator: (v: string) => (v && v.trim() ? true : t('mounts.nameEmpty')),
    })
    await api.mounts.update(row.id, { name: value.trim() })
    ElMessage.success(t('mounts.renamed'))
    await load()
  } catch (e: any) {
    if (e === 'cancel' || e === 'close') return
    ElMessage.error(e.message)
  }
}

const moveVisible = ref(false)
const moveTarget = ref<MountItem | null>(null)
const moveParentId = ref(ROOT_ID)

function openMove(row: MountItem) {
  moveTarget.value = row
  moveParentId.value = row.parentId ?? ROOT_ID
  moveVisible.value = true
}

async function submitMove() {
  const row = moveTarget.value
  if (!row) return
  const exclude = new Set([row.id, ...descendantIds(row.id)])
  if (moveParentId.value !== ROOT_ID && exclude.has(moveParentId.value)) {
    ElMessage.warning(t('mounts.moveLoop'))
    return
  }
  try {
    await api.mounts.update(row.id, {
      parentId: moveParentId.value === ROOT_ID ? null : moveParentId.value,
    })
    moveVisible.value = false
    ElMessage.success(t('mounts.moved'))
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

async function remove(row: MountItem) {
  // 删文件夹会连带移除它的全部子项，句子太长了，分成「带子项」和「不带」两条文案
  const nested = row.kind === 'FOLDER' ? descendantIds(row.id).length : 0
  const message = nested
    ? t('mounts.confirmUnpublishNested', { name: row.name, n: nested })
    : t('mounts.confirmUnpublish', { name: row.name })
  try {
    await ElMessageBox.confirm(message, t('common.alertTitle'), { type: 'warning' })
  } catch {
    return
  }
  try {
    const res = await api.mounts.remove(row.id)
    ElMessage.success(res.removed > 1 ? t('mounts.removed', res.removed) : t('mounts.unpublished'))
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

/* ---------------- 调整可见范围 ---------------- */

const visVisible = ref(false)
const visTarget = ref<MountItem | null>(null)
const visValue = ref<MountVisibility>('PUBLIC')
const visGrants = ref<string[]>([])

function openVisibility(row: MountItem) {
  visTarget.value = row
  visValue.value = row.visibility
  // 只有 canManage 时后端才给名单；其余情况这里就是空数组，本来也不该改
  visGrants.value = [...row.grants]
  visVisible.value = true
  void loadUsers()
}

async function submitVisibility() {
  const row = visTarget.value
  if (!row) return
  try {
    await api.mounts.update(row.id, {
      visibility: visValue.value,
      grants: visValue.value === 'PROTECTED' ? visGrants.value : [],
    })
    visVisible.value = false
    ElMessage.success(t('mounts.visibilitySaved'))
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

/* ---------------- 浏览真实目录 ---------------- */

const browseVisible = ref(false)
const current = ref<MountItem | null>(null)
const sub = ref('')
const entries = ref<DiskEntry[]>([])

async function browse(m: MountItem, next = '') {
  current.value = m
  sub.value = next
  try {
    const res = await api.mounts.browse(m.id, next)
    entries.value = res.items
    browseVisible.value = true
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

/** 浏览弹窗里的面包屑：绝对路径 + 相对子路径 */
const browseCrumbs = computed(() => {
  const base = current.value?.absPath ?? ''
  const crumbs = [{ label: base, sub: '' }]
  if (!sub.value) return crumbs
  const segs = sub.value.split('/').filter(Boolean)
  segs.forEach((seg, i) => {
    crumbs.push({ label: seg, sub: segs.slice(0, i + 1).join('/') })
  })
  return crumbs
})

function goSub(next: string) {
  if (current.value) void browse(current.value, next)
}

function download(row: MountItem | DiskEntry) {
  const id = 'id' in row ? row.id : current.value?.id
  if (!id) return
  const rel = 'sub' in row ? row.sub : ''
  window.location.href = api.mounts.downloadUrl(id, rel)
}

/* ---------------- 分享 ---------------- */

const shareVisible = ref(false)
const shareTarget = ref<{ targetType: 'MOUNT'; mountId?: string; subPath?: string }>({
  targetType: 'MOUNT',
})
const shareTitle = ref('')

function openShare(row: MountItem | DiskEntry) {
  const mountId = 'id' in row ? row.id : current.value?.id
  if (!mountId) return
  const rel = 'sub' in row ? row.sub : ''
  shareTarget.value = { targetType: 'MOUNT', mountId, subPath: rel }
  shareTitle.value = row.name
  shareVisible.value = true
}

onMounted(async () => {
  await store.loadMe()
  await load()
})
</script>

<template>
  <div class="card mount-page" v-loading="loading">
    <div class="bar">
      <el-tooltip
        :disabled="store.canCreateMount"
        :content="t('mounts.createRoleTip')"
        placement="bottom"
      >
        <span>
          <el-button :disabled="!store.canCreateMount" @click="openCreate('FOLDER')">
            {{ t('mounts.newFolder') }}
          </el-button>
          <el-button type="primary" :disabled="!store.canCreateMount" @click="openCreate('DIR')">
            {{ t('mounts.publishDir') }}
          </el-button>
          <el-button type="primary" :disabled="!store.canCreateMount" @click="openCreate('FILE')">
            {{ t('mounts.publishFile') }}
          </el-button>
        </span>
      </el-tooltip>
      <el-button @click="load">{{ t('common.refresh') }}</el-button>
      <span class="tip">{{ t('mounts.publishTip') }}</span>
    </div>

    <div class="body">
      <el-aside class="side" width="240px">
        <el-tree
          :data="treeData"
          node-key="id"
          :props="{ label: 'label', children: 'children' }"
          :current-node-key="selectedId"
          highlight-current
          :expand-on-click-node="false"
          default-expand-all
          @node-click="selectNode"
        />
      </el-aside>

      <div class="main">
        <el-breadcrumb separator="/" class="crumbs">
          <el-breadcrumb-item v-for="(c, i) in breadcrumb" :key="c.id">
            <el-link v-if="i < breadcrumb.length - 1" type="primary" @click="selectedId = c.id">
              {{ c.name }}
            </el-link>
            <span v-else>{{ c.name }}</span>
          </el-breadcrumb-item>
        </el-breadcrumb>

        <el-table :data="rows" style="width: 100%">
          <el-table-column :label="t('common.name')" min-width="220">
            <template #default="{ row }">
              <el-icon class="row-icon" :class="row.kind.toLowerCase()">
                <FolderOpened v-if="row.kind === 'FOLDER'" />
                <Folder v-else-if="row.kind === 'DIR'" />
                <Document v-else />
              </el-icon>
              <el-link v-if="row.kind !== 'FILE'" type="primary" @click="openRow(row)">
                {{ row.name }}
              </el-link>
              <span v-else>{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('mounts.type')" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="KIND_TAG[row.kind as MountKind]">
                {{ kindLabel[row.kind as MountKind] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('mounts.serverPath')" min-width="240">
            <template #default="{ row }">
              <span v-if="row.absPath" class="mono">{{ row.absPath }}</span>
              <span v-else class="muted">{{ t('mounts.noDiskPath') }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('mounts.publisher')" width="100">
            <template #default="{ row }">
              <el-tag v-if="row.ownerName" size="small" type="info">{{ row.ownerName }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('mounts.visibility')" width="150">
            <template #default="{ row }">
              <el-tag size="small" :type="VIS_TAG[row.visibility as MountVisibility]">
                {{ visibilityLabel[row.visibility as MountVisibility] }}
              </el-tag>
              <el-tag v-if="row.granted" size="small" type="warning">
                {{ t('mounts.sharedWithMe') }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('common.actions')" width="320">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="openRow(row)">
                {{
                  row.kind === 'FOLDER'
                    ? t('mounts.open')
                    : row.kind === 'DIR'
                      ? t('mounts.browse')
                      : t('common.download')
                }}
              </el-button>
              <el-button v-if="row.kind !== 'FOLDER'" size="small" @click="download(row)">
                {{ t('common.download') }}
              </el-button>
              <el-button v-if="row.kind !== 'FOLDER'" size="small" @click="openShare(row)">
                {{ t('common.share') }}
              </el-button>
              <el-dropdown v-if="row.canManage" trigger="click">
                <el-button size="small">
                  {{ t('common.more') }}<el-icon><ArrowDown /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="rename(row)">{{ t('mounts.rename') }}</el-dropdown-item>
                    <el-dropdown-item @click="openMove(row)">{{ t('mounts.moveTo') }}</el-dropdown-item>
                    <el-dropdown-item @click="openVisibility(row)">
                      {{ t('mounts.changeVisibility') }}
                    </el-dropdown-item>
                    <el-dropdown-item divided @click="remove(row)">
                      {{ t('mounts.unpublish') }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :description="t('mounts.empty')" />
          </template>
        </el-table>
      </div>
    </div>
  </div>

  <!-- 新建：文件夹只要名字，目录/文件用选择器挑路径 -->
  <el-dialog
    v-model="createVisible"
    :title="
      createForm.kind === 'FOLDER'
        ? t('mounts.newFolder')
        : createForm.kind === 'DIR'
          ? t('mounts.publishDirTitle')
          : t('mounts.publishFileTitle')
    "
    width="520px"
  >
    <el-form label-position="top">
      <el-form-item :label="t('mounts.nameLabel')">
        <el-input
          v-model="createForm.name"
          :placeholder="
            createForm.kind === 'FOLDER'
              ? t('mounts.namePlaceholderFolder')
              : t('mounts.namePlaceholderAuto')
          "
        />
      </el-form-item>
      <el-form-item v-if="createForm.kind !== 'FOLDER'" :label="t('mounts.absPathLabel')">
        <div class="path-row">
          <el-input
            v-model="createForm.absPath"
            readonly
            :placeholder="t('mounts.absPathPlaceholder')"
          />
          <el-button @click="pickerVisible = true">{{ t('common.choose') }}</el-button>
        </div>
      </el-form-item>
      <el-form-item :label="t('mounts.parentLabel')">
        <el-select v-model="createForm.parentId" style="width: 100%">
          <el-option v-for="o in folderOptions" :key="o.id" :label="o.label" :value="o.id" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('mounts.visibilityLabel')">
        <el-select v-model="createForm.visibility" style="width: 100%">
          <el-option
            v-for="v in VIS_OPTIONS"
            :key="v"
            :label="visibilityLabel[v]"
            :value="v"
          />
        </el-select>
        <div class="field-hint">{{ t('mounts.visibilityHint') }}</div>
      </el-form-item>
      <el-form-item v-if="createForm.visibility === 'PROTECTED'" :label="t('mounts.grantLabel')">
        <el-select
          v-model="createForm.grants"
          multiple
          filterable
          style="width: 100%"
          :placeholder="t('mounts.grantPlaceholder')"
        >
          <el-option v-for="u in users" :key="u.id" :label="u.username" :value="u.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="createVisible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" @click="submitCreate">{{ t('common.confirm') }}</el-button>
    </template>
  </el-dialog>

  <!-- 浏览真实目录：带可点击面包屑 + 返回上一级 -->
  <el-dialog
    v-model="browseVisible"
    :title="current ? t('mounts.browseTitle', { name: current.name }) : ''"
    width="860px"
  >
    <div class="browse-nav">
      <el-button size="small" :disabled="!sub" @click="goSub('')">
        <el-icon><ArrowUp /></el-icon>
        <span>{{ t('common.parent') }}</span>
      </el-button>
      <el-breadcrumb separator="/" class="crumbs">
        <el-breadcrumb-item v-for="(c, i) in browseCrumbs" :key="c.sub">
          <el-link v-if="i < browseCrumbs.length - 1" type="primary" @click="goSub(c.sub)">
            {{ c.label }}
          </el-link>
          <span v-else>{{ c.label }}</span>
        </el-breadcrumb-item>
      </el-breadcrumb>
    </div>
    <el-table :data="entries" max-height="440">
      <el-table-column :label="t('common.name')" min-width="240">
        <template #default="{ row }">
          <el-link v-if="row.isDir" type="primary" @click="goSub(row.sub)">{{ row.name }}</el-link>
          <span v-else>{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('common.size')" width="120">
        <template #default="{ row }">{{ row.isDir ? '-' : humanSize(row.size) }}</template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="240">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="openShare(row)">
            {{ row.isDir ? t('mounts.shareDir') : t('common.share') }}
          </el-button>
          <el-button v-if="!row.isDir" size="small" type="success" @click="download(row)">
            {{ t('common.download') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-dialog>

  <!-- 移动到另一个逻辑文件夹 -->
  <el-dialog v-model="moveVisible" :title="t('mounts.moveToTitle')" width="460px">
    <p class="move-hint">{{ t('mounts.moveHint', { name: moveTarget?.name ?? '' }) }}</p>
    <el-select v-model="moveParentId" style="width: 100%">
      <el-option
        v-for="o in folderOptions.filter(
          (x) => !moveTarget || (!descendantIds(moveTarget.id).includes(x.id) && x.id !== moveTarget.id),
        )"
        :key="o.id"
        :label="o.label"
        :value="o.id"
      />
    </el-select>
    <template #footer>
      <el-button @click="moveVisible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" @click="submitMove">{{ t('common.confirm') }}</el-button>
    </template>
  </el-dialog>

  <!-- 调整可见范围：所有人 / 仅自己 / 指定用户 -->
  <el-dialog v-model="visVisible" :title="t('mounts.visibilityDialogTitle')" width="480px">
    <p class="move-hint">{{ t('mounts.visibilityFor', { name: visTarget?.name ?? '' }) }}</p>
    <el-form label-position="top">
      <el-form-item :label="t('mounts.visibilityLabel')">
        <el-select v-model="visValue" style="width: 100%">
          <el-option v-for="v in VIS_OPTIONS" :key="v" :label="visibilityLabel[v]" :value="v" />
        </el-select>
        <div class="field-hint">{{ t('mounts.visibilityHint') }}</div>
      </el-form-item>
      <el-form-item v-if="visValue === 'PROTECTED'" :label="t('mounts.grantLabel')">
        <el-select
          v-model="visGrants"
          multiple
          filterable
          style="width: 100%"
          :placeholder="t('mounts.grantPlaceholder')"
        >
          <el-option v-for="u in users" :key="u.id" :label="u.username" :value="u.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visVisible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" @click="submitVisibility">{{ t('common.confirm') }}</el-button>
    </template>
  </el-dialog>

  <DiskPicker
    v-model="pickerVisible"
    :mode="createForm.kind === 'FILE' ? 'file' : 'dir'"
    @pick="onPicked"
  />

  <ShareDialog
    v-model="shareVisible"
    :target="shareTarget"
    :default-title="shareTitle"
    @created="browseVisible = false"
  />
</template>

<style scoped>
.mount-page {
  display: flex;
  flex-direction: column;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.tip {
  margin-left: auto;
  font-size: 12px;
  color: #909399;
}
.body {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.side {
  flex: none;
  border-right: 1px solid #ebeef5;
  padding-right: 8px;
  max-height: 560px;
  overflow: auto;
}
.main {
  flex: 1;
  min-width: 0;
}
.crumbs {
  margin-bottom: 10px;
  font-size: 13px;
}
.browse-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.browse-nav .crumbs {
  margin-bottom: 0;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.row-icon {
  vertical-align: -2px;
  margin-right: 6px;
  color: #909399;
}
.row-icon.folder {
  color: #409eff;
}
.row-icon.dir {
  color: #e6a23c;
}
.path-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  color: #606266;
  word-break: break-all;
}
.muted {
  font-size: 12px;
  color: #c0c4cc;
}
.move-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: #606266;
}
.field-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: #909399;
}
</style>
