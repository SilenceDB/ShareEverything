<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

# ShareEverything 设计说明

给**要读代码、改代码、排障**的人。安装包怎么打、服务怎么启停都在 [README.md](README.md)，
界面每个按钮干什么在 [FEATURES.md](FEATURES.md)；这里讲的是「为什么这么实现」以及动手改的时候会踩到什么。

> 分工：**README 讲怎么装怎么跑，FEATURES 讲界面上怎么用，DESIGN 讲怎么造的**。
> 改实现先改 DESIGN，再把用户能感知的结论摘进 FEATURES（操作细节）或 README（安装与启停）。

## 目录

| 章节 | 内容 |
| -- | -- |
| [目录结构](#目录结构) | 代码都放在哪 |
| [逻辑模型与权限](#逻辑模型与权限) | 资源库逻辑树、可见范围判定、路径白名单、令牌版本 |
| [配额](#配额) | 三个口径与两道闸门 |
| [上传与下载](#上传与下载) | 分片策略推导、AIMD、Range 续传 |
| [目录打包（ZIP）](#目录打包zip) | 流式 ZIP、压缩档位、限额、后台任务 |
| [界面语言](#界面语言) | 为什么后端用中文当 key、`X-Locale`、自检脚本 |
| [接口一览](#接口一览) | 全部 HTTP 接口与分级返回 |
| [安全设计](#安全设计) | 逐条防护与它们的取舍 |
| [HTTPS 与证书](#https-与证书) | 自签证书、`cert-hosts.conf`、IP 变了怎么办 |
| [进程守护、日志与打包](#进程守护日志与打包) | pm2、单实例、日志落盘、脚本结构 |
| [下一版可以做](#下一版可以做) | 待办清单 |

---

## 目录结构

```
ShareEverything/
├── server/                 后端
│   ├── prisma/schema.prisma  数据模型
│   ├── src/
│   │   ├── index.ts          启动、日志接管、崩溃兜底、优雅退出、单实例
│   │   ├── config.ts         配置（端口 / 存储根 / JWT 密钥解析 / 限额与限流 / 配额 / 日志）
│   │   ├── utils/quota.ts    配额统一口径（已落库 / 在途分片 / 承诺量）+ 写盘截断流
│   │   ├── i18n/             后端文案（key 即中文原文）+ 请求语言解析
│   │   ├── plugins/auth.ts   JWT 签发与鉴权守卫
│   │   ├── routes/           auth / users / files / uploads / mounts / shares
│   │   └── utils/            路径与名称安全校验、流式下载、按天滚动日志、失败计数节流（guard）
│   └── storage/              上传文件存放处（自动生成，含 .tmp 分片暂存）
├── web/                    前端
│   └── src/
│       ├── api/              接口封装
│       ├── i18n/             vue-i18n 实例、语言持久化与 Element Plus 语言包同步
│       ├── locales/          zh-CN / en-US 两份界面词典
│       ├── utils/            uploader（分片上传）/ downloader（续传下载）/ fingerprint
│       └── views/ components/  页面与传输任务面板
└── scripts/
    ├── build.mjs             一键打包（标准包 / 离线包，自带 ZIP 写入器）
    ├── check-i18n.ts         中英对齐校验（漏译 / 缺键 / 废弃词条 / 残留中文）
    └── dist-template/        产物里的启动与守护脚本模板
        ├── *.bat / start.sh     三行包装，双击即用
        └── tools/*.mjs          ctl（启动/停止/状态/日志/自启）、setup（生成 pm2 配置）、
                                 show-logs、gen-cert（自签 HTTPS 证书）
```

---

## 逻辑模型与权限

### 资源库是一棵逻辑树

`Mount` 一张表装三种节点，`parentId` 自关联成树，所以可以任意嵌套：

| 类型 | 对应磁盘 | 能做什么 |
| --- | --- | --- |
| **逻辑文件夹**（`FOLDER`） | 无（纯分组） | 装别的节点、重命名、移动、整棵移除 |
| **目录**（`DIR`） | 一个真实目录 | 浏览、逐文件下载、分享（打包 ZIP） |
| **文件**（`FILE`） | 一个真实文件 | 直接下载、分享 |

几个实现上的约束：

- **名称同父唯一**：数据库层面没法表达，靠应用层校验（`assertSafeName` + 查询）。
- **自关联必须 `NoAction`**；删逻辑文件夹要**自底向上递归**，不能靠数据库级联。
- **逻辑文件夹不支持分享**——它没有对应的磁盘内容，打包不出来。
- 删节点只删记录，**磁盘上的原文件一个都不动**。

### 可见范围判定

每个节点单独设可见范围，三档（默认 `PUBLIC`，与最早的「全站共享」行为一致）：
`PUBLIC`（所有登录用户）/ `PRIVATE`（仅发布者）/ `PROTECTED`（发布者 + 授权名单）。
判定集中在 `server/src/utils/mountAccess.ts`，两条规则容易搞错，这里写死：

1. **管理员一律可见。** 与「改名 / 移动 / 移除限发布者或管理员」是同一套口径——否则别人设了私有的项
   一旦出问题，管理员既看不见也删不掉，只能去改数据库。
2. **父级收紧则整棵子树一并收紧。** 判定沿祖先链取最严的一级，所以把文件夹设成 `PRIVATE`
   就等于整条分支对外关闭，不会出现「以为关了、其实子项还是 `PUBLIC` 被看见」的情况。

看不见的时候，浏览、下载、就它建分享链接，一律回 **404「发布不存在」**——刻意与「本来就没这一项」
返回完全一样，否则拿 id 遍历就能靠错误码差异把私有项的存在性探出来。

它与**分享出去的外链**是两条独立的通道：分享链接自带提取码，本来就是发布者主动开放的，
不受可见范围约束；但反过来，对**看不见**的项不能开链接，否则私有就只是把列表入口藏起来了。

往文件夹里发布 / 移动时也要 `assertMountVisible(父)`，否则「往一个看不见的目录里塞东西」会绕过上面这套。

### 发布权限与路径白名单

**发布权限默认是收窄的**（`MOUNT_CREATE_ROLE=ADMIN`），**可发布的路径范围也默认收窄**：

```env
# ADMIN（默认）= 仅管理员可发布；USER = 任何登录用户都能发布
MOUNT_CREATE_ROLE=ADMIN

# 允许发布 / 允许在选择器里浏览的路径范围，分号（或竖线）分隔。
# 不配置时默认收窄到 <运行目录>/Download（打包后就是安装目录下的 Download，会自动创建）。
# 这一项同时管两件事：① 能发布哪些路径；② 「选择路径」弹窗能浏览到哪儿。
# 想恢复成「不限制」（能登录即可发布任意目录）：MOUNT_ALLOWED_ROOTS=*
MOUNT_ALLOWED_ROOTS=D:\share;D:\movie
```

⚠️ **想放行整块盘要写 `D:\`，不要写 `D:`**。Windows 下不带反斜杠的 `D:` 是「D 盘的**当前工作目录**」，
不是盘根：`path.resolve('D:')` 得到的是**服务进程的启动目录**。所以配成 `MOUNT_ALLOWED_ROOTS=D:`
时，白名单会变成安装目录本身 —— 选择器只能浏览到安装目录，再往上就是边界。
现在服务会把裸盘符自动纠正成 `D:\`（`config.ts` 的 `normalizeRootSpec()`），并在启动日志里打印生效范围
（`磁盘发布范围: D:\`），但配置里写全 `D:\` 最不会产生歧义。

白名单的根与发布目标**都以 realpath 为基准**（不是 `path.resolve`），前缀比较统一走
`utils/fs.ts` 的 `dirPrefix()`——不能直接 `root + path.sep`，根是 `D:\` 时会变成 `D:\\`，
`D:\foo` 会被判越界，整盘发布 / 浏览全 403。

### 账号与令牌：改密即踢下线

每次签发 JWT 时都会把一个令牌版本号（`User.tokenVersion`）写进载荷，鉴权时与库里的值比对，
不相等就判定令牌已作废。因此只要有密码变动（管理员重置、本人修改、登录页找回），
该账号此前签发的所有令牌立即失效，用户必须用新密码重新登录。

这套机制没有会话表，代价只是每个带鉴权的请求多一次按主键查询。顺带地，鉴权时 `role`
也**以数据库为准**，管理员被降权后手里的旧令牌当场失去管理员权能。

三处改密入口都要 `increment: 1`，**本人改密还要把新 token 返回给前端**，否则本人立刻被自己踢下线。
无 `tokenVersion` 的旧令牌一律判废。

**注册没有开关**：`User` 表里没有 ADMIN 时才允许注册，第一个账号固定 ADMIN，
「检查 + 建号」在同一个 `$transaction` 里，避免并发建出两个管理员。

**管理员找回密码**（`ALLOW_ADMIN_RESET_PASSWORD`，默认关闭）只对 ADMIN 生效，且**只认服务器本机**
（fail-closed，带任何转发头都不算本机）；非本机一律回普通 401，不暴露开关状态。

---

## 配额

配额在**写盘之前**判定，而不是写完再回滚 —— 超了 413，磁盘上一个字节都不会多占。

三个口径，统一由 `server/src/utils/quota.ts` 提供，所有写盘入口都必须从那里取数：

| 口径 | 含义 | 用在哪 |
| --- | --- | --- |
| `stored` | 已落库文件的字节总和 | 空间用量显示 |
| `pending` | 在途上传任务**已落盘**的分片（在临时目录里，但确实占着磁盘） | 写盘判定 |
| `reserved` | 在途上传任务**声明**的总大小 | 建任务时判断还敢不敢接 |

于是有两个「剩余」：写盘用 `remaining = quota − stored − pending`，
建任务用 `remainingReserved = quota − stored − reserved`。
用承诺量（`reserved`）而不是已收字节来接新任务，是因为一个声明 2GB 的任务只传了 10MB 时
`pending` 才 10MB，按它放行等于超额承诺 —— 早期版本正是只统计已落库文件，
导致**并发建 N 个上传任务就能绕过 N 倍配额**。

除了写盘前判定，写入**过程中**还有一道 `ByteLimitStream` 按剩余额度截断：客户端声明的大小可以撒谎，
只有边写边数才能真正保证磁盘占用不越线。它超限后会继续把剩余请求体读完（不再往盘上写），
这样客户端收到的是干净的 413，而不是连接被重置 —— 立刻抛错只会让客户端拿到 `ECONNRESET`。

空间用量接口 `GET /api/files/usage` 返回的是 `stored + pending`，不是只有 `stored`。

---

## 上传与下载

### 分片策略

大于 8MB 的文件自动走分片流程，小于 8MB 直接整传。

**分片大小和并发数不暴露成可填的数字**，而是由「上传策略」自动推导——因为这两个值是耦合的：

- 内存峰值 ≈ 并发数 × 分片大小，分开填很容易配出爆内存的组合
- 分片数 = 文件大小 ÷ 分片大小，而服务端合并是串行「读一片写一片」，分片太多会把 complete 拖成分钟级

推导规则（`web/src/utils/uploadPolicy.ts`）：

- **分片大小**：按目标分片数反推 → 取到 2 的幂 → 夹在档位上下限之间
- **并发上限**：`min(内存预算 ÷ 分片大小, 档位硬上限, 服务端 maxConcurrentChunks)`
- **实际并发**：从档位起点做慢启动，成功则 +1，失败（含服务端 429）则减半，同 TCP 的 AIMD

三档预设（前端可切换，存 localStorage）：

| 档位 | 目标分片数 | 分片范围 | 并发上限 | 适用 |
| --- | --- | --- | --- | --- |
| 稳健 | 256 | 512KB–8MB | 2 | 弱网、跨公网 |
| 均衡（默认） | 128 | 1MB–16MB | 4 | 多数场景 |
| 极速 | 64 | 4MB–32MB | 8 | 千兆局域网 |

服务端会**再夹一次**（`[MIN_CHUNK_SIZE, MAX_CHUNK_SIZE]`），分片数超过 `MAX_CHUNKS_PER_TASK`
自动放大分片，同用户并发分片数超过 `MAX_CONCURRENT_CHUNKS` 回 429；**前端以返回值为准**。

```
POST /api/uploads/init            建任务，秒传命中直接返回文件
POST /api/uploads/:id/chunk       传单个分片（multipart：index + file）
GET  /api/uploads/:id             查进度，返回已收到的分片序号
POST /api/uploads/:id/complete    合并分片并入库
DELETE /api/uploads/:id           取消，丢弃已收分片
```

前端行为和它对应的实现：

| 能力 | 实现方式 |
| --- | --- |
| 断点续传 | 服务端保留已收分片，`init` / 状态查询返回序号列表，前端只传缺失的 |
| 刷新后继续 | `localStorage` 记住 `uploadId`，重选同一文件时找回未完成的任务 |
| 秒传 | 前端用 Web Crypto 抽样（头/中/尾各 1MB）算指纹，命中已有文件直接完成 |
| 失败重试 | 分片失败自动退避重试，同时把并发减半；累计失败超 12 次才判定任务失败 |
| 并发自适应 | AIMD：成功攒够一批就加一路，失败或收到 429 就减半 |
| 暂停/继续 | 传输面板上的按钮，暂停只是停止发新分片，已上传部分保留在服务端 |

未完成的分片默认保留 3 天（`UPLOAD_TASK_TTL_DAYS`），之后自动清理。

### 下载侧

用 HTTP Range 按 4MB 一段拉取并流式写入磁盘：

- 支持 File System Access API 的浏览器（Chrome / Edge）走 `showSaveFilePicker`，
  直接边下边写，不占内存，可暂停 / 继续 / 取消
- 不支持的浏览器（Firefox / Safari）回退到浏览器原生下载，由浏览器自己利用服务端的 `Accept-Ranges` 续传
- 服务端 `streamFile()` 统一处理 `Range`，返回 206 与正确的 `Content-Range`

因为走 Range，**可续传下载必须关掉按请求数限流**（见「安全设计」里的限流条目）。

---

## 目录打包（ZIP）

分享的对象从「只能是文件」放宽到了「文件或目录」。目录分享的公开页会先做一次预检，
再一次性打包成 ZIP 流式下载。

```
打开链接 → 预检（遍历统计，带限额）→ 流式 ZIP（边读边发）→ 浏览器直接落盘
```

| 阶段 | 接口 | 说明 |
| --- | --- | --- |
| 预检 | `GET /api/s/:code/archive/plan` | 返回文件数、子目录数、总大小、压缩包大小；命中限额时返回 `truncated` |
| 打包 | `GET /api/s/:code/archive` | 边遍历边生成 ZIP 字节流，不落临时文件、不在内存里攒整个包 |

**压缩档位**（公开页可切换，默认 `smart`）：

| 档位 | 行为 | 进度显示 |
| --- | --- | --- |
| 极速 `store` | 完全不压缩 | 有精确总大小，显示百分比 |
| 智能 `smart` | 影音 / 图片 / 已压缩包直存，其余 deflate | 无总大小，显示已下载字节 |
| 高压缩 `deflate` | 全部 deflate | 同上，明显更慢 |

ZIP 本身是零依赖生成的（`server/src/utils/zip.ts`）：deflate 用 Node 内置 `zlib`，
其余字节自己拼。文件名带 UTF-8 flag（中文不乱码）、超过 4GB 或 65535 条目自动启用 ZIP64、
文件条目统一用数据描述符（每个文件只读一遍磁盘，不在头上回填 CRC）。

**限额与保护**（`server/.env`）：

```env
ZIP_MAX_FILES=50000            # 文件数上限
ZIP_MAX_TOTAL_BYTES=21474836480 # 总大小上限（20GB）
ZIP_MAX_DEPTH=32               # 目录层级上限，同时兜住循环软链接
ZIP_CONCURRENCY=2              # 同时最多几个打包，其余排队
ZIP_THROTTLE_SECONDS=60        # 同一分享两次打包的最小间隔，防手抖
```

超出限额时预检会标记 `truncated`，打包请求直接 413 并说明是哪一项超了。
客户端断开（关页面 / 取消下载）会立刻停止遍历并归还并发名额。

**不支持断点续传**：ZIP 是即时生成的，响应带 `Accept-Ranges: none`。大目录看下面的后台打包任务。

打包时的安全规则与浏览一致：跳过指向发布目录外的软链接、用 realpath 去重防止软链接成环、跳过系统目录。

### 后台打包任务（大目录）

同步流式要求一条 HTTP 连接撑到打包结束，几十 GB 的目录风险太大。
超过阈值（`ARCHIVE_ASYNC_THRESHOLD_BYTES` / `ARCHIVE_ASYNC_THRESHOLD_FILES`）
就改成两步：先在服务端把 ZIP 生成好，再当普通文件下载——下载阶段因此支持 Range 断点续传。

```
POST /archive/jobs   →  202 + jobId（后台开始打包）
GET  /archive/jobs/:id      →  轮询进度（已处理 N/M 个文件）
GET  /archive/jobs/:id/file →  下载结果（普通文件，支持 Range 续传）
DELETE /archive/jobs/:id    →  取消并删除临时文件
```

预检结果里的 `suggestAsync` 会告诉前端该走哪条路，用户不需要自己判断。

- 同一个分享 + 同一种档位会**复用**已有任务：打包好的直接返回，正在打包的共享同一份进度
- 下载次数只在任务第一次被下载时计一次（续传会产生多个 Range 请求，按请求计数会把次数刷爆）
- 打包进度按条目上报，写库节流 500ms，不会因为上报进度拖慢打包
- 结果保留 `ARCHIVE_JOB_TTL_HOURS` 小时，过期由定时任务清理；
  启动时还会把上次残留的 RUNNING 任务重置为 FAILED
- 两种模式共用同一个 `createArchiveStream()`，区别只是 pipe 的目标是 HTTP 响应还是文件

---

## 界面语言

界面支持**简体中文 / English** 两种语言，**前端文案与后端错误提示一起切**。切换入口在三处：
侧边栏左下角（与版本号同一处）、登录页底部、分享公开页。

语言选择存在 `localStorage` 的 `se_locale`，**首次访问按浏览器语言自动判定**，之后跟着用户的选择走。
下拉里的选项永远显示「简体中文 / English」自身语言的写法——只看不懂当前语言的人也能找到切回去的入口。

### 后端文案为什么用中文当 key

后端文案表（`server/src/i18n/en.ts`）的 **key 就是中文原文**（gettext 风格的 msgid）。好处有两个：

- **抛出点一个字都不用改**：`throw new AppError('账号或密码错误', 401)` 保持原样，翻译只发生在响应层
- **漏译不会变成空白或 key 名**：查不到就**原样回退成中文**，最坏情况只是界面里夹一句中文，
  不会出现 `files.title` 这种东西

需要插值的文案在抛出处多带一个 `i18n` 参数（`message` 仍是插好值的中文，供日志看）：

```ts
throw new AppError(
  `同时上传的分片过多（上限 ${config.maxConcurrentChunks}）`, 429,
  { key: '同时上传的分片过多（上限 {}）', params: [config.maxConcurrentChunks] },
)
```

`{}` 按出现顺序替换。**打包任务的失败原因是个例外**：它写在数据库里（写的时候不知道将来谁会看），
所以存中文，**在读出来响应时**才翻译。

前端 i18n 的复数管道是 `a|b|c` 形式，第二个参数必须直接传数字，别传对象。

### 语言从哪来：`X-Locale` 而不是 `Accept-Language`

优先读自定义头 **`X-Locale`**（`zh*` → 中文，`en*` → 英文），取不到才退回 `Accept-Language`。

不用 `Accept-Language` 作为首选，是因为它是浏览器的**禁止头**——JS 改不动它，
它反映的是**操作系统语言**而不是用户在界面里选的语言。前端 axios 拦截器统一注入 `X-Locale`，
所以界面切到英文后，后端返回的报错也是英文。用 curl 直接调接口时不带头，走 `Accept-Language` 或默认中文：

```bash
curl -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' -H 'X-Locale: en-US' \
  -d '{"account":"x","password":"y"}'
# {"error":"Incorrect account or password"}
```

前端还有一处**不能只靠文案判断**的地方：分享公开页原本靠错误文案里有没有「过期」二字来识别 410
（分享失效）。文案一换就会失灵，所以传输快照里加了 `errorStatus`，改成**看 HTTP 状态码**。

Element Plus 组件自己的文案（分页、日期、确认框按钮…）有独立的语言包，与 vue-i18n 是两套，
通过 `ElConfigProvider` 手动同步（见 `web/src/i18n/index.ts` 的 `ELEMENT_LOCALES`）。

### 改文案后怎么自检

```bash
npm run check:i18n
```

`scripts/check-i18n.ts` 会查四件事，全绿才算过关：

1. 后端所有文案（`new AppError('…')` 与直接 `t(locale, '…')` 两处）都进了英文表
2. 前端代码里用到的每个 `t('…')` 键，中英两份词典里都有
3. 两份词典**结构一致**（一边有一边没有＝漏译）、没有**没人引用的废弃词条**
4. 界面代码里**没有残留的硬编码中文**（词典目录除外）

运行时拼接的键（`t(\`${key}.title\`)`、`policyKey()`）脚本看不到字面量，
靠脚本顶部的 `DYNAMIC_KEY_PREFIXES` 白名单放行——**加新的拼接点时要同步那里**。
个别行本来就不该翻译（语言下拉的语言名）在行尾写 `// i18n-ignore` 豁免。

配套命令：`npm run typecheck`（前后端类型检查）。

### 写界面时要注意的两件事

**① 宽度按英文留。** 同样的意思，英文通常比中文长 1.5–2 倍（`上传策略：均衡` → `Upload mode: Balanced`）。
表格列宽、按钮区宽度、下拉框宽度都按**较长的一方（英文）**定，中文下多出的空白无害；
反过来按中文定，英文就会换行、截断，甚至把按钮挤出可视区（`el-table` 会整表横向溢出，末列直接看不见）。

**② 日期别直接 `toLocaleString()`。** 它不带参数时跟的是浏览器/操作系统的语言，
会出现「界面切成英文、日期仍是中文格式」。统一走 `formatDateTime()`（`web/src/utils/format.ts`），
它显式传入当前界面语言。字节大小的 `humanSize()` 用 `KB/MB/GB`，两种语言一致，不需要处理。

### 响应式与移动端

- 断点 **1023px**：`web/src/composables/useIsMobile.ts` 的 `MOBILE_QUERY` 与
  `web/src/styles/responsive.css` 的媒体查询**必须同一数值**，改一处就要改另一处。
- **需要换结构的（侧栏→抽屉、表格→卡片）只能靠 `useIsMobile()` 切 `v-if`**，CSS 断点做不到。
  纯样式类的收敛（弹窗宽度、触控高度、留白）才写进 `responsive.css`。
- 768~1023 落在同一套紧凑布局里：这一段宽度装不下 210px 侧栏 + 220px 目录树 + 五列带操作列的表格
  （磁盘发布页实测可视区只剩 318px，四列最少 548px，操作列直接被挤进横向滚动外）。
  卡片在这一段用 `grid auto-fit minmax(320px, 1fr)` 排两列，只有一条时铺满。
- 勾选状态统一存 **id 数组**（桌面由表格 `@selection-change` 写、手机由卡片复选框写），
  **不要存行对象**——手机端没有表格实例，两套状态必然错位。
- `isMobile` 初值在 setup 时同步读 `matchMedia`，不能等 `mounted`，否则手机先闪一帧桌面布局。
- 视口高度写 `100vh` + 下一行 `100dvh`；触控下限 40px（`el-button.is-link` 例外放行）。

---

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/config` | 登录页公开配置：能否注册、是否开启密码找回、本次访问是否来自本机 |
| POST | `/api/auth/register` | 注册，**仅当系统还没有管理员时可用**（第一个账号即管理员） |
| POST | `/api/auth/login` | 登录，返回 JWT；**本机**且开启密码找回时会把管理员密码重设为本次输入 |
| GET | `/api/auth/me` | 当前用户与已用空间 |
| POST | `/api/auth/password` | 修改本人密码（需原密码），返回续期用的新 token |
| GET | `/api/users` | 用户列表，含各自已用空间（仅管理员） |
| POST | `/api/users` | 新增用户（仅管理员；可带 `role` / `quotaBytes`） |
| PATCH | `/api/users/:id/password` | 重置他人密码（仅管理员），该账号登录态立即失效 |
| DELETE | `/api/users/:id` | 删除账号（仅管理员），级联清除其文件 / 分享 / 发布记录 |
| GET | `/api/files?parent=` | 列目录 |
| POST | `/api/files/upload` | 整文件上传（multipart，字段 `file`、`path`） |
| POST | `/api/uploads/init` | 建分片上传任务（含秒传判定） |
| POST | `/api/uploads/:id/chunk` | 上传分片（multipart，字段 `index`、`file`） |
| GET | `/api/uploads/:id` | 查询已收到的分片 |
| POST | `/api/uploads/:id/complete` | 合并分片并入库 |
| DELETE | `/api/uploads/:id` | 取消上传 |
| POST | `/api/files/mkdir` | 新建目录 |
| GET | `/api/files/:id/download` | 下载（支持 `?token=`） |
| DELETE | `/api/files/:id` | 删除 |
| POST | `/api/files/batch-delete` | 批量删除（`ids`，≤200；部分失败在 `failed` 里回名称） |
| GET | `/api/mounts` | 资源库全部节点（扁平，含 `kind` / `parentId`，前端拼成树） |
| POST | `/api/mounts` | 新建节点（`kind` = FOLDER / DIR / FILE） |
| PATCH | `/api/mounts/:id` | 重命名 / 移动（`parentId`）/ 可见范围（`visibility`、`grants`） |
| DELETE | `/api/mounts/:id` | 移除节点（逻辑文件夹会连带其子项，只删记录） |
| POST | `/api/mounts/batch-delete` | 批量移除（`ids`，≤200；任一项无权则整体 403，`removed` 含子项） |
| GET | `/api/mounts/grantable-users` | `PROTECTED` 授权名单可选用户（全部用户的 id / username / role） |
| GET | `/api/mounts/:id/browse?sub=` | 浏览真实磁盘目录（仅 DIR 节点） |
| GET | `/api/mounts/:id/download?sub=` | 下载（DIR 需 `sub`；FILE 节点可省略） |
| GET | `/api/mounts/fs/roots` | 选择器可选起点（仅限有权发布的用户） |
| GET | `/api/mounts/fs/list?path=` | 列举服务端磁盘目录，逐次校验是否越界 |
| POST | `/api/shares` | 创建分享（文件或目录） |
| PATCH | `/api/shares/:id` | 重设 / 清除提取码（仅创建者；传空即取消） |
| GET | `/api/shares` | 我创建的分享（回显提取码明文，其他人拿不到） |
| GET | `/api/s/:code` | 公开查看分享信息（含 `kind`） |
| GET | `/api/s/:code/download?accessCode=` | 公开下载单文件 |
| GET | `/api/s/:code/archive/plan` | 目录打包预检（文件数 / 大小 / 限额 / 是否建议后台打包） |
| GET | `/api/s/:code/archive` | 目录打包下载（流式 ZIP，小目录） |
| POST | `/api/s/:code/archive/jobs` | 建后台打包任务（大目录） |
| GET | `/api/s/:code/archive/jobs/:id` | 查询打包进度 |
| GET | `/api/s/:code/archive/jobs/:id/file` | 下载打包结果（支持 Range 续传） |
| DELETE | `/api/s/:code/archive/jobs/:id` | 取消打包任务 |
| GET | `/api/health` | 健康检查（含 `version`；诊断字段仅本机可见，见下） |
| GET | `/api/version` | 当前部署的版本号与打包时间（公开，无需登录） |

批量删除的两个共同约定：`ids` 去重、上限 200（超了就 400，不做静默截断）；
父子集合先去重，**按 relPath 长度 / 节点深度降序删**（自关联是 `NoAction`，不级联）；
任一项越权则整体 403 且一项都不删；真正删的时候允许部分失败，失败项在响应里回名称。

### `/api/health` 为什么不返回路径和 pid

健康检查是**公开接口**，任何人都能访问。它早期会把 `pid`、启动时间、存储根目录、日志路径一起返回，
等于对外公布服务器的目录布局、进程号与运行时长（后者能推断重启和补丁周期）。现在做了分级：

- **普通请求**（含所有外部来源）：只回 `{ ok, version, time }`
- **来自本机的请求**：额外附上 `pid` / `startedAt` / `uptimeSec` / `node` / `storageRoot` / `logFile` / `webDist`

本机判定复用 `utils/request.ts` 的 **fail-closed** 实现：只看 TCP 对端地址是否为回环，
**请求里带任何转发头（`X-Forwarded-For` / `X-Real-IP` / `Forwarded`）就一律不算本机**。
所以在 nginx 反向代理部署下，所有请求的 TCP 来源都是 `127.0.0.1`，本机能识别的只剩「连代理也假装不了」
这一条 —— 该部署会稳定地只给最小集合，不会「悄悄放行所有人」。要在那种部署下看诊断信息，
直接在服务器上 `curl 127.0.0.1:3000/api/health`。

`/api/version` 同理，只放「这个包是什么」，运行时状态已收进 health 且仅本机可见。
两个接口都带 `Cache-Control: no-store`。

所有接口都认 `X-Locale` 请求头（`zh*` / `en*`），决定**报错信息**用哪种语言返回；
不带头时看 `Accept-Language`，都没有则中文。

---

## 安全设计

- **目录穿越防护**：所有用户传入路径都经 `safeJoin()` 校验，解析后必须仍在根目录内，否则 403
- **软链接防护**：`resolveInside()` 会 `realpath` 展开链接后再校验一次——指向挂载点内部的链接
  正常访问原始文件，指向外部的（symlink / Windows junction）一律 403，浏览时也不列出。
  **根内放行、根外拦截**是刻意的口径，不是「一律拒绝」
- **发布目录互斥**：新增目录发布时会检查与已有目录是否存在包含关系，避免同一批文件在资源库里出现两次
- **选择器范围收敛**：磁盘选择弹窗只能浏览 `MOUNT_ALLOWED_ROOTS` 之内的路径，
  且**每一次列举请求都重新校验**——顺着软链接跳到范围外会被当场拒绝；只对有权发布的用户开放
- **逻辑树不可越界**：移动节点时会拒绝「移到自己或自己的子孙下」，防止把树拧成一个环
- **上传隔离**：分片临时目录的 `uploadId` 只取自数据库记录，不直接用请求参数拼路径；
  非本人任务一律返回 404
- **分片参数服务端兜底**：前端给的分片大小会被夹到 `[MIN_CHUNK_SIZE, MAX_CHUNK_SIZE]`，
  分片数超过 `MAX_CHUNKS_PER_TASK` 时自动放大分片；同一用户并发分片数超过
  `MAX_CONCURRENT_CHUNKS` 返回 429。前端不可信，服务端必须自己挡住内存峰值
- **越权校验**：上传文件与分享严格比对 `userId`；磁盘发布的读权限按可见范围判定
  （管理员豁免、父级收紧则子树一并收紧），看不见时一律回 404 而非 403，不泄露存在性；
  改名 / 移动 / 移除 / 改可见范围限发布者本人或管理员，发布动作受 `MOUNT_CREATE_ROLE` 控制
- **密码**：bcrypt 加盐哈希，不存明文
- **改密即踢下线**：JWT 载荷里带 `tokenVersion`，鉴权时与库里的值比对，不相等即 401。
  改密、重置、删除账号都会作废该账号此前签发的全部令牌；鉴权时 `role` 也以数据库为准，降权立即生效
- **账号管理边界**：用户管理接口全部挂在 `adminGuard` 下；删除账号时禁止删自己、
  禁止删掉最后一个管理员，且「检查 + 删除」在同一事务内，防止并发把管理员删空；
  新建账号的唯一性校验同样放在事务里；删库后另清 `storage/users/<id>`
- **密码找回限本机**：`ALLOW_ADMIN_RESET_PASSWORD=true` 时，重设密码只接受来自回环地址
  （127.0.0.1 / ::1）的请求，非本机一律按普通密码错误回绝；判定只看 TCP 对端地址、不看任何请求头，
  **且只要请求带了 `X-Forwarded-For` / `X-Real-IP` / `Forwarded` 就一律不算本机**——
  所以伪造转发头和「前面挂了反向代理」两种情况都会 fail-closed（拒绝），不会误放行
- **分享**：提取码、过期时间、下载次数三重限制，可随时删除失效；目录打包预检同样要求提取码，
  避免分享链接变成目录探测器。提取码**加密入库**（见下），创建者在「我的分享」里可以随时看到原文
- **打包限额**：`ZIP_MAX_FILES` / `ZIP_MAX_TOTAL_BYTES` / `ZIP_MAX_DEPTH` 三重上限，超出直接 413；
  并发数与单分享节流防止反复点击把 CPU 和磁盘打满
- **JWT 密钥不会退回硬编码值**：优先用 `.env` 里的 `JWT_SECRET`；没配、或者还是模板里的占位值
  （`please-change-this-secret` / `dev-secret-please-change`）时，读 `<运行目录>/.jwt-secret`，
  没有就随机生成 48 字节写进去（权限 0600，已进 `.gitignore`），启动时会打印提示。
  所以**任何情况下都不会用一个人人皆知的密钥**——那个值一旦公开，任何人都能签出管理员令牌。
  打包脚本首次生成 `.env` 时也会写入随机密钥，重打包会保留
- **CORS 默认关闭**：前后端同源（开发靠 Vite 代理、生产共用一个端口）根本不需要跨域，
  所以**默认不注册 CORS 插件**，接口只接受同源请求。只有显式配置 `CORS_ORIGINS` 白名单才启用，
  且是精确匹配；写 `*` 时强制放弃携带凭证（浏览器不允许两者并存）。
  原来「反射任意来源 + 允许携带凭证」的写法已彻底移除
- **请求体限额分两层**：全局 `BODY_LIMIT` 默认 **1MB**，只约束 JSON 这类会被 Fastify
  **整个缓冲进内存**的请求体；multipart 的上传路由单独放宽到 `MAX_UPLOAD_SIZE`，
  并另有逐请求的分片大小限制。既堵掉「一个巨大的 JSON 打出内存尖峰」，又不会误伤大文件上传
- **限流**：全局 `RATE_LIMIT_MAX`（默认 1200/分）；**登录与注册**压到 `RATE_LIMIT_LOGIN_MAX`
  （默认 **10 次 / 5 分钟**）——这是全项目唯一靠猜就能拿到权限的入口；整目录打包这类高开销公开接口
  单独限额（`RATE_LIMIT_ARCHIVE_MAX`）。限流**不启用 `trustProxy`**，`req.ip` 取的就是 TCP 源地址，
  与上面「本机判定」保持同一套 fail-closed 口径。超限统一回 429 + `Retry-After`，文案跟着界面语言走
  - **例外是刻意留的**：分片上传与可续传下载这两类路径**显式关掉了**按请求数限流。
    一次上传天然是成百上千个分片请求；一次下载是按 4MB 一段顺序发 Range，1GB 的文件就是 256 个请求，
    在千兆局域网下一分钟就超过任何合理的阈值——按请求数限流只会先打到正常用户头上。
    它们的边界交给别的手段：分片大小与在途并发上限、单文件大小上限、下载次数上限
  - 限流桶按路由分开且累计，测边界要用全新进程，别在同一个实例上反复试
  - `errorResponseBuilder` **必须返回 `Error` 对象**，返回普通对象会变成 500 + `[object Object]`
- **提取码在库里是密文，且能反复回显**：提取码需要能随时回来看（发出去之后过几天还得再抄一次），
  所以**不能只存哈希**。落库前用 AES-256-GCM 加密，格式是自描述的
  `v1:<盐>:<iv>:<认证标签>:<密文>`（全 base64url）：
  - **每条记录独立随机盐**（16 字节），再加 HKDF-SHA256 派生该条记录专用的数据密钥。
    同一个提取码在库里得到完全不同的密文，彩虹表失效，一条记录被攻破也不牵连其他记录
  - 密钥链两层：`.env` 里的 **`ACCESS_CODE_KEY`**（可以填一句 ≥8 字符的口令，启动时先过 scrypt
    拉高爆破成本，进程内只算一次）→ 主密钥 → 每条记录的盐 → 记录密钥。
    盐在**加密前**就参与派生，而不是拼接在密文后面
  - GCM 的认证标签保证完整性：密文被改一个字节，解密直接失败，不会得到一段"看起来合法"的垃圾，
    因此不需要额外挂 HMAC
  - 明文**只在两个地方出现**：创建/重设的那一瞬间，以及创建者自己读「我的分享」时由服务端解密后返回。
    公开接口（`GET /api/s/:code`）只回 `needAccessCode`，`accessCode` 恒为 `null`；其他用户也拿不到
  - 密钥换了怎么办：库里旧码解不开时，列表里会标 `accessCodeBroken`，校验接口回 500 并明确说
    「无法解密」，用 `PATCH /api/shares/:id` 重设即可恢复（分享本身不受影响）。
    所以 **`ACCESS_CODE_KEY` 必须与 `.env` 一起备份，且不要和 `dev.db` 放在同一份备份里**
  - 升级前写入的明文提取码：读取端按有无 `v1:` 前缀兼容，第一次被**正确**校验通过后顺手加密回库
    （懒迁移，不需要停机跑脚本）
  - 另外补上了长度约束：**4–64 位、拒绝控制字符**，创建时自动 trim。老代码是
    `body.accessCode || null`，能设成 `"1"`——库泄露后这种码不用爆破，看一眼就出来了
- **提取码防爆破**：按 `IP|分享code` 统计**失败**次数（校验成功即清零），默认连续错 8 次后拒绝
  10 分钟（`ACCESS_CODE_MAX_FAILS` / `ACCESS_CODE_WINDOW_SECONDS`）。之所以不直接用路由级限流：
  正常浏览一次分享要发好几个请求（预检、建打包任务、轮询进度、Range 下载），按请求数限流会先把
  正常用户挡在门外，而真正要防的只是「同一个人对着一个分享反复猜」。实现在
  `utils/guard.ts` 的 `FailureThrottle`；提取码比对走 `crypto.timingSafeEqual` 定长比较，
  不会因为「前几位猜对了」而暴露时序差异
- **安全响应头**：`@fastify/helmet` 统一加上 CSP、`X-Content-Type-Options: nosniff`、
  `X-Frame-Options: DENY`、`Referrer-Policy: no-referrer` 等。CSP **没有沿用默认策略**，
  而是按本项目实际形态逐条写死（见下）
- **文件与目录名统一校验**：`POST /api/files/mkdir`、`POST /api/files/upload`、
  `POST /api/uploads/init` 三处入口共用 `utils/fs.ts` 的 `assertSafeName()`。目录穿越本身由
  `safeJoin` 挡着，但名称还会被拼成 `relPath` 存进数据库，之后所有查找、下载、删除都按它来 ——
  所以这里收紧到「真能在磁盘上原样存在的单段名称」：路径分隔符、`< > : " | ? *` 等非法字符与控制字符、
  系统保留名（`NUL` / `CON` / `COM1`…，含 `NUL.txt` 这种带扩展名的写法）、首尾空格与尾点
  （Windows 会**悄悄裁掉**再落盘，Linux 不会，两边就会对不上）、超过 255 字节，一律拒绝。
  **是报错而不是静默改写**：把用户输入的空格悄悄 trim 掉，建的就和界面显示的不是一个名字了，
  更难排查。`mkdir` 还改成只递归建**父目录**、目标严格建一层——早先 `recursive: true`
  配上带分隔符的名字会一口气建出多级，而数据库只登记最后一层，中间几层成了看不见也删不掉的孤儿目录；
  同名文件则回 409

### 安全响应头（helmet）

本项目是 Vite 构建的单页应用，产物只有一个外链 module 脚本 + 一个外链 CSS，页面里没有内联脚本、
没有内联事件处理器、没有 `eval`、没有 Web Worker、没有 blob URL——所以 CSP 可以收得很紧：

```
default-src 'self'; base-uri 'self'; object-src 'none';
script-src 'self'; script-src-attr 'none';
style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self' data:;
connect-src 'self'; form-action 'self'; frame-ancestors 'none'
```

三处**刻意**的取舍，改之前先看清楚：

1. **`style-src` 必须留 `'unsafe-inline'`**。它同时兜住 CSP3 的 `style-src-attr`，
   而 Vue 的 `:style`、Element Plus 的定位样式写的都是元素的 style **属性**。
   去掉不是「稍微丑一点」，是布局直接散架。
2. **HSTS 跟着 TLS 开关走**。配了 `TLS_CERT`/`TLS_KEY` 就下发 `max-age=<HSTS_MAX_AGE>`
   （默认 180 天），没配就关掉。纯 HTTP 下发 HSTS 会把站点锁死，浏览器在 max-age 到期前
   根本不会听服务端的 HTTP。以前这里是写死 `false`、靠文档提醒「上完 HTTPS 记得改回来」，
   现在由代码自己判断，少一处迟早会漏的人为约定。
3. **`upgrade-insecure-requests` 同理按条件加**：纯 HTTP 部署下它让页面里所有请求被升级成 HTTPS
   从而全部失败；HTTPS 下它只是兜底（前端全是同源相对路径，正常情况下不会触发）。

另外 `frameguard: deny`、`referrerPolicy: no-referrer`、`crossOriginResourcePolicy: same-origin`
都保持开启；`crossOriginEmbedderPolicy` 关闭（它是为 `SharedArrayBuffer` 这类特性准备的，
本项目用不上，开着反而给引入任何跨源资源埋雷）。

---

## HTTPS 与证书

服务端**自己终结 TLS**，不需要在前面挂 nginx，端口也不变。开关是 `.env` 里的两项：

```ini
TLS_CERT=certs/server.crt
TLS_KEY=certs/server.key
```

两项都填才启用；**只填一项直接启动失败**，不会静默退回 HTTP——那种「以为开了、其实在明文跑」
的故障最难发现。路径相对运行目录，也能写绝对路径；文件不存在同样启动即失败。

**没有证书就生成一张自签的**：

```bash
node tools/gen-cert.mjs
```

它会读运行目录下的 `cert-hosts.conf`（和 `.env` 同一个层级，每行一个域名或 IP），写什么就签什么；
该文件不存在或全是注释时，退回自动收集本机所有 IPv4 与主机名。`127.0.0.1`、`localhost`、`::1`
无论配不配都自动写进 SAN，本机永远能直接访问 `https://localhost:3000` 而不用输 IP。
生成到 `certs/`，并把两行配置自动写进 `.env`。需要系统里有 `openssl`，Windows 上随 Git 一起装。
命令行还能临时追加 `--host 名字`、`--config 其它文件`、`--auto-ip`（配置之外再并入网卡 IP）。

实现上的两个坑：浏览器只认 SAN、不认 CN（老客户端才看 CN），所以配置里写的东西必须全进 SAN，
CN 只取第一个域名；`::1` 必须写成 `IP:::1` 而不是 `DNS:::1`，否则签出来的证书对它无效。

自签证书浏览器一定会警告，这是预期的。要消除警告，就把 `certs/server.crt` 导入客户端系统的
受信任根证书区；只是内部临时用，点「高级 → 继续前往」也能进。

### 服务器 IP 会变怎么办

证书校验的是**URL 里的名字**，不是机器的身份。把 IP 写死进 SAN，DHCP 一换地址就报
「证书与域名不匹配」，只能重签，每台客户机还得重新信任一次。按省事程度有三种做法：

**1. 把 IP 固定住（首选）**。路由器里给服务器网卡做 DHCP 静态租约／地址保留，或服务器设静态 IP。
零改动，证书和客户端都不用碰。

**2. 固定域名 + 客户机 hosts**。域名不用注册、不用公网 DNS，自己起一个不冲突的即可。
把域名写进 `cert-hosts.conf`（一行一个），或直接：

```bash
node tools/gen-cert.mjs --host se.internal
```

每台要访问（**包括打开分享链接**）的客户机加一行：

```
<服务器当前IP>    se.internal
```

- Windows：`C:\Windows\System32\drivers\etc\hosts`（管理员权限）；Linux/macOS：`/etc/hosts`（sudo）
- 访问 `https://se.internal:3000`；hosts 不带端口，端口仍写在 URL 里
- 之后 IP 再变**只改这一行**：证书不用重签、客户端不用重新导入、HSTS 绑的是域名也不受影响
- **别用 `.local`**：RFC 6762 把它保留给 mDNS，系统会走组播解析而不读 hosts。
  推荐 `.internal`（ICANN 2024-07-29 决议永久保留给私用）或 `.home.arpa`（RFC 8375），
  也可以用自己持有的公网域名的子域
- 浏览器开了「安全 DNS / DNS over HTTPS」时可能绕过 hosts，遇到解析失败先关掉该选项
- 手机改 hosts 不方便、机器多时维护成本高 → 改在内网 DNS（路由器 dnsmasq / AdGuard Home）里，
  客户机零配置，IP 变了只改一处
- 分享链接由 `location.origin` 拼出，用域名访问时链接里就是域名；收链接的人也必须能解析这个名字

**3. 自建本地 CA**。坚持用 IP 访问时的兜底思路：签一张长期 CA 根证书，客户机只导入一次，
之后 IP 变了用同一把 CA 重签服务器证书即可，客户端无感。当前工具生成的是单张自签证书
（`CA:FALSE`），需要自行扩展。

顺带的好处：`navigator.clipboard` 在非安全上下文里是 `undefined`（见 `web/src/utils/clipboard.ts`），
上了 HTTPS 之后「复制分享链接」才会走原生 API 而不是 `execCommand` 兜底；
抽样指纹依赖 `crypto.subtle`，也只在 localhost 或 HTTPS 下可用，否则自动跳过秒传。

为什么值得上：下载链接把 token 放在 URL query 里，明文传输可被嗅探。
配好证书后 HSTS 与 `upgrade-insecure-requests` 会自动打开，**不用再手动改代码**。

启停、回退到 HTTP、上线前检查清单这些操作步骤在 [README 的「启用 HTTPS」](README.md#启用-https可选)。

---

## 进程守护、日志与打包

### `.bat` 里没有逻辑

那些双击脚本只是「找 node → 调 `tools/ctl.mjs` → pause」三行。真正的实现在 `tools/` 下的
三个 `.mjs` 里：可读、可改、能单独用 node 跑起来验证；`ecosystem.config.json` 由
`tools/setup.mjs` 在每次启动时按当前位置生成，所以整个目录可以随便移动。

放在 `.bat` 里的逻辑在本机是跑不起来的（cmd.exe 被策略禁用），这条约束别回退。

### 保活策略

（在 `ecosystem.config.json` 里可调）：

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| `autorestart` | 开 | 进程退出后 3 秒自动拉起 |
| `exp_backoff_restart_delay` | 200ms | 反复崩溃时指数退避，不会把 CPU 和日志刷爆 |
| `max_restarts` | 20 | 连续不稳定重启超过这个次数就停下来，不再无脑拉 |
| `max_memory_restart` | 1G | 内存超限自动重启，防止长时间运行越吃越多 |
| `kill_timeout` | 8s | 先走优雅退出（关 HTTP → 断数据库），超时才强杀 |
| `exec_mode` | fork / 1 实例 | SQLite 只允许一个写进程，**绝不能用 cluster** |

### 单实例：端口就是互斥量

已有实例在跑时，新进程会在 `listen` 阶段拿到 `EADDRINUSE`，打一条明确提示后以退出码 2 终止——
不会出现两个进程抢同一个 SQLite。

### 开机自启：登录后 vs 开机即启

默认是「登录后启动」而不是「开机即启」，这样进程拥有你自己的文件访问权限，
磁盘发布挂载本机目录才不会因为权限问题读不到。想改成开机即启（无人登录也跑），
把 `tools/ctl.mjs` 里 `schtasks` 的 `/sc onlogon` 换成 `/sc onstart /ru SYSTEM`，需要管理员权限。

**打包分发时不要把 `.pm2/` 和 `logs/` 一起带上**——那是运行期状态，`.gitignore` 已经排除。

### 日志实现

主日志由应用自己写（`server/src/utils/logger.ts`），**跟着进程走而不是跟着守护方式走**：
开发时 `npm run dev:server`、手工 `node server/index.js` 一样会落盘。
实现上直接接管 `console`，所以进程里任何地方（包括框架内部）的输出都会进文件，不用逐处改造。

pm2 那两个文件被守护进程一直持有句柄，Windows 上**无法从外部截断或改名**（实测 `EPERM`），
所以给了一条 `clean-logs.bat`：先停服释放句柄 → 删文件 + 按 `LOG_KEEP_DAYS` 裁主日志 → 自动重启。

> 顺带记两个试过不通的路：`max_size` / `retain` 是 **pm2-logrotate 模块**的参数、pm2 本体不认；
> 把 `out_file` 指向 `NUL` 也不行——Windows 只把**裸文件名** `NUL` 当设备，pm2 传的是绝对路径，
> 结果真在目录里创建了一个 8.7MB、名叫 `NUL` 的实体文件。

### 打包脚本

`scripts/build.mjs` 一个文件干完：编译后端（tsc）、构建前端（vite）、拷模板与文档、装生产依赖
（仅离线包）、预建库、拷 Node 运行时、写 `VERSION` / `build-info.json`、压 zip。

- **ZIP 写入器是自己写的**（store 模式，零外部依赖），不调用 `powershell` / `zip` / `tar`，
  三条命令在不同机器上是否可用、参数是否一致，都不影响打包结果
- **前端产物目录探测顺序**：`WEB_DIST` → `./public` → `../public` → `../web/dist`，
  找到就托管，找不到就只当 API 服务跑（开发模式的行为）。未命中的 `/api/*` 一律返回 JSON 404，
  只有不带扩展名的路径才回退到 `index.html` 交给前端路由
- **清理旧产物用的 `rmrf()` 带降级**：`fs.rmSync` 在 Windows 上偶发超时（被回收站接管时更慢），
  失败就把目录改名挪成 `.trash-<时间戳>` 再继续，不让一次清理失败卡死整个打包
- **离线包的三步是「包内再装一次」**：`npm install --omit=dev` → `prisma generate` + `db push` 预建库
  → 拷贝 Node 运行时。包内没有 `package-lock.json`，npm 要全量解析依赖树，**网络一差就会静默挂死**
  （实测 29 分钟无进展），所以脚本注入了 `npm_config_registry`（默认官方源，可用环境变量覆盖）+
  `prefer_offline` + 较短的 fetch 超时；改这段之前先看一眼注释
- **`.env` 是打包的输入**：首次打包自动生成（含随机 `JWT_SECRET` 与 `ACCESS_CODE_KEY`），
  重打包会先读旧的再写回，所以升级部署不会换密钥
- **体积**：0.2.0 实测目录 289MB、压缩包 104MB（`node.exe` 占 83MB，是压缩包主体）；
  压缩这一步视磁盘速度约 1~3 分钟

### 存储布局与扩容

磁盘发布能看到的范围就是 `MOUNT_ALLOWED_ROOTS`。想接第二块盘，按推荐程度有三种做法：

**① 把新的物理位置直接加进白名单（推荐，零技巧、零风险）**

```env
MOUNT_ALLOWED_ROOTS=<安装目录>\Download;E:\media;F:\movie
```

选择器里会多出 `E:\media`、`F:\movie` 两个起始根，能力和 Download 完全一样。
不依赖任何 Windows 技巧，白名单语义也保持完好。

**② 把整个 Download 换成指向大容量磁盘的目录联接（junction）**——适合「一块盘用满了换一块」

```bat
:: 先把原 Download 的内容挪到新盘，再把 Download 本身变成指向它的链接
robocopy "<安装目录>\Download" "E:\se-download" /E /MOVE
mklink /J "<安装目录>\Download" "E:\se-download"
```

之后落进 Download 的文件实际都写在 E 盘，程序端**不需要改任何配置**。
`mklink /J` 建的是 NTFS 目录联接，**普通用户即可创建，不需要管理员权限、也不需要开开发者模式**
（`mklink /D` 符号链接才需要）。升级重打包时注意别把这个目录覆盖掉。

**③ 只把 Download 下的某个子目录指到别的盘**（如 `Download\movies` → `E:\movies`）

```bat
mklink /J "<安装目录>\Download\movies" "E:\movies"
```

⚠️ **这种做法在本项目里默认会被拦住，而且拦得对**：链接指向根之外的路径一律判为越界
（`isEscapeLink` / `isMountPathAllowed`），选择器里根本不显示这个入口，手敲路径也是 403。
这是刻意的安全设计，不是 bug。要用它必须把**链接的真实目标**也加进白名单：

```env
MOUNT_ALLOWED_ROOTS=<安装目录>\Download;E:\movies
```

（或者直接 `MOUNT_ALLOWED_ROOTS=*` 彻底不限制——只建议在完全互信的机器上用。）

**顺带：网页上传的文件（个人文件库）走的是另一条路**

它落在 `STORAGE_ROOT`（默认 `<运行目录>/storage`，开发时是 `server/storage`，打包后是安装目录下的
`storage`），**完全不受上面的白名单约束**，所以扩容更省事——直接把 storage 搬到大盘即可：

```env
STORAGE_ROOT=E:\se-storage
```

或保持默认路径、改成链接（适合不想动配置的场合）：

```bat
robocopy "<安装目录>\storage" "E:\se-storage" /E /MOVE
mklink /J "<安装目录>\storage" "E:\se-storage"
```

> Windows 没有「把两个目录合并成一个视图」的原生能力——资源管理器里的「库」只是视图层，对程序无效，
> `subst` 只能把路径映射成盘符。真要**把多块物理盘合成一个卷**，得用「存储空间」（Storage Spaces）
> 或磁盘管理里的跨区卷；代价是一块盘损坏会波及整个卷，RAID 才是更稳的选择。

---

## 下一版可以做

- [x] 分片上传 / 断点续传 / 秒传
- [x] 下载断点续传（Range + 流式落盘）
- [x] 分片策略（三档预设自动推导，不暴露数字输入框）
- [x] 目录分享与打包下载（流式 ZIP，含压缩档位与限额）
- [x] 超大目录的后台打包任务（异步生成 + 断点续传）
- [x] 一键打包 / 离线包（自带 Node 运行时与依赖，断网可用）
- [x] 进程守护与保活（pm2 托管、日志落盘、开机自启、单实例）
- [x] 版本号（语义版本 + 打包时刻，界面 / 日志 / 接口三处可查）
- [x] 更新日志（`CHANGELOG.md` 随包分发，每次发版记录改动）
- [x] 用户管理（新增账号 / 重置密码 / 删除，含角色与配额；本人可改密码，改密即踢下线）
- [x] 界面国际化（中英双语，前端文案与后端错误提示一起切，含对齐自检脚本）
- [x] 手机端适配（≤1023px：侧栏抽屉化、列表卡片化、弹窗自适应、触控目标 40px 起）
- [x] 批量操作与列表搜索
- [ ] 回收站与彻底删除
- [ ] 已有账号的配额调整与禁用 / 启用
- [ ] 操作审计日志
- [ ] Docker 一键部署（postgres + nginx）
