/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

/**
 * 英文文案表：**键就是中文原文**（gettext 风格的 msgid）。
 *
 * 这么做的两个理由：
 *   1. 抛出点一个字都不用改 —— `new AppError('账号或密码错误', 401)` 保持原样，
 *      翻译统一在响应层（index.ts 的错误处理 + 少数直接 reply 的地方）完成；
 *   2. 漏译不会变成空白或 key 名，而是**原样回退成中文**，最坏情况只是夹一句中文。
 *
 * 带 `{}` 的是需要插值的模板，占位符按出现顺序对应 params 数组。
 * 新增文案后请跑 `npm run check:i18n`（scripts/check-i18n.ts）核对是否有漏收录。
 */
export const en: Record<string, string> = {
  /* ---------- utils/fs.ts ---------- */
  '非法路径：不允许访问根目录之外的位置': 'Invalid path: access outside the root directory is not allowed',
  '根目录不存在或无法访问': 'The root directory does not exist or is not accessible',
  '文件或目录不存在': 'File or directory not found',
  '名称不能包含路径分隔符': 'A name cannot contain path separators (/ or \\)',
  '名称首尾不能有空格或点':
    'A name cannot start or end with a space or a dot (Windows strips them silently)',
  '名称包含非法字符': 'A name contains characters that are not allowed on disk',
  '名称不能使用系统保留名':
    'That name is reserved by the operating system (CON, PRN, AUX, NUL, COM1-9, LPT1-9)',
  '名称过长': 'The name is too long (255 bytes max)',

  /* ---------- utils/stream.ts ---------- */
  '文件不存在': 'File not found',
  '不能直接下载目录': 'A directory cannot be downloaded directly',
  'Range 超出范围': 'Requested range is out of bounds',

  /* ---------- plugins/auth.ts ---------- */
  '未登录或登录已过期': 'Not signed in, or your session has expired',
  '账号不存在或已被删除': 'This account does not exist or has been deleted',
  '登录状态已失效，请重新登录': 'Your session is no longer valid. Please sign in again.',
  '需要管理员权限': 'Administrator privileges are required',

  /* ---------- routes/auth.ts ---------- */
  '邮箱、用户名、密码不能为空': 'Email, username and password are required',
  '密码至少 6 位': 'Password must be at least 6 characters',
  '邮箱格式不正确': 'Invalid email address',
  '系统已完成初始化，管理员账号已存在，请联系管理员开通账号':
    'This system has already been initialized and an administrator account exists. Please ask an administrator to create an account for you.',
  '邮箱或用户名已被占用': 'That email or username is already taken',
  '账号和密码不能为空': 'Account and password are required',
  '账号或密码错误': 'Incorrect account or password',
  '新密码至少 6 位': 'The new password must be at least 6 characters',
  '用户不存在': 'User not found',
  '请填写原密码和新密码': 'Please enter both your current password and the new password',
  '新密码不能与原密码相同': 'The new password must differ from the current one',
  '原密码不正确': 'Current password is incorrect',

  /* ---------- routes/users.ts ---------- */
  '配额必须是不小于 0 的数字': 'Quota must be a number greater than or equal to 0',
  '角色只能是 USER 或 ADMIN': 'Role must be either USER or ADMIN',
  '该邮箱已被占用': 'That email is already taken',
  '该用户名已被占用': 'That username is already taken',
  '新密码不能为空': 'The new password is required',
  '不能删除当前登录的账号': 'You cannot delete the account you are signed in with',
  '系统至少需要保留一个管理员账号': 'At least one administrator account must remain',

  /* ---------- routes/files.ts ---------- */
  '目录名不能为空': 'Directory name is required',
  '同名文件已存在': 'A file with the same name already exists',
  '请使用 multipart/form-data 上传': 'Please upload using multipart/form-data',
  '没有收到文件': 'No file was received',
  '存储空间不足，上传已取消': 'Not enough storage space — the upload was canceled',
  '存储空间不足（剩余额度 {}）': 'Not enough storage space ({} remaining)',
  '目录不支持下载': 'Directories cannot be downloaded',

  /* ---------- routes/uploads.ts ---------- */
  '文件名不能为空': 'File name is required',
  '文件大小不合法': 'Invalid file size',
  '文件超过单文件上限': 'The file exceeds the per-file size limit',
  '存储空间不足': 'Not enough storage space',
  '上传任务不存在': 'Upload task not found',
  '请使用 multipart/form-data 上传分片': 'Please upload chunks using multipart/form-data',
  '同时上传的分片过多（上限 {}）': 'Too many chunks are uploading at once (limit: {})',
  '没有收到分片内容': 'No chunk data was received',
  '分片序号不合法': 'Invalid chunk index',
  '分片大小超出预期': 'Chunk is larger than expected',
  '还有分片未上传完成': 'Some chunks have not been uploaded yet',
  '合并后大小不一致（期望 {}，实际 {}），请重新上传':
    'Size mismatch after merging (expected {}, got {}). Please upload again.',

  /* ---------- routes/mounts.ts ---------- */
  '发布不存在': 'Published item not found',
  '只有发布者本人或管理员可以修改这一项': 'Only the publisher or an administrator can modify this item',
  '名称不能为空': 'Name is required',
  '名称过长（最多 120 个字符）': 'Name is too long (120 characters max)',
  '名称不能包含路径分隔符或控制字符': 'Name cannot contain path separators or control characters',
  '目标文件夹不存在': 'Target folder not found',
  '只能放进逻辑文件夹里': 'Items can only be placed inside a logical folder',
  '同一层级下已存在同名项目，请换一个名称':
    'An item with this name already exists at the same level. Please choose another name.',
  '可见性只能是 PUBLIC / PRIVATE / PROTECTED': 'Visibility must be PUBLIC, PRIVATE or PROTECTED',
  '指定的用户不存在': 'One or more of the selected users does not exist',
  '与已发布目录「{}」存在包含关系，请换一个路径':
    'This path overlaps with the published directory “{}”. Please choose another path.',
  '当前设置下只有管理员可以发布磁盘内容':
    'With the current settings, only administrators can publish disk content',
  'kind 只能是 FOLDER / DIR / FILE': 'kind must be one of FOLDER / DIR / FILE',
  '请选择要发布的目录': 'Please select a directory to publish',
  '请选择要发布的文件': 'Please select a file to publish',
  '必须是服务器上的绝对路径': 'Must be an absolute path on the server',
  '该路径在服务器上不存在': 'That path does not exist on the server',
  '选择的不是目录': 'The selected item is not a directory',
  '选择的不是文件': 'The selected item is not a file',
  '该路径不在允许发布的范围内（见服务端 MOUNT_ALLOWED_ROOTS 配置）':
    'That path is not within the allowed publishing range (see the server’s MOUNT_ALLOWED_ROOTS setting)',
  '不能移动到自身或自己的子节点下': 'Cannot move an item into itself or into one of its own descendants',
  '该路径不存在或无法访问': 'That path does not exist or is not accessible',
  '该路径不是目录': 'That path is not a directory',
  '该路径不在允许浏览的范围内': 'That path is outside the allowed browsing range',
  '逻辑文件夹没有磁盘内容': 'A logical folder has no disk content',
  '这是一个文件节点，直接下载即可': 'This is a file node — download it directly',
  '逻辑文件夹不能直接下载': 'A logical folder cannot be downloaded directly',
  '缺少 sub 参数': 'Missing the "sub" parameter',

  /* ---------- routes/shares.ts ---------- */
  'targetType 只能是 FILE 或 MOUNT': 'targetType must be either FILE or MOUNT',
  '缺少 subPath': 'Missing subPath',
  '该路径在磁盘上不存在': 'That path does not exist on disk',
  '逻辑文件夹暂不支持分享，请分享具体的目录或文件':
    'Logical folders cannot be shared. Please share a specific directory or file.',
  '分享不存在': 'Share not found',
  '分享不存在或已被取消': 'This share does not exist or has been canceled',
  '该分享不是目录，请直接下载': 'This share is not a directory — download it directly',
  '源目录已不存在': 'The source directory no longer exists',
  '打包过于频繁，请 {} 秒后重试': 'Archiving is happening too often. Please retry in {} seconds.',
  '目录太大，文件数超过上限 {}，已取消打包':
    'Directory too large: file count exceeds the limit of {}. Archiving was canceled.',
  '目录太大，总大小超过上限 {}，已取消打包':
    'Directory too large: total size exceeds the limit of {}. Archiving was canceled.',
  '目录太大，目录层级超过上限 {}，已取消打包':
    'Directory too large: nesting depth exceeds the limit of {}. Archiving was canceled.',
  '目录太大（文件数超过上限），已取消打包':
    'Directory too large (file count exceeds the limit). Archiving was canceled.',
  '目录太大（总大小超过上限），已取消打包':
    'Directory too large (total size exceeds the limit). Archiving was canceled.',
  '打包任务不存在': 'Archive job not found',
  '打包尚未完成': 'Archiving has not finished yet',
  '打包文件已过期，请重新打包': 'The archive has expired. Please create it again.',
  '源文件已不存在': 'The source file no longer exists',
  '这是目录分享，请使用打包下载': 'This is a directory share — use the ZIP download instead',
  '分享已过期': 'This share has expired',
  '下载次数已达上限': 'The download limit has been reached',
  '提取码不正确': 'Incorrect access code',
  '提取码错误次数过多，请 {} 秒后再试':
    'Too many incorrect access code attempts. Please try again in {} seconds.',
  '提取码格式不正确': 'The access code has an invalid format',
  '提取码长度需在 {}-{} 位之间': 'The access code must be between {} and {} characters long',
  '提取码不能包含控制字符或换行': 'The access code cannot contain control characters or line breaks',
  '提取码无法解密（ACCESS_CODE_KEY 可能已变更），请联系创建者重设提取码':
    'The access code cannot be decrypted (ACCESS_CODE_KEY may have changed). Ask the creator to set a new one.',
  '缺少 accessCode': 'Missing accessCode',
  '未命名': 'Untitled',

  /* ---------- services/archive.ts ---------- */
  '当前打包任务已满，请稍后再试': 'The archive queue is full. Please try again later.',
  '分享已被删除': 'The share has been deleted',
  '打包失败': 'Archiving failed',
  '服务重启，打包已中断': 'The service restarted, so archiving was interrupted',
  '源文件已被删除': 'The source file has been deleted',
  '源目录已被删除': 'The source directory has been deleted',
  '该分享指向的是逻辑文件夹，无法打包':
    'This share points to a logical folder, so it cannot be archived',

  /* ---------- index.ts ---------- */
  '服务器内部错误': 'Internal server error',
  '接口不存在': 'API endpoint not found',
  '请求过于频繁，请稍后再试': 'Too many requests. Please try again later.',
  '请求体过大': 'Request body is too large',
  '请求体不是合法的 JSON': 'Request body is not valid JSON',
  '请求体不能为空': 'Request body cannot be empty',
}
