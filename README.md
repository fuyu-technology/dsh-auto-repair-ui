# auto-repair · 大肥鱼自愈守护

自动诊断并修复大肥鱼（DeepSeek Harness）常见故障的独立守护进程。

## 为什么它不是 DSH 插件

因为 **DSH 自己起不来的时候，插件也加载不了**。

而「起不来」恰恰是最需要自动修的那一类 —— 本插件最初要解决的就是
`package.json` 被写入 UTF-8 BOM 导致 DSH 启动即崩的问题。
所以它必须活在 DSH 进程树之外，和 `supervisor` / `watchdog` / `port-guard` 一样独立常驻。

## 快速使用

```powershell
node D:\大肥鱼\auto-repair\auto-repair.mjs            # 常驻巡检（每 30s 一轮）
node D:\大肥鱼\auto-repair\auto-repair.mjs --once     # 跑一轮就退出
node D:\大肥鱼\auto-repair\auto-repair.mjs --check    # 只诊断不修复，输出 JSON
node D:\大肥鱼\auto-repair\auto-repair.mjs --models   # 列出「让 AI 修」可选的模型/提供方
node D:\大肥鱼\auto-repair\auto-repair.mjs --set-model '{"provider":"minimax","model":"MiniMax-M3"}'
node D:\大肥鱼\auto-repair\auto-repair.mjs --get-model   # 看当前选的是哪个（空 = 跟随 DSH 默认）
node D:\大肥鱼\auto-repair\auto-repair.mjs --scan-clients # 扫本机装了哪些模型客户端（TRAE / MiniMax）
node D:\大肥鱼\auto-repair\auto-repair.mjs --set-client '{"id":"minimax","path":"D:\\...\\MiniMax Code.exe","launch":true}'
node D:\大肥鱼\auto-repair\auto-repair.mjs --agent <code>       # 手动把某条交给 AI（不投喂标记）
node D:\大肥鱼\auto-repair\auto-repair.mjs --agent <code> --auto  # 自动升级：投喂并标【自动投喂·自愈面板】
```

## 它能修什么

| 代码 | 触发条件 | 动作 | 级别 |
|---|---|---|---|
| `BOM_CRASH` | DSH 崩溃日志显示 JSON 解析失败，且找到带 BOM 的文件 | 剥 BOM → 校验 JSON → 重启 DSH | 自动 |
| `LATENT_BOM` | profile 里的 json/yaml 带 BOM 但还没崩 | 剥 BOM（**不重启** DSH） | 自动 |
| `BRIDGE_DOWN` | 3100 没在监听 | 拉起桥接 | 自动 |
| `BRIDGE_DSH_STALE` | 桥接 `dshReady=false`（DSH 端口漂移后不会自愈） | 重启桥接以重新对齐 baseUrl | 自动 |
| `MCP_PATCH_MISSING` | bundle 层少了 MCP client 注册（QQ 工具挂不上） | 补回 bundle + profile 两层注册 | 自动 |
| `MCP_PROFILE_BACKUP_MISSING` | profile 层热备被 DSH 写回抹掉（不影响运行） | 补回 profile 层 | 自动 |
| `MCP_CLIENTS_DOWN` | DSH 在跑但三个 MCP client 进程都不在（连续 >3 分钟） | **不修**，只上报（要重启 DSH，会打断你） | 人工 |
| `DSH_DEAD` | DSH 进程完全不在 | **不修**，只上报 | 人工 |
| `DSH_NO_PORT` | 进程在但没监听端口 | **不修**，只上报 | 人工 |
| `BRIDGE_WS_DOWN` | OneBot 在线但 WS 连不上 | **不修**，只上报 | 人工 |
| `QQ_OFFLINE` | QQ 未登录（OneBot 3000/3001 未监听） | **不修**，只上报 | 人工 |

**为什么有些故障不自动修**：能自动修的都是「确定是这个问题、且修了不会更糟」的。
`DSH_DEAD` 可能是你主动关的；`QQ_OFFLINE` 是外部状态，等 QQ 登录就好 ——
这类情况擅自动手只会打断你。

## 三重安全阀

