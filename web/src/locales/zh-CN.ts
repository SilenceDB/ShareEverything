/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

/**
 * 简体中文文案（默认语言，也是这份词典的「基准」）。
 *
 * 约定：
 *   · 键按界面区域分组（app / nav / common / 各页面）；
 *   · 插值统一用 `{名字}`；数量相关的句子在中文里只有一种形态，英文那份才做单复数；
 *   · 所有词条必须都出现在这里 —— en-US 里少一条会回退成中文，但这里少一条就是缺键。
 *
 * 新增词条后请跑 `node scripts/check-i18n.mjs` 核对两边是否对齐。
 */
export default {
  /* ---------------- 全局骨架 ---------------- */
  app: {
    title: '资源分享平台',
    devMode: '开发模式',
    version: '版本 {v}',
    builtAt: '打包于 {at}',
    srcMode: '源码开发模式，非发布包',
    notLoggedIn: '未登录',
    language: '语言',
  },
  nav: {
    files: '文件库',
    mounts: '磁盘发布',
    shares: '我的分享',
    users: '用户管理',
  },
  account: {
    changePassword: '修改密码',
    logout: '退出登录',
  },

  /* ---------------- 通用词 ---------------- */
  common: {
    admin: '管理员',
    user: '普通用户',
    name: '名称',
    size: '大小',
    actions: '操作',
    refresh: '刷新',
    cancel: '取消',
    confirm: '确定',
    create: '创建',
    delete: '删除',
    deleted: '已删除',
    download: '下载',
    share: '分享',
    more: '更多',
    up: '上一级',
    parent: '返回上级',
    rootDir: '根目录',
    choose: '选择…',
    noCode: '无',
    dir: '目录',
    email: '邮箱',
    username: '用户名',
    password: '密码',
    passwordMinHint: '至少 6 位',
    alertTitle: '提示',
    downloadDone: '下载完成',
    downloadFailed: '下载失败',
    requestFailed: '请求失败',
  },

  /* ---------------- 登录 / 注册 ---------------- */
  login: {
    tabLogin: '登录',
    tabRegister: '注册',
    submit: '登录',
    submitRegister: '注册并登录',
    account: '用户名或邮箱',
    accountPlaceholder: '请输入用户名或邮箱',
    usernamePlaceholder: '英文字母数字',
    ok: '登录成功',
    resetAndLogin: '已把该管理员账号的密码重设为本次输入的密码，并登录',
    registered: '管理员账号已创建，注册入口已关闭',
    registerTip: '第一个注册的账号将成为管理员，注册入口随后自动关闭',
    closedTip: '系统已完成初始化，账号请联系管理员开通',
    hintResetOn: {
      title: '已开启管理员密码找回',
      desc: '用管理员账号登录时，若密码填的不是原密码，本次填写的密码会被设为该账号的新密码。该通道仅在服务器本机可用。',
    },
    hintResetOffsite: {
      title: '管理员密码找回仅限服务器本机操作',
      desc: '当前访问地址不是服务器本机，密码找回不会生效（密码填错仍会提示账号或密码错误）。请在服务器上打开 http://127.0.0.1 操作。',
    },
    hintResetOnRemote: {
      title: '已开启管理员密码找回',
      desc: '用管理员账号登录时，若密码填的不是原密码，本次填写的密码会被设为该账号的新密码。',
    },
  },

  /* ---------------- 文件库 ---------------- */
  files: {
    upload: '上传文件',
    uploadTip: '一次只能上传一个文件；多个文件请先打包成压缩包再传',
    newFolder: '新建目录',
    folderNamePlaceholder: '目录名称',
    policyPrefix: '上传策略：{label}',
    policySwitched: '上传策略已切换为「{label}」，下一个上传生效',
    usage: '已用 {used} / {quota}',
    uploadedAt: '上传时间',
    empty: '这里还没有文件，点左上角上传',
    confirmDelete: '确定删除「{name}」？',
    mkdirDone: '已创建',
    uploadDone: '上传完成',
  },

  /* ---------------- 磁盘发布 ---------------- */
  mounts: {
    root: '资源库',
    kind: {
      folder: '文件夹',
      dir: '目录',
      file: '文件',
    },
    newFolder: '新建文件夹',
    publishDir: '发布目录',
    publishFile: '发布文件',
    publishDirTitle: '发布磁盘目录',
    publishFileTitle: '发布磁盘文件',
    createRoleTip: '当前设置下只有管理员可以发布磁盘内容（服务端 MOUNT_CREATE_ROLE）',
    publishTip:
      '发布的是服务器本机已有的内容，原文件不移动、不复制；可见范围可设为所有人 / 仅自己 / 指定用户',
    type: '类型',
    serverPath: '服务器路径',
    noDiskPath: '逻辑分组，无磁盘路径',
    publisher: '发布者',
    visibility: '可见范围',
    visibilityPublic: '所有人',
    visibilityPrivate: '仅自己',
    visibilityProtected: '指定用户',
    visibilityLabel: '可见范围',
    visibilityHint:
      '设为「仅自己」或「指定用户」时，它下面的子项也会一并对其他人隐藏；管理员不受此限制。',
    grantLabel: '授权给',
    grantPlaceholder: '选择可以看到这一项的用户',
    changeVisibility: '可见范围…',
    visibilityDialogTitle: '调整可见范围',
    visibilityFor: '「{name}」的可见范围',
    visibilitySaved: '可见范围已更新',
    sharedWithMe: '共享给我',
    browse: '浏览',
    open: '打开',
    browseTitle: '浏览：{name}',
    shareDir: '分享目录',
    empty: '这个文件夹还是空的，用上方按钮添加内容',
    nameLabel: '名称',
    namePlaceholderFolder: '例如：项目资料',
    namePlaceholderAuto: '留空会自动用所选项目的末段名称',
    absPathLabel: '服务器上的路径',
    absPathPlaceholder: '点右侧按钮在磁盘上选择',
    parentLabel: '放到',
    nameRequired: '请填写名称',
    selectDir: '请选择要发布的目录',
    selectFile: '请选择要发布的文件',
    added: '已添加',
    renamePrompt: '输入新的名称',
    rename: '重命名',
    nameEmpty: '名称不能为空',
    renamed: '已重命名',
    moveTo: '移动到…',
    moveToTitle: '移动到',
    moveHint: '把「{name}」放到哪个逻辑文件夹下？磁盘上的文件不会被移动。',
    moveLoop: '不能移动到自身或自己的子文件夹下',
    moved: '已移动',
    unpublish: '取消发布',
    confirmUnpublish: '确定取消发布「{name}」？磁盘上的原文件不受任何影响。',
    confirmUnpublishNested:
      '确定取消发布「{name}」？文件夹里的 {n} 个子项也会一起从资源库移除，磁盘上的原文件不受任何影响。',
    unpublished: '已取消发布',
    removed: '已移除 {n} 项',
  },

  /* ---------------- 我的分享 ---------------- */
  shares: {
    copyLink: '复制链接',
    copied: '链接已复制：{link}',
    confirmDelete: '删除后链接立即失效，确定？',
    colTitle: '标题 / 链接',
    untitled: '（未命名）',
    colSource: '来源',
    sourceFile: '文件库',
    sourceMount: '磁盘',
    colCode: '提取码',
    copyCode: '复制提取码',
    codeCopied: '提取码已复制：{code}',
    codeBroken: '不可用',
    resetCode: '重设',
    setCode: '设置',
    resetCodePrompt: '输入新的提取码（至少 4 位）。留空表示取消提取码。',
    resetCodeInvalid: '提取码需 4-64 位',
    codeUpdated: '提取码已更新',
    colDownloads: '下载',
    colStatus: '状态',
    status: {
      active: '有效',
      expired: '已过期',
      exhausted: '次数用尽',
    },
    empty: '还没有创建任何分享',
  },

  /* ---------------- 用户管理 ---------------- */
  users: {
    count: '共 {n} 个账号',
    create: '新增用户',
    createTitle: '新增用户',
    self: '当前账号',
    usage: '空间占用',
    createdAt: '创建时间',
    role: '角色',
    resetPassword: '重置密码',
    resetTitle: '重置密码',
    resetHint:
      '为账号「{name}」设置一个新密码，对方需用新密码重新登录；该账号在其他设备上已登录的会话会立即失效。',
    newPasswordPlaceholder: '新密码，至少 6 位',
    resetConfirm: '确定重置',
    resetDone: '已重置 {name} 的密码，其已有登录状态已失效',
    initialPassword: '初始密码',
    usernamePlaceholder: '登录用的用户名',
    quota: '存储配额',
    quotaPlaceholder: '留空使用默认 2048 (MB)',
    created: '用户已创建',
    deleteTitle: '删除用户',
    confirmDelete:
      '删除账号「{name}」会一并清除它的文件库、分享链接与磁盘发布记录，且无法恢复。确定继续？',
    empty: '没有查询到账号',
    emailRequired: '请输入邮箱',
    emailInvalid: '邮箱格式不正确',
    usernameRequired: '请输入用户名',
    passwordRequired: '请输入初始密码',
    passwordMin: '密码至少 6 位',
    newPasswordMin: '新密码至少 6 位',
    quotaInvalid: '配额必须是不小于 0 的数字',
  },

  /* ---------------- 公开分享页 ---------------- */
  share: {
    file: '文件夹',
    available: '可下载',
    expiresAt: '有效期至 {time}',
    remaining: '剩余 {n} 次',
    accessCodePlaceholder: '请输入提取码',
    downloadFile: '下载文件',
    viewFolder: '查看文件夹内容',
    replan: '重新预检',
    planning: '正在统计目录内容…',
    statFiles: '{n} 个文件',
    statDirs: '{n} 个子目录',
    statTotal: '共 {size}',
    zipApprox: '压缩包约 {size}',
    zipUnknown: '未知（压缩后大小不定）',
    skipped: '跳过 {n} 个无权访问项',
    modeLabel: '压缩档位',
    mode: {
      smart: '智能（默认）',
      store: '极速（不压缩）',
      deflate: '高压缩（较慢）',
    },
    truncatedFiles: '文件数超过上限 {n} 个，无法一次性打包',
    truncatedBytes: '总大小超过上限 {size}，无法一次性打包',
    truncatedDepth: '目录层级超过上限 {n}，可能存在循环链接',
    asyncHint: '目录较大，将先在服务器打包，完成后可断点续传',
    packing: '正在打包',
    queued: '排队中…',
    jobProgress: '{done} / {total} 个文件',
    jobBytes: '（{done} / {total}）',
    cancelPack: '取消打包',
    packAndDownload: '打包下载 ZIP',
    redownload: '重新下载 ZIP',
    downloading: '已下载 {size}',
    ofTotal: '/ {size}',
    speed: '· {speed}/s',
    resumable: '· 支持断点续传',
    archiveFailed: '打包失败',
    unavailable: '该分享当前不可用',
    notFound: '分享不存在或已被取消',
  },

  /* ---------------- 传输面板 ---------------- */
  transfer: {
    title: '传输任务',
    active: '{n} 个进行中',
    allDone: '全部完成',
    status: {
      prepare: '准备中',
      running: '进行中',
      paused: '已暂停',
      merging: '合并中',
      done: '已完成',
      error: '失败',
      canceled: '已取消',
    },
    pause: '暂停',
    resume: '继续',
    cancel: '取消',
  },

  /* ---------------- 修改密码 ---------------- */
  password: {
    oldLabel: '原密码',
    oldPlaceholder: '当前使用的密码',
    newLabel: '新密码',
    confirmLabel: '确认新密码',
    confirmPlaceholder: '再输一次新密码',
    submit: '确定修改',
    done: '密码已修改，其他设备上的登录状态已失效',
    warn: '修改成功后，该账号在其他浏览器 / 设备上的登录状态会立即失效。',
    oldRequired: '请输入原密码',
    newRequired: '请输入新密码',
    newMin: '新密码至少 6 位',
    sameAsOld: '新密码不能与原密码相同',
    confirmRequired: '请再次输入新密码',
    mismatch: '两次输入的新密码不一致',
  },

  /* ---------------- 磁盘选择器 ---------------- */
  picker: {
    titleDir: '选择服务器上的目录',
    titleFile: '选择服务器上的文件',
    notChosen: '（未选择）',
    noRoots: '服务端没有可浏览的范围，请检查 MOUNT_ALLOWED_ROOTS 配置',
    emptyDir: '这个目录里没有可选内容',
    hintDir: '进入目标目录后点「选择当前目录」',
    hintFile: '点目录进入，点文件选中',
    chooseDir: '选择当前目录',
    chooseFile: '选择该文件',
    selectFileFirst: '请先选中一个文件',
    enterDirFirst: '请先进入一个目录',
  },

  /* ---------------- 创建分享 ---------------- */
  shareDialog: {
    title: '创建分享链接',
    titleLabel: '标题',
    titlePlaceholder: '留空则用文件名',
    accessCode: '提取码',
    accessCodePlaceholder: '留空则无需提取码',
    accessCodeMinHint: '至少 4 位，创建后仍可回来看',
    generate: '随机生成',
    expires: '有效期（小时）',
    expiresHint: '0 表示永久',
    maxDownloads: '下载次数上限',
    maxDownloadsHint: '0 表示不限',
    created: '分享已创建',
  },

  /* ---------------- 上传策略 ---------------- */
  policy: {
    steady: {
      label: '稳健',
      desc: '分片小、并发低、重试更耐心。适合弱网、WiFi 不稳、跨公网上传',
    },
    balanced: {
      label: '均衡',
      desc: '默认档。分片与并发按文件体积自适应，多数场景不用改',
    },
    turbo: {
      label: '极速',
      desc: '分片大、并发高。适合千兆局域网，弱网下反而容易失败重传',
    },
  },

  /* ---------------- 上传 / 下载过程中的即时状态 ---------------- */
  transferNote: {
    fingerprint: '计算指纹',
    instant: '秒传',
    resume: '续传（已有 {done}/{total} 片）',
    retrying: '重试中（并发降到 {n}）',
    reuploading: '补传 {n} 个分片',
    merging: '合并分片',
  },
  downloadError: {
    noPicker: '当前浏览器不支持选择保存位置',
    httpError: '下载失败（HTTP {status}）',
    noLength: '无法获取文件长度',
    noReader: '无法读取响应内容',
    canceled: '用户取消',
    aborted: '下载出错',
  },
  uploadError: {
    reuploadFailed: '补传分片失败，请重试',
    mergeFailed: '合并失败，请重试',
    failed: '上传失败',
  },

  /* ---------------- 剪贴板兜底 ---------------- */
  clipboard: {
    copied: '已复制到剪贴板',
    title: '无法自动复制',
    manual: '{reason}。请手动全选下面的内容后按 Ctrl+C：',
    close: '关闭',
    notSupported: '当前浏览器不支持自动复制',
    denied: '浏览器拒绝了剪贴板写入',
    writeFailed: '写入失败',
    inIframe: '页面嵌在 iframe 里',
    insecure: '当前不是 HTTPS 或 localhost 安全环境',
    listSep: '；',
    /** 括号在中文里是全角、且不留空格，英文里是半角、且前面要空一格 */
    envWrap: '（{list}）',
  },
}
