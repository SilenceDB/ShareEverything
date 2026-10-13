/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

/**
 * English messages (en-US).
 *
 * 结构与 `zh-CN.ts` 一一对应，缺哪一条就会回退成中文。
 *
 * 带数量的句子用 vue-i18n 的复数形式：`零 | 单数 | 复数`，三段用 `|` 分隔。
 * 实测（vue-i18n 11）0 → 第一段、1 → 第二段、其余 → 第三段，且 `{n}` 会被替换成实际数量。
 * 中文那边不需要复数，所以只写一段 `{n}` 即可 —— 两种语言的段数可以不一样。
 */
export default {
  /* ---------------- 全局骨架 ---------------- */
  app: {
    title: 'Resource Sharing Platform',
    devMode: 'Development mode',
    version: 'Version {v}',
    builtAt: 'Built at {at}',
    srcMode: 'Running from source, not a release build',
    notLoggedIn: 'Not signed in',
    language: 'Language',
  },
  nav: {
    files: 'My Files',
    mounts: 'Disk Library',
    shares: 'My Shares',
    users: 'Users',
  },
  account: {
    changePassword: 'Change password',
    logout: 'Sign out',
  },

  /* ---------------- 通用词 ---------------- */
  common: {
    admin: 'Admin',
    user: 'User',
    name: 'Name',
    size: 'Size',
    actions: 'Actions',
    refresh: 'Refresh',
    cancel: 'Cancel',
    confirm: 'OK',
    create: 'Create',
    delete: 'Delete',
    deleted: 'Deleted',
    download: 'Download',
    share: 'Share',
    more: 'More',
    up: 'Up',
    parent: 'Up one level',
    rootDir: 'Root',
    choose: 'Choose…',
    needsCode: 'Required',
    noCode: 'None',
    dir: 'Folder',
    email: 'Email',
    username: 'Username',
    password: 'Password',
    passwordMinHint: 'At least 6 characters',
    alertTitle: 'Notice',
    downloadDone: 'Download complete',
    downloadFailed: 'Download failed',
    requestFailed: 'Request failed',
  },

  /* ---------------- 登录 / 注册 ---------------- */
  login: {
    tabLogin: 'Sign in',
    tabRegister: 'Sign up',
    submit: 'Sign in',
    submitRegister: 'Sign up and sign in',
    account: 'Username or email',
    accountPlaceholder: 'Enter your username or email',
    usernamePlaceholder: 'Letters and digits',
    ok: 'Signed in',
    resetAndLogin:
      'The administrator password was reset to the one you just entered, and you are now signed in',
    registered: 'The administrator account has been created; sign-up is now closed',
    registerTip: 'The first account to register becomes the administrator; sign-up closes right after',
    closedTip: 'This system has already been initialized. Please ask an administrator to create an account.',
    hintResetOn: {
      title: 'Administrator password recovery is enabled',
      desc: 'When you sign in with an administrator account, if the password you enter is not the current one, it will be set as the new password for that account. This channel only works on the server itself.',
    },
    hintResetOffsite: {
      title: 'Administrator password recovery only works on the server itself',
      desc: 'This address is not the server machine, so password recovery will not take effect (a wrong password still reports “incorrect account or password”). Please open http://127.0.0.1 on the server instead.',
    },
    hintResetOnRemote: {
      title: 'Administrator password recovery is enabled',
      desc: 'When you sign in with an administrator account, if the password you enter is not the current one, it will be set as the new password for that account.',
    },
  },

  /* ---------------- 文件库 ---------------- */
  files: {
    upload: 'Upload file',
    uploadTip: 'One file at a time. To upload several, pack them into an archive first.',
    newFolder: 'New folder',
    folderNamePlaceholder: 'Folder name',
    policyPrefix: 'Upload mode: {label}',
    policySwitched: 'Upload mode switched to “{label}”; it applies from the next upload',
    usage: 'Used {used} / {quota}',
    uploadedAt: 'Uploaded',
    empty: 'No files here yet — use the upload button at the top left',
    confirmDelete: 'Delete “{name}”?',
    mkdirDone: 'Created',
    uploadDone: 'Upload complete',
  },

  /* ---------------- 磁盘发布 ---------------- */
  mounts: {
    root: 'Library',
    kind: {
      folder: 'Folder',
      dir: 'Directory',
      file: 'File',
    },
    newFolder: 'New folder',
    publishDir: 'Publish folder',
    publishFile: 'Publish file',
    publishDirTitle: 'Publish a directory',
    publishFileTitle: 'Publish a file',
    createRoleTip:
      'With the current settings only administrators can publish disk content (server-side MOUNT_CREATE_ROLE)',
    publishTip:
      'Publishing links to content already on the server — nothing is moved or copied, and every signed-in user can see it',
    type: 'Type',
    serverPath: 'Server path',
    noDiskPath: 'Logical group, no disk path',
    publisher: 'Published by',
    browse: 'Browse',
    open: 'Open',
    browseTitle: 'Browsing: {name}',
    shareDir: 'Share folder',
    empty: 'This folder is empty — add something with the buttons above',
    nameLabel: 'Name',
    namePlaceholderFolder: 'e.g. Project files',
    namePlaceholderAuto: 'Leave empty to use the last segment of the selected path',
    absPathLabel: 'Path on the server',
    absPathPlaceholder: 'Click the button on the right to pick on disk',
    parentLabel: 'Place in',
    nameRequired: 'Please enter a name',
    selectDir: 'Please select a directory to publish',
    selectFile: 'Please select a file to publish',
    added: 'Added',
    renamePrompt: 'Enter the new name',
    rename: 'Rename',
    nameEmpty: 'Name cannot be empty',
    renamed: 'Renamed',
    moveTo: 'Move to…',
    moveToTitle: 'Move to',
    moveHint: 'Which logical folder should “{name}” go into? Files on disk are not moved.',
    moveLoop: 'Cannot move an item into itself or into one of its own sub-folders',
    moved: 'Moved',
    unpublish: 'Unpublish',
    confirmUnpublish: 'Unpublish “{name}”? The original files on disk are not affected.',
    confirmUnpublishNested:
      'Unpublish “{name}”? The sub-items inside it ({n}) will also be removed from the library. The original files on disk are not affected.',
    unpublished: 'Unpublished',
    removed: 'nothing removed | {n} item removed | {n} items removed',
  },

  /* ---------------- 我的分享 ---------------- */
  shares: {
    copyLink: 'Copy link',
    copied: 'Link copied: {link}',
    confirmDelete: 'The link stops working immediately after deletion. Continue?',
    colTitle: 'Title / link',
    untitled: '(Untitled)',
    colSource: 'Source',
    sourceFile: 'My Files',
    sourceMount: 'Disk',
    colCode: 'Access code',
    colDownloads: 'Downloads',
    colStatus: 'Status',
    status: {
      active: 'Active',
      expired: 'Expired',
      exhausted: 'Used up',
    },
    empty: 'You have not created any shares yet',
  },

  /* ---------------- 用户管理 ---------------- */
  users: {
    count: 'no accounts | {n} account | {n} accounts',
    create: 'New user',
    createTitle: 'New user',
    self: 'You',
    usage: 'Storage used',
    createdAt: 'Created',
    role: 'Role',
    resetPassword: 'Reset password',
    resetTitle: 'Reset password',
    resetHint:
      'Set a new password for “{name}”. They will need it to sign in again, and their sessions on other devices stop working immediately.',
    newPasswordPlaceholder: 'New password, at least 6 characters',
    resetConfirm: 'Reset',
    resetDone: 'Password reset for {name}; their existing sessions are now invalid',
    initialPassword: 'Initial password',
    usernamePlaceholder: 'Username used to sign in',
    quota: 'Storage quota',
    quotaPlaceholder: 'Leave empty to use the default 2048 (MB)',
    created: 'User created',
    deleteTitle: 'Delete user',
    confirmDelete:
      'Deleting “{name}” also removes their uploaded files, share links and published items. This cannot be undone. Continue?',
    empty: 'No accounts found',
    emailRequired: 'Please enter an email address',
    emailInvalid: 'Invalid email address',
    usernameRequired: 'Please enter a username',
    passwordRequired: 'Please enter an initial password',
    passwordMin: 'Password must be at least 6 characters',
    newPasswordMin: 'The new password must be at least 6 characters',
    quotaInvalid: 'Quota must be a number greater than or equal to 0',
  },

  /* ---------------- 公开分享页 ---------------- */
  share: {
    file: 'Folder',
    available: 'Available',
    expiresAt: 'Expires {time}',
    remaining: '{n} downloads left',
    accessCodePlaceholder: 'Enter the access code',
    downloadFile: 'Download file',
    viewFolder: 'View folder contents',
    replan: 'Scan again',
    planning: 'Scanning the folder…',
    statFiles: 'no files | {n} file | {n} files',
    statDirs: 'no sub-folders | {n} sub-folder | {n} sub-folders',
    statTotal: '{size} total',
    zipApprox: 'ZIP about {size}',
    zipUnknown: 'unknown (compressed size varies)',
    skipped: 'no items skipped (no access) | {n} item skipped (no access) | {n} items skipped (no access)',
    modeLabel: 'Compression',
    mode: {
      smart: 'Smart (default)',
      store: 'Fast (no compression)',
      deflate: 'Best compression (slower)',
    },
    truncatedFiles: 'More than {n} files — cannot be packed in one go',
    truncatedBytes: 'Larger than {size} in total — cannot be packed in one go',
    truncatedDepth: 'Deeper than {n} levels — possible symlink loop',
    asyncHint: 'This folder is large: it will be packed on the server first, then downloads can resume',
    packing: 'Packing',
    queued: 'Queued…',
    jobProgress: '{done} / {total} files',
    jobBytes: ' ({done} / {total})',
    cancelPack: 'Cancel packing',
    packAndDownload: 'Pack and download ZIP',
    redownload: 'Download ZIP again',
    downloading: 'Downloaded {size}',
    ofTotal: '/ {size}',
    speed: '· {speed}/s',
    resumable: '· resumable',
    archiveFailed: 'Packing failed',
    unavailable: 'This share is currently unavailable',
    notFound: 'This share does not exist or has been canceled',
  },

  /* ---------------- 传输面板 ---------------- */
  transfer: {
    title: 'Transfers',
    active: 'none in progress | {n} in progress | {n} in progress',
    allDone: 'All done',
    status: {
      prepare: 'Preparing',
      running: 'In progress',
      paused: 'Paused',
      merging: 'Merging',
      done: 'Done',
      error: 'Failed',
      canceled: 'Canceled',
    },
    pause: 'Pause',
    resume: 'Resume',
    cancel: 'Cancel',
  },

  /* ---------------- 修改密码 ---------------- */
  password: {
    oldLabel: 'Current password',
    oldPlaceholder: 'The password you use now',
    newLabel: 'New password',
    confirmLabel: 'Confirm new password',
    confirmPlaceholder: 'Enter the new password again',
    submit: 'Change password',
    done: 'Password changed — sessions on other devices are now invalid',
    warn: 'Once changed, your sessions in other browsers or devices stop working immediately.',
    oldRequired: 'Please enter your current password',
    newRequired: 'Please enter a new password',
    newMin: 'The new password must be at least 6 characters',
    sameAsOld: 'The new password must differ from the current one',
    confirmRequired: 'Please enter the new password again',
    mismatch: 'The two passwords do not match',
  },

  /* ---------------- 磁盘选择器 ---------------- */
  picker: {
    titleDir: 'Select a directory on the server',
    titleFile: 'Select a file on the server',
    notChosen: '(nothing selected)',
    noRoots: 'The server exposes no browsable range — check the MOUNT_ALLOWED_ROOTS setting',
    emptyDir: 'Nothing selectable in this folder',
    hintDir: 'Enter the target folder, then click “Use this folder”',
    hintFile: 'Click a folder to enter it, click a file to select it',
    chooseDir: 'Use this folder',
    chooseFile: 'Use this file',
    selectFileFirst: 'Please select a file first',
    enterDirFirst: 'Please enter a folder first',
  },

  /* ---------------- 创建分享 ---------------- */
  shareDialog: {
    title: 'Create a share link',
    titleLabel: 'Title',
    titlePlaceholder: 'Leave empty to use the file name',
    accessCode: 'Access code',
    accessCodePlaceholder: 'Leave empty for no access code',
    expires: 'Valid for (hours)',
    expiresHint: '0 means forever',
    maxDownloads: 'Download limit',
    maxDownloadsHint: '0 means unlimited',
    created: 'Share created',
  },

  /* ---------------- 上传策略 ---------------- */
  policy: {
    steady: {
      label: 'Steady',
      desc: 'Smaller chunks, low concurrency, patient retries. Good for weak Wi-Fi or uploading over the internet',
    },
    balanced: {
      label: 'Balanced',
      desc: 'The default. Chunk size and concurrency adapt to the file size; rarely needs changing',
    },
    turbo: {
      label: 'Turbo',
      desc: 'Larger chunks, high concurrency. Good on a gigabit LAN; on weak networks it tends to fail and retry',
    },
  },

  /* ---------------- 上传 / 下载过程中的即时状态 ---------------- */
  transferNote: {
    fingerprint: 'Hashing',
    instant: 'Instant',
    resume: 'Resuming ({done}/{total} chunks done)',
    retrying: 'Retrying (concurrency lowered to {n})',
    reuploading: 'Re-uploading {n} chunks',
    merging: 'Merging chunks',
  },
  downloadError: {
    noPicker: 'This browser cannot choose a save location',
    httpError: 'Download failed (HTTP {status})',
    noLength: 'Could not determine the file length',
    noReader: 'Could not read the response body',
    canceled: 'Canceled by the user',
    aborted: 'Download error',
  },
  uploadError: {
    reuploadFailed: 'Failed to re-upload some chunks. Please try again.',
    mergeFailed: 'Merging failed. Please try again.',
    failed: 'Upload failed',
  },

  /* ---------------- 剪贴板兜底 ---------------- */
  clipboard: {
    copied: 'Copied to clipboard',
    title: 'Could not copy automatically',
    manual: '{reason}. Please select everything below and press Ctrl+C:',
    close: 'Close',
    notSupported: 'This browser does not support automatic copying',
    denied: 'The browser blocked the clipboard write',
    writeFailed: 'Write failed',
    inIframe: 'the page is inside an iframe',
    insecure: 'this is not a secure context (HTTPS or localhost)',
    listSep: '; ',
    envWrap: ' ({list})',
  },
}