1. **白名单** —— 只有 `FIXERS` 里登记过的 code 才允许修，未知 code 一律只上报
2. **备份** —— 改任何文件前先备份成 `xxx.auto-repair.bak-<时间戳>`
3. **频次限制** —— 同一 code 在 30 分钟内最多修 N 次（见 `MAX_PER_WINDOW`），
   防止「修不好 → 反复修」的循环

另外：剥离 BOM 后会**校验 JSON 合法性**，不合法直接放弃，绝不写坏文件。

## 先插件、后模型

巡检的处理顺序是阶梯式的，**插件能修的绝不拉模型**：

1. 有修复器且策略允许 → 插件直接修，修好即结束，不建会话、不烧额度
2. 修失败，或没有修复器 → 才升级给模型：新建 DSH 会话，把报错原文投喂进去
3. 面板上每条问题会标「插件已修复」或「已升级给模型（模型名）」

投喂有三道闸：`autoFeed` 开关（默认开，关掉只展示不投喂）、报错特征哈希 + 30 分钟去重
（账本 `state/feed-state.json`）、配置类问题（缺 Key / 路由未启用 / 模型不存在）只提示不投喂。
提示词全文硬上限 3000 字，开头标 `【自动投喂·自愈面板】` —— DSH 没有「只填输入框不发送」的接口，
所以是直接发出去。

## 通知渠道

按顺序降级，任一成功即止：

1. **需求箱**（`http://127.0.0.1:3200`）—— 本地留言箱，UI 里能看到
2. **QQ 私聊** ownerQQ —— 通过 OneBot HTTP API 发消息
3. **Windows 通知气泡** —— toast
4. **日志** —— 永远有

日志位置：
- `D:\大肥鱼\auto-repair\state\auto-repair.log` —— 巡检日志
- `D:\大肥鱼\auto-repair\state\repair-history.jsonl` —— 每次修复的记录
- `D:\大肥鱼\auto-repair\state\repair-counter.json` —— 频次计数

## 开机自启

