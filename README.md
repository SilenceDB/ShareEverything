<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

# ShareEverything

把服务器磁盘上的文件发布出来，通过 Web 分享给局域网 / 其他电脑，带用户鉴权。

- 后端：**Fastify + TypeScript + Prisma + SQLite**
- 前端：**Vue3 + Vite + Pinia + Element Plus**
- 形态：单端口部署（后端托管前端）、pm2 托管 + 开机自启、可打成一键运行的离线包

主要能力（账号与权限、磁盘发布、分享链接、分片上传 / 续传、目录打包、批量与搜索、手机适配、中英双语）
见下方[功能速查](#功能)；每个按钮怎么用见 [FEATURES.md](FEATURES.md)。

## 我该看哪一节

| 你想做的事 | 去这里 |
| --- | --- |
| 有哪些能力，一眼看全 | [功能](#功能) |
| 界面里每个按钮在哪、限制是什么 | [FEATURES.md](FEATURES.md) |
| 在本机跑起来开发 / 试用 | [本地开发](#本地开发源码运行) |
| 打成安装包，拷到别的机器上跑 | [打包](#打包) |
| 已经拿到 `dist/` 或 zip 包，怎么装怎么启 | [部署](#部署安装包的用法) |
| 启动 / 停止 / 看日志 / 开机自启 | [启动、停止与状态](#启动停止与状态) |
| 把 HTTP 换成 HTTPS | [启用 HTTPS](#启用-https可选) |
| 要改代码 / 想知道为什么这么实现 | [DESIGN.md](DESIGN.md) |

---

## 功能

四个区域，各管一段：**磁盘发布**把磁盘上已有的目录映射进来，**文件库**是网页上传的个人空间，
两者都能生成**分享链接**给不需要登录的人；**用户管理**管账号与配额。

| 区域 | 一句话 | 谁能改 |
| --- | --- | --- |
| 磁盘发布 | 映射本机磁盘上已有的目录 / 文件，不复制原文件 | 发布者本人 + 管理员 |
| 文件库 | 网页上传的个人空间，占个人配额（默认 2GB） | 仅本人 |
| 我的分享 | 生成带提取码 / 有效期 / 次数上限的公开链接 | 创建者本人 |
| 用户管理 | 开通账号、重置密码、调配额 | 仅管理员 |

能力一览：

| 能力 | 说明 |
| --- | --- |
| 账号与权限 | 第一个注册的账号即管理员，之后由管理员开通；**改密即刻踢下线** |
| 可见范围 | 所有人 / 仅自己 / 指定用户；父级收紧则整棵子树一并收紧 |
| 分片上传 | 大于 8MB 自动分片，断点续传、刷新后继续、秒传、暂停继续；分片大小按三档策略自动推导 |
| 可续传下载 | 4MB 分段流式落盘，可暂停 / 继续；不支持的浏览器回退到原生下载 |
| 目录打包 | 流式 ZIP 不落临时文件，三档压缩；大目录转后台任务，完成后可续传下载 |
| 分享链接 | 提取码、有效期、下载次数上限；公开页也能切中英文 |
| 批量与搜索 | 勾选后批量删除 / 取消发布（上限 200 项），按名称过滤当前列表 |
| 手机 / 平板 | ≤1023px 收成汉堡抽屉 + 卡片列表，功能一个不少 |
| 中英双语 | 前端文案与后端错误提示一起切，`npm run check:i18n` 自检 |

每个按钮在哪、每个选项干什么、边界与限制（含管理员忘密码的应急通道），见 **[FEATURES.md](FEATURES.md)**。

---

## 本地开发（源码运行）

```bash
# 1. 安装依赖（npm workspaces，一次装完前后端）
npm install

# 2. 建配置文件
copy server\.env.example server\.env      # Windows
# cp server/.env.example server/.env      # macOS / Linux

# 3. 初始化数据库（SQLite，自动生成 dev.db）
npm run db:push

# 4. 启动（后端 3000，前端 5173）
npm run dev
```

打开 `http://localhost:5173`，**第一个注册的账号自动成为管理员**。

也可以分开启动：

```bash
npm run dev:server
npm run dev:web
```

开发模式没有 `VERSION` 文件，界面上的版本显示为 **dev** —— 刻意区别于任何一次发布包，
免得把本地开发误当成某个历史版本。

---

## 打包

### 怎么打包

在**源码目录**（`ShareEverything/`，就是有 `package.json` 的那层）执行：

| 命令                      | 产出                                            | 适用场景                             |
| ----------------------- | --------------------------------------------- | -------------------------------- |
| `npm run pack`          | `dist/` + `release/*-offline-*.zip`（约 104MB）  | **默认**：目标机器断网、没装 Node，双击就能跑      |
| `npm run pack:offline`  | 同上（显式写法，便于脚本里表明意图）                             | 同上                               |
| `npm run pack:dir`      | 只有 `dist/` 目录，不压缩                             | 本机迭代验证，省掉压包那 1~3 分钟              |
| `npm run pack:standard` | `dist/` + `release/*.zip`（约 2MB）              | 对方能联网、愿意自己 `npm install`          |

> 以前 `npm run pack` 出的是标准包，现在**默认改成离线包**了。要标准包请显式用 `pack:standard`。

产物结构：

```
dist/
  server/        后端编译后的 JS，入口 server/index.js
  public/        前端构建产物，由后端直接托管
  prisma/        schema.prisma（离线包还含预建好的 dev.db）
  package.json   生产依赖
  .env           首次打包自动生成（含随机 JWT_SECRET 与 ACCESS_CODE_KEY），重打包会保留
  VERSION        本次发布的版本号（语义版本+打包时刻，如 0.2.0+2026.10.17.2244）
  build-info.json  版本号 + 打包时间 + 打包模式 + Node 版本
  CHANGELOG.md   这一版改了什么（随包分发）
  LICENSE        Apache-2.0 许可全文
  start.bat / start.sh / 运行说明.md
  cert-hosts.conf  自签证书要签的域名 / IP（改完跑 tools/gen-cert.mjs）
  node/          离线包才有：自带 Node 运行时
  node_modules/  离线包才有：已装好的生产依赖 + Prisma 引擎
```

打包脚本自带 ZIP 写入器（store 模式，零外部依赖），不调用 `powershell` / `zip` / `tar`，
所以三条命令在不同机器上是否可用、参数是否一致，都不影响打包结果。

**`.env` 是打包的输入**：第一次打包会生成一套随机密钥，之后每次重打包都会读旧的再写回。
所以升级部署时**必须把旧包里的 `.env` 拷到新包**，否则 JWT 密钥和提取码密钥全换，
所有人都被踢下线、已有提取码全部解不开。

### 版本号：语义版本 + 打包时刻

版本号是**两段拼起来的**，形如 `0.2.0+2026.10.17.2244`：

- `+` 之前是**语义版本**，来自根 `package.json` 的 `version`，人工维护、每次对外发版递增，
  与 [`CHANGELOG.md`](CHANGELOG.md) 的一条记录一一对应 —— 回答「这是哪一版、改了什么」看的是它。
- `+` 之后是**打包时刻**（年.月.日.时分），只是 build metadata。同一版本改一行重打也能区分是哪个包，
  又不会把 `version` 炒成每次都不一样（那样依赖比对和升级判断就乱了）。

写进三处，三者始终一致：

| 位置 | 形式 | 给谁看 |
| --- | --- | --- |
| `dist/VERSION` | `0.2.0+2026.10.17.2244` | 人和外部脚本，单行纯文本 |
| `dist/build-info.json` | 同上，另有 `appVersion` / `build` / 打包时间 / 模式 / Node 版本 | 程序读（要单独取某一段就拆字段，别 parse 字符串） |
| `dist/package.json` 的 `version` | `0.2.0` | npm 生态，只放语义版本 |

压缩包名里用紧凑形式 `share-everything-offline-20261017-1435.zip`，其中的时刻与上面的号一一对应；
同一分钟内重复打包会自动补上秒，不会把刚打出来的包覆盖掉。

运行时想看当前跑的是哪个版本，三个地方都能看到：

- 界面**侧边栏左下角**、登录页底部
- 启动日志第二行：`版本: 0.2.0+2026.10.17.2244（2026-10-17 22:44:56 打包）`
- `GET /api/version`（公开，无需登录）；`GET /api/health` 里也带 `version` 字段

### 离线包（默认，`npm run pack`）

目标机器**什么都不用装、不用联网**：依赖、Prisma 引擎、Node 运行时、建好表的 SQLite 库全部在包里。
比标准包多了三步：在包内 `npm install --omit=dev` → `prisma generate` + `db push` 预建库 → 拷贝 Node 运行时。

体积参考（0.2.0 实测）：目录 **289MB**，压缩包 **104MB**（`node.exe` 占 83MB，是压缩包的主体）。
压缩这一步比较慢（几千个小文件 + 80MB 的 node.exe），视磁盘速度约 1~3 分钟；
只要目录不要压缩包的话用 `npm run pack:dir` 更快。

---

## 部署（安装包的用法）

把 `dist/` 整个目录（或解压后的 zip）拷到目标机器。

**离线包：直接双击 `start.bat`**（Linux / macOS 跑 `./start.sh`），没有其他步骤——
不需要 `npm install`，也不需要 `npm run db:push`。启动脚本会优先使用包内自带的 Node。

**标准包：**

```bash
cd dist
npm install        # 装生产依赖（含 pm2），postinstall 会自动 prisma generate
npm run db:push    # 建表，生成 prisma/dev.db
```

之后每次**双击 `start.bat`** 就行，不用再敲命令。Linux / macOS 用 `./start.sh`。

首次启动后浏览器打开 `http://localhost:3000`，第一个注册的账号自动成为管理员。
改端口编辑 `.env` 里的 `PORT`，重启生效。

**注意**：标准包要求目标机器装 **Node 20 或更高版本**（`node -v` 可查）；离线包不需要，
Node 运行时已经在包里了。

**生产环境前后端共用一个端口**（默认 3000），不需要 Nginx 反代，也不存在跨域。

**升级已有部署**：解压新包 → 把旧包的 **`.env`、`prisma/dev.db`、`storage/`** 拷到新包
→ 双击 `start.bat`（先 `stop.bat` 停掉旧的）。这三样是运行期数据，不在压缩包里。

---

## 启动、停止与状态

服务由 **pm2** 托管，**关掉命令行窗口不影响它**。

### 双击脚本

产物目录里那些脚本就是它的操作面板：

| 双击 | 作用 |
| --- | --- |
| `start.bat` | 启动（已在跑就跳过，不会起第二个） |
| `status.bat` | 守护状态 + 探一次 HTTP 健康检查 |
| `logs.bat` | 实时跟随日志（Ctrl+C 退出） |
| `restart.bat` / `stop.bat` | 重启 / 停止 |
| `clean-logs.bat` | 清理 pm2 抓取的日志与超期日志后自动重启 |
| `autostart-on.bat` / `autostart-off.bat` | 注册 / 取消开机自启（需管理员权限） |

### 命令行

Linux / macOS 通用，Windows 下用包内的 `node`：

```bash
node tools/ctl.mjs start|stop|restart|status|logs|clean-logs|autostart on|off
```

### 日志

| 文件 | 说明 |
| --- | --- |
| `logs/app-YYYY-MM-DD.log` | **主日志**，按天滚动，保留最近 `LOG_KEEP_DAYS`（默认 14）天 |
| `logs/pm2-out.log` / `pm2-error.log` | pm2 抓的同一份控制台输出，内容与主日志重复 |

pm2 那两个文件被守护进程一直持有句柄，Windows 上无法从外部截断或改名，所以要清就用
`clean-logs.bat`（先停服释放句柄 → 删文件 + 裁主日志 → 自动重启）。

### 开机自启

默认是「登录后启动」而不是「开机即启」，这样进程拥有你自己的文件访问权限，
磁盘发布挂载本机目录才不会因为权限问题读不到。要改成无人登录也跑，见
[DESIGN：开机自启](DESIGN.md#开机自启登录后-vs-开机即启)。

### 常见问题

- **端口被占 / 起不来**：服务是单实例的，端口就是互斥量。已经有一个在跑时，新进程会拿到
  `EADDRINUSE` 并打印明确提示后退出——这不是故障，先用 `stop.bat` 停掉旧的
- **改了前端源码但界面没变**：要重新 `vite build`（`npm run pack` 会自己做），
  浏览器还可能缓存旧的 bundle，硬刷新一次
- **`.pm2/` 和 `logs/` 不要跟着包分发**：那是运行期状态，`.gitignore` 已经排除

---

## 启用 HTTPS（可选）

服务端自己终结 TLS，不需要在前面挂 nginx，端口也不变。开关是 `.env` 里的两项：

```ini
TLS_CERT=certs/server.crt
TLS_KEY=certs/server.key
```

两项都填才启用；**只填一项直接启动失败**，不会静默退回 HTTP——那种「以为开了、其实在明文跑」的
故障最难发现。路径相对运行目录，也能写绝对路径。

没有证书就生成一张自签的：

```bash
node tools/gen-cert.mjs
```

写什么就签什么：它读运行目录下的 `cert-hosts.conf`（和 `.env` 同一层，每行一个域名或 IP），
未配置时自动收集本机所有 IPv4 与主机名；`127.0.0.1`、`localhost`、`::1` 永远包含在内，
所以本机总能直接访问 `https://localhost:3000` 而不用输 IP。生成到 `certs/`，并把两行配置自动写进 `.env`。
需要系统里有 `openssl`（Windows 上随 Git 一起装）。

自签证书浏览器一定会警告，这是预期的。要消除警告，把 `certs/server.crt` 导入客户端系统的
受信任根证书区；临时用点「高级 → 继续前往」也能进。

**服务器 IP 会变怎么办**：优先把 IP 固定住（路由器里做静态租约）；固定不了就自己起个域名写进
`cert-hosts.conf`，客户机 hosts 加一行，IP 再变只改那一行。细节与为什么不能用 `.local`，见
[DESIGN：服务器 IP 会变怎么办](DESIGN.md#服务器-ip-会变怎么办)。

用上 HTTPS 之后注意三件事：

- 原来的 `http://` 链接会连不上——服务只监听一种协议，访问地址要改成 `https://`
- 浏览器会记住「这个主机必须走 HTTPS」。**要退回 HTTP，先把 `HSTS_MAX_AGE` 设成 `0` 并重启一次**，
  让浏览器收到 `max-age=0`；否则在到期前 http 访问会被强制升级，看起来就像站点挂了
- 不要把同一端口再用 HTTP 暴露出去，那等于给 HTTPS 留了个明文旁门

---

## 上线前检查清单

1. **`.env` 与数据库都要备份**，但 `.env` 里的 `ACCESS_CODE_KEY` **不要和 `dev.db` 放在同一份备份里**：
   丢了它，已有提取码全部解不开（分享还在，重设即可）；它和数据库一起泄露，加密就白做了
2. **上 HTTPS**（见上一节）。下载链接把 token 放在 URL query 里，明文传输可被嗅探
3. 确认 `ALLOW_ADMIN_RESET_PASSWORD=false`（只在管理员忘密码时临时打开，用完立刻关）
4. **用低权限账号启动服务**（Node 进程的权限就是磁盘发布能读到的边界）
5. **`storage/` 与 `prisma/dev.db` 定期备份**
6. 如果把前端部署到了别的域名，才需要配 `CORS_ORIGINS`；同源部署**保持不配**就是最严的状态

`JWT_SECRET` 不配也能安全运行——应用会自动生成并落盘到 `.jwt-secret`，
**不会退回到任何人人都知道的固定密钥**。

---

## 更多文档

| 文件 | 内容 |
| --- | --- |
| [FEATURES.md](FEATURES.md) | 功能详解：每个按钮在哪、每个选项干什么、边界与限制 |
| [DESIGN.md](DESIGN.md) | 目录结构、数据与权限模型、配额口径、上传/ZIP 实现、i18n 机制、接口一览、安全设计、进程守护与打包实现 |
| [CHANGELOG.md](CHANGELOG.md) | 每一版改了什么（随包分发） |
| [`.env.example`](server/.env.example) | 全部配置项与默认值的注释 |
| `运行说明.md` | 打包产物里的简版操作卡（随包分发） |