由 `supervisor.mjs` 保活 —— supervisor 本身由启动文件夹的 `.vbs` 拉起。
supervisor 每分钟巡检一次，auto-repair 掉了会立刻补回来。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTO_REPAIR_INTERVAL_MS` | `30000` | 巡检间隔 |

## 目录结构

```
auto-repair/
├─ auto-repair.mjs    # 主程序：巡检循环、单实例锁、CLI 入口
├─ diagnose.mjs       # 诊断（只读，无副作用，可放心随时跑）
├─ repair.mjs         # 修复执行（白名单 + 备份 + 频次限制）
├─ models.mjs         # 「让 AI 修」用哪个模型：目录读取 + 选择落盘（不存密钥）
├─ providers.mjs      # 提供方 API 地址 / Key 状态（Key 明文交给 DSH 凭据存储，这里只留尾 4 位）
├─ clients.mjs        # 本机模型客户端发现（TRAE / MiniMax）+ 可选关联启动
├─ notify.mjs         # 通知（需求箱 → QQ → toast 逐级降级）
└─ state/             # 日志、计数、pid 锁
```

## 已踩过的坑（重要）

**同一次巡检里 BOM 被剥了两次，把 `{` 一起吃掉了。**

`BOM_CRASH` 和 `LATENT_BOM` 可能指向同一个文件。两个都修就会连剥两次，
文件变成 `"name": ...`，DSH 报 `Unexpected non-whitespace character after JSON`。

现在有两道防护：
- `stripBomIfPresent()` **动手前重新读字节**确认 BOM 还在，不信调用方的旧判断
- `diagnoseAll()` 按文件去重，同一文件只保留严重度最高的结论

改这个插件时，**不要绕过这两道防护**。

## 关于 BOM 的根因

PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，而 DSH 的 `JSON.parse` 不剥 BOM。
以后用 PowerShell 改 JSON，一律用：

```powershell
[IO.File]::WriteAllText($p, $json, (New-Object Text.UTF8Encoding($false)))
```

---

## 关于「QQ 桥接掉了」的根因（2026-11-02）

AI 说「这个会话里 qq_* 那一套工具一个都没挂上」「我能调用的工具还是只有『提问』和『待办』两个」，
不是她瞎说，也不是桥接挂了 —— 是 **DSH 把 MCP 工具注册整段抹掉了**。

### 发生了什么

DSH 的设置界面每次保存设置时，会重写 profile 的 `cordis.patch.yml`，
而它**只写自己管理的行**（`ui-*`、`agent-default-model` 等）。
任何由外部脚本维护的行 —— 也就是三个 MCP client 的 `- insert:` 注册 —— 都会被顺手抹掉。

时间线（`~/.dsh/profiles/desktop/cordis.patch.yml`）：

| 时间 | 文件大小 | 状态 |
|---|---|---|
| 07:22:40 之前 | 2257 B | 完整，含 `=== qq-bridge MCP BEGIN/END ===` 区块 |
| 07:22:40 | 1052 B | 区块被整段抹掉（那次正好在改 agent 的模型设置） |
| 修复后 | 2469 B | 两层都在 |

抹掉之后，QQ 会话里 `mcp__snowluma__*` 全没了，只剩 `ask_user_question` 和 `todo_write` ——
正好对上她说的「只有提问和待办两个」。

### 根治：注册下沉到 bundle 层

DSH 的 patch 分层（从下往上）：bundle 层 → profile 层 → `~/.dsh/cordis.patch.yml`（家目录层）→ `--patch` 覆盖。
**只有 profile 层会被写回**，bundle 层 DSH 只在启动时读、永远不重写。

所以 MCP 注册现在写两份：

| 层 | 文件 | 角色 |
|---|---|---|
| bundle | `qq-bridge/plugins/qq-agent-presets/bridge.patch.yml` | **权威来源**，免疫写回 |
| profile | `~/.dsh/profiles/desktop/cordis.patch.yml` | 热备，DSH 写回时可能被抹掉 |

活证据：`qq-chat` / `qq-chat-v2` 两个 preset 本来就在 bundle 层，
profile 被重写之后 preset 依然生效。

两层同时存在时 DSH 按 id 去重（`EntryGroup.update` 用 `Object.fromEntries` 收敛），只会跑一份。

### 工具表在哪看

会话的 `request/header` 事件带**完整工具清单**（这是判断「插件能不能用」最硬的证据）：

```powershell
node D:\大肥鱼\qq-bridge\tools\probe-qq-session-tools.mjs
```

它会开一个 `qq-chat-v2` 会话、读它的 `request/header`、打印 MCP 工具数，然后归档该会话。

修复前后实测：

| | 工具总数 | MCP 工具 |
|---|---|---|
| 故障时（07:22） | 2 | 0 |
| 修复后（07:52） | 62 | 60 |

---

## DSH 插件面板（dsh-auto-repair-ui）

面板**只负责"看"和"手动触发"**，真正的修复逻辑仍然留在外部守护进程里。
原因：DSH 起不来的时候插件也加载不了，而"起不来"正是最需要自动修的一类故障。

- 宿主侧：`dsh-auto-repair-ui/index.js`（注册 4 个路由，挂在 `webServer` 上）
- 客户端：`dsh-auto-repair-ui/client.js`（注册 `settings.section` 插槽，id=`auto-repair`，标签「自愈」）
- 面板挂载点：DSH → 左下角账号菜单 → 设置 → 左侧导航「自愈」

API 前缀 `/dsh-auto-repair`：`/status`、`/diagnose`、`/repair`（POST）、`/history`。

### 主题令牌坑（白底白字）

面板原本把主按钮写成 `background: var(--dsw-alias-brand-primary); color: #fff`，
在赛博红主题下 brand-primary 是**红色**、在默认主题下是**白色**，
于是出现"白底白字"——按钮存在但看不见。

正确写法是**成对使用** DSH 自己的令牌，让主题负责前景/背景对比：

```css
background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #5b8cff));
color: var(--dsw-alias-label-primary-foreground, #fff);
```

DSH 自家 primary 按钮的写法就是这一对（见 `assets/index-*.css` 的 `._primary_*`）。

### 改完 client.js 必须重启 DSH

DSH 把所有插件的 client 打包成**一个带 rev 哈希的内存 bundle**，磁盘改了不会热生效
（`dsh-client-hmr` 也不覆盖这个场景）。改完 `client.js` 必须重启 DSH：

```
node D:\大肥鱼\restart-dsh.mjs 2
```

该脚本会自动：杀 DSH → 重开 → 探新端口 → 改 `qq-bridge/config.json` 的 baseUrl → 重启桥接。

## 工具（tools/）

| 脚本 | 作用 |
| --- | --- |
| `dsh-session.mjs` | 铸造 DSH 浏览器会话 Cookie（`--mint` 打印；`--serve <port> <target>` 起注入页） |
| `install-plugin.mjs` | 把源目录同步到 `~/.dsh/plugins/dsh-auto-repair-ui`，**强制校验无 BOM** |
| `install-dsh-plugins.mjs` | 双插件幂等安装器（文件同步 + package.json + pnpm-lock + junction + 反向校验） |
| `verify-panel.mjs` | 一键验收：根页面 / 面板 API / 部署件 / 桥接 / 状态摘要 |
| `check-plugins.mjs` | **全链路健康检查**：profile 完整性 → 插件落地 → 路由/服务探活 → 历史工具调用统计 → 崩溃对比 |
| `list-plugins.mjs` | 生成全部插件清单 markdown（解析 asar 内各 bundle 的 `cordis.patch.yml` + 各包 `locale/zh.json`） |
| `scan-session-tools.mjs` | 统计历史会话里的真实工具调用（哪个工具、成功还是失败） |
| `mcp-registration.mjs` | **MCP 注册的单一权威来源**：两层补丁的规范文本 + 幂等补回函数 |
| `fix-profile-patch.mjs` | 补回 MCP 注册（bundle 权威层 + profile 热备层），幂等、无 BOM、写前备份 |
| `asar-read.mjs` | 纯解析 app.asar header 读包内文件（不需要 asar 工具） |

桥接侧的两个探针：

| 脚本 | 作用 |
|---|---|
| `qq-bridge/tools/probe-qq-session-tools.mjs` | 开一个 qq-chat-v2 会话，读它 `request/header` 的工具清单并打印，跑完自动归档 |
| `qq-bridge/tools/session-tools.mjs` | 按 session id 精确定位会话文件、逐轮导出工具数变化（复现「修复前后同一会话」的对照） |

`node tools\verify-panel.mjs <dsh端口>`（DSH 端口每次重启都会变，先用 netstat 查）。

### 健康检查（推荐日常先跑这个）

```powershell
node D:\大肥鱼\auto-repair\tools\check-plugins.mjs
```

它会自己从 `qq-bridge/config.json` 的 `dsh.baseUrl` 取当前 DSH 端口（端口漂移不用手查），
自动铸 Cookie，然后跑完 5 层检查。**退出码非 0 表示有失败项。**

其中「历史会话工具调用」那层最有说服力：它解压 `~/.dsh/sessions/**/session.v4.jsonl.zstd`
（zstd 压缩的 JSONL，事件 `type` 用斜杠分隔，如 `tool/call` / `tool/result`，
错误标记在 `data.message.isError`），统计每个工具真实被调了多少次、失败多少次。
这是「插件到底能不能用」的直接证据，比看启用状态可靠得多。

### 浏览器里打开 DSH 设置页

DSH 的 Web UI 需要 `dsh-auth-<base64url(sha256(authority))>` Cookie。
进程启动 token 只存在内存不可推导，但 `~/.dsh/.credentials.yaml` 里有**持久化**的
`client-connection/browser-session` 签名密钥，可以离线 HMAC 铸造：

```
name  = 'dsh-auth-' + base64url(sha256(authority))
body  = base64url(JSON{version, authority, issuedAt, expiresAt})
value = 'v1.' + body + '.' + base64url(HMAC-SHA256(secret, body))
```

注入方式（Cookie 按 host+path 匹配、**不含端口**，所以同机不同端口可共用）：

```
node tools\dsh-session.mjs --serve 5199 http://127.0.0.1:<dsh端口>/
# 浏览器打开 http://127.0.0.1:5199/  → 写 Cookie → 跳转 DSH
```