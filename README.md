# dsh-auto-repair-ui

DeepSeek Harness 插件：把「自愈守护进程」搬进 DSH 设置页。装上以后左侧多一个 **自愈** 页签——守护进程在不在跑、当前诊断出什么问题、过去修过什么，一眼看到，也能手动触发一次修复。

> 面板只是**看**和**手动触发**。真正的修复逻辑在独立的守护进程里，不在 DSH 进程树内。
> 这是故意的：DSH 自己起不来的时候，插件也跟着加载不了——而「起不来」恰恰是最需要自动修的那一类。

## 功能

- 守护进程状态：是否存活、pid、巡检间隔
- 诊断结论：按 fatal / warn / info 分级展示，带证据
- 修复历史：最近修过什么、哪些没修成
- 手动触发一次修复（POST）
- **审批策略三档**：`manual` / `approve-all` / `reject-all`，决定自动修复要不要人点头（v1.1.0）
- **agentAssist 开关**：修不了的时候要不要交给 DSH agent 继续查（v1.1.0）
- **逐条处置**：单条修复、忽略、交给 AI（v1.1.0）
- **全部修复**：一次把所有能自动修的修完（v1.1.0）
- **AI 模型选择**：面板上直接选「让 AI 修」用哪个提供方/模型，已接入 MiniMax（v1.2.0）
- **自动投喂报错**：插件修不动的报错，自动送进选中模型的会话输入框；可关（v1.3.0）
- **路径可见**：每条问题标出「插件已修复」还是「已升级给模型」，不用猜（v1.3.0）
- **客户端发现**：扫描本机 TRAE / MiniMax 客户端，可选手动改路径与「关联启动」（v1.4.0）
- **API 地址与 Key**：面板上直接填 API Base URL / API Key，Key 只写进 DSH 凭据存储、只显示尾 4 位（v1.5.0）

## 本机模型客户端（v1.4.0）

面板新增「本机模型客户端」卡片：

| 能力 | 说明 |
|---|---|
| 自动扫描 | 注册表 Uninstall 项、开始菜单快捷方式、常见安装目录（Program Files / LocalAppData / Roaming），匹配 TRAE 与 MiniMax |
| 如实呈现 | 每项显示客户端名 + 实际 `.exe` 路径 + 「已安装 / 未检测到」；扫不到就写未检测到，不编路径 |
| 手动改路径 | 扫描错了或扫不到时可手填 `.exe` 完整路径，保存即校验（存在且是 `.exe`），立即生效；可「恢复自动」清掉手动值 |
| 关联启动 | 每项一个开关，默认关。勾上后，用该模型投喂报错前会先拉起对应客户端；不勾则与旧行为完全一致 |

设置存在 `<REPAIR_DIR>/state/clients.json`（只有路径和布尔开关，不含任何密钥），重启后保持。

provider 与客户端的映射：`minimax` / `minimax-cn` → MiniMax 客户端。`deepseek-account` 暂不映射（归属待定），
所以选它时不会额外拉起任何客户端。

## 自动投喂报错

守护进程的处理是一个阶梯，**能自己修的绝不拉模型**：

1. 有对应修复器、且策略允许 → 插件自己修。修好即结束，不建任何模型会话，不烧额度。
2. 修失败，或者压根没有修复器 → 才升级给模型：新建一个 DSH 会话，把报错原文投喂进去。
3. 面板上每条问题会标出这次走的是哪条路：「插件已修复」或「已升级给模型（模型名）」。

投喂的细节：

| 关注点 | 做法 |
|---|---|
| 开关 | 策略字段 `autoFeed`，默认开；关掉后只展示、不投喂。手动点「让 AI 修」不受它限制 |
| 只有一种能力 | DSH 的 `session/prompt` 没有「只填输入框不发送」，所以是直接发送；消息开头标 `【自动投喂·自愈面板】` |
| 截断 | 提示词全文硬上限 3000 字，超了截断并注明「完整内容见 state/auto-repair.log」 |
| 去重 | 按 `code + 级别 + 现象文本` 的特征哈希记账，30 分钟窗口内同一报错只投喂一次 |
| 配置问题 | 缺 Key、路由未启用、模型不存在 → 只提示不投喂（灌进去也只会再报一次） |

去重账本在 `<REPAIR_DIR>/state/feed-state.json`，路径记录在 `<REPAIR_DIR>/state/repair-outcomes.json`。

## AI 模型选择

面板的「AI 模型」卡片可以选下一次「让 AI 修」用哪个提供方/模型。选择结果写回
`<REPAIR_DIR>/state/model-choice.json`，下一次点「让 AI 修」时由 `agent-repair.mjs`
调 DSH 的 `sessions.selectModel` 应用到这个会话上——不是只存个下拉框的摆设。

没选过时跟随 DSH 自己的默认模型（`agent-default-model`），面板会标成「跟随 DSH 默认」。

选项来源：

- 优先读 DSH 的实时模型目录（`session/modelCatalog`）；
- DSH 连不上时回落到内置兜底清单，仍然只列真实存在的模型名（DeepSeek 来自 DSH 目录，
  MiniMax 来自 DSH 自带的 pi-ai 提供方目录），不编造模型。

目前可选：

| 提供方 | 模型 | 需要 Key |
|---|---|---|
| `deepseek-account` | `deepseek-flash`、`deepseek-v4-pro` | 否（DSH 账号已登录） |
| `minimax` | `MiniMax-M2.7`、`MiniMax-M2.7-highspeed`、`MiniMax-M3` | `MINIMAX_API_KEY` |
| `minimax-cn` | 同上（走 `api.minimaxi.com`） | `MINIMAX_CN_API_KEY` |

### MiniMax 接入方式

MiniMax 走 DSH 自带的 `@deepseek-ai/dsh-llm-pi-ai` 提供方，**没有新增第三方依赖**。
本插件自带的 `cordis.patch.yml` 已经在 **bundle 层**注册好这两条路由（插件升级后自动生效，
不需要手改 profile）：

```yaml
- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          minimax:
            apiKeyEnv: MINIMAX_API_KEY
            displayName: MiniMax
          minimax-cn:
            apiKeyEnv: MINIMAX_CN_API_KEY
            displayName: MiniMax 中国站
```

> 为什么不写进 `~/.dsh/profiles/desktop/cordis.patch.yml`：DSH 保存设置时会重写 profile patch
> 并抹掉它不管理的行（见 `auto-repair/README.md` 里「QQ 桥接掉了」的根因）。bundle 层只在启动时
> 读取、永不被写回，所以注册沉到插件的 `cordis.patch.yml`。

### MiniMax Key 填在哪

**密钥不进代码、不进仓库、也不进配置文件的明文里。** 三种方式任选：

1. 在 DSH 设置里配置凭据 `MINIMAX_API_KEY`（中国站 `MINIMAX_CN_API_KEY`）；
2. 写进 `~/.dsh/.credentials.yaml` 的 `refs` 下：

```yaml
refs:
  MINIMAX_API_KEY: <你的 MiniMax Key>
  # 中国站再补：MINIMAX_CN_API_KEY: <key>
```

3. 用同名 Windows 用户环境变量。

或者**直接在面板上填**（v1.5.0）：见下一节。

改完 profile 或凭据后**需要重启 DSH** 才会加载 MiniMax 路由。

缺 Key 时不会静默失败：模型选项会标「缺 Key」，面板会显示明确提示，
点「让 AI 修」也会在拉起会话前直接返回「需要 MINIMAX_API_KEY」的错误说明。

## API 地址与 Key（v1.5.0）

面板新增「API 地址与 Key」卡片，按提供方各给一组输入：

| 能力 | 说明 |
|---|---|
| API Base URL | 填了就用面板里的地址；留空回落到该提供方的默认地址（`minimax` → `https://api.minimax.io/anthropic`，`minimax-cn` → `https://api.minimaxi.com/anthropic`）。保存前校验协议/主机名，不合法直接给出原因 |
| API Key | 填了就用面板里的 Key；留空则不修改，沿用原有 `.credentials.yaml` / 环境变量 |
| 遮蔽显示 | 输入框是 `type=password`；已保存的只显示「已配置 · 尾号 abcd」，永不回显明文 |
| 清除 | 每个提供方一个「清除」按钮，删掉 DSH 凭据里的对应 ref，并清掉尾号记录 |
| 连通性 | 「测试连通」做一次 GET 探测（**不带 Key**，避免把密钥发到填错的地址）；能拿到任何 HTTP 状态码即视为可达，401/403 会说明「需要有效 Key」 |

**Key 存到哪**

- 明文只写进 DSH 自己的凭据存储：`~/.dsh/.credentials.yaml` 的 `refs` 段，
  由 `ctx.credentials.set(ref, value)` 写入，文件权限由 DSH 强制 `600`。
- 面板自己的记录在 `~/.dsh-auto-repair/provider-endpoints.json`，**只有地址 + 尾 4 位 + 设置时间 + 是否面板设置**，
  没有任何密钥明文；该目录**不在 git 仓库里**，也不写进 README 或日志。
- 权限：目录 `700`、文件 `600`；Windows 上额外用 `icacls` 去掉继承、只保留当前用户与 SYSTEM。
- 面板保存 Key 后 DSH 会收到凭据更新通知，下一次模型调用即生效，不用重启；路由本身没加载时才需要重启 DSH。

命令行等价物：

```bash
node auto-repair.mjs --providers          # 看地址 / Key 状态（不含明文）
node auto-repair.mjs --set-provider '{"id":"minimax","baseUrl":"https://api.minimaxi.com/anthropic"}'
node auto-repair.mjs --probe-provider '{"id":"minimax"}'
```

## 审批策略

面板顶部的「审批策略」区可以切换三档，选择结果写回 `<REPAIR_DIR>/state/repair-policy.json`：

| 档位 | 行为 | 适用场景 |
|---|---|---|
| `manual`（默认） | 只诊断、不动手；所有修复都要人点 | 生产环境，或想先看清结论再决定 |
| `approve-all` | 白名单内的故障自动修复，不需要逐条确认 | 自家机器，追求无人值守 |
| `reject-all` | 一律不自动修，只报警 | 排障期，或怀疑自动修复会干扰现场 |

策略文件由守护进程在每次巡检时读取，所以**切换后立即生效，不用重启 DSH**。

## agentAssist

`agentAssist` 管的是「自动修复失败之后怎么办」，默认**开启**：

- **开启**：白名单外的故障、或自动修复失败时，把问题交给 DSH agent 继续排查（面板上给出「交给 AI」入口）
- **关闭**：只记录、不拉起 AI，全部留给人工

在审批策略区用勾选框切换，对应策略文件的 `agentAssist` 字段。

## 逐条处置

每条诊断结论下方带操作按钮：

| 操作 | 作用 | 对应接口 |
|---|---|---|
| 修复 | 只修这一条 | `POST /repair-one` |
| 忽略 | 加入 `rejectedCodes`，不再自动修、也不再置顶 | `POST /ignore` |
| 交给 AI | 把这条丢给 DSH agent 会话接着修 | `POST /agent-assist` |

被忽略的问题会带「已忽略」标记，再点一次即可取消忽略。

## 全部修复

「全部修复」一次性把所有能自动修的故障修掉，修不了的会留在列表里等人工处置。

## 安装

```bash
dsh plugin --profile web add <你的安装源>
```

或本地开发安装（推荐先这样试）：

```bash
dsh plugin --profile web add link:/path/to/dsh-auto-repair-ui
```

装完重启 DSH，面板出现在：**DSH → 左下角账号菜单 → 设置 → 左侧导航「自愈」**。

## 宿主依赖

面板本身不含修复逻辑，需要另外跑一个伴生守护进程：

| 组件 | 说明 |
|---|---|
| `auto-repair.mjs` | 巡检 + 修复的执行体，**必须在 DSH 进程树之外**常驻 |
| 守护进程状态文件 | `<REPAIR_DIR>/state/auto-repair.pid` |
| 策略文件 | `<REPAIR_DIR>/state/repair-policy.json`（不存在时按默认策略处理） |
| 模型选择文件 | `<REPAIR_DIR>/state/model-choice.json`（只存 provider/model；不存在时跟随 DSH 默认） |
| 投喂去重账本 | `<REPAIR_DIR>/state/feed-state.json` |
| 路径记录 | `<REPAIR_DIR>/state/repair-outcomes.json`（插件修好的 / 升级给模型的） |
| 客户端设置 | `<REPAIR_DIR>/state/clients.json`（手动路径覆盖 + 关联启动开关） |

没有守护进程时，面板会显示「守护进程不在」——这是正常的，不是面板坏了。

策略与修复逻辑只有守护进程一份实现，面板只负责传参和展示，避免两边判定不一致。

## 配置

宿主侧路径可用环境变量覆盖（不设则用默认值）：

| 变量 | 含义 | 默认 |
|---|---|---|
| `REPAIR_DIR` | 自愈系统根目录 | `<你的 auto-repair 目录>` |
| `AUTO_REPAIR_INTERVAL_MS` | 巡检间隔（毫秒） | `30000` |

策略文件 `state/repair-policy.json` 字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `mode` | string | `manual` / `approve-all` / `reject-all` |
| `agentAssist` | boolean | 修不了时是否交给 DSH agent |
| `autoFeed` | boolean | 修不动时是否把报错自动投喂进模型会话（默认 `true`） |
| `rejectedCodes` | string[] | 逐条忽略过的故障 code |

面板写策略一律通过守护进程的 `--set-policy`，保证合并语义只在 `policy.mjs` 一处实现；
模型选择通过 `--set-model`，目录与可选模型只在 `models.mjs` 一处实现。

## API

宿主侧注册在 DSH 的 webServer 上，前缀 `/dsh-auto-repair`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-auto-repair/status` | 守护进程状态摘要 |
| GET | `/dsh-auto-repair/diagnose` | 跑一遍诊断，返回结论列表 |
| POST | `/dsh-auto-repair/repair` | 手动触发一次修复 |
| GET | `/dsh-auto-repair/history` | 修复历史与频次计数 |
| GET / POST / PUT | `/dsh-auto-repair/policy` | 读 / 写审批策略（`mode`、`agentAssist`、`autoFeed`） |
| GET / POST | `/dsh-auto-repair/models` | 读模型目录 / 切换「让 AI 修」用的模型（body: `provider`、`model`） |
| GET / POST | `/dsh-auto-repair/clients` | 扫描本机客户端 / 改路径或开关（body: `id`、`path`、`launch`） |
| GET / POST | `/dsh-auto-repair/providers` | 各提供方的 API 地址 / Key 状态；body: `id` + `baseUrl` / `apiKey` / `clearKey` / `probe` |
| POST | `/dsh-auto-repair/repair-one` | 修指定的单条（body: `code`） |
| POST | `/dsh-auto-repair/repair-all` | 修补所有可修项 |
| POST | `/dsh-auto-repair/agent-assist` | 把某条交给 AI（body: `code`） |
| POST | `/dsh-auto-repair/ignore` | 忽略 / 取消忽略（body: `code`、`ignored`） |

## 版本与兼容性

当前版本 **1.5.0**。

- 1.5.0 新增：「API 地址与 Key」卡片（按提供方填 Base URL / Key，Key 走 DSH 凭据存储，
  面板只显示尾 4 位，可清除，地址校验 + 不带 Key 的连通性探测），
  以及 `/dsh-auto-repair/providers` 接口与 `--providers` / `--set-provider` / `--probe-provider` 命令
- 1.4.0 新增：本机模型客户端自动扫描（注册表 / 开始菜单 / 常见目录）、手动路径覆盖、
  按客户端配置的「关联启动」开关；模型下拉默认停在「跟随 DSH 默认」，不再默认选中 deepseek
- 1.3.0 新增：`autoFeed` 自动投喂开关（默认开）、报错特征哈希 + 30 分钟去重、
  提示词 3000 字硬截断与 `【自动投喂·自愈面板】` 标记、配置类问题（缺 Key / 路由未启用）
  只提示不投喂，以及面板上的「插件已修复 / 已升级给模型」路径标记
- 1.2.0 新增：面板「AI 模型」选择、模型目录透传、MiniMax（`minimax` / `minimax-cn`）接入，
  以及 `/dsh-auto-repair/models` 接口；选择真正传进 `agent-repair` 的 `sessions.selectModel`
- 1.1.0 新增：审批策略三档、`agentAssist`、逐条处置、全部修复，以及上表中后 5 个接口
- 1.0.0 的行为相当于 1.1.0 手动模式：不自动修、不拉起 AI，只有状态 / 诊断 / 历史 / 手动修复
- 原有接口路径未变，属向后兼容的增量更新
- 依赖宿主守护进程支持 `--repair <code>`、`--repair-all`、`--agent <code> [--auto]`、`--set-policy`、
  `--models`、`--set-model`；宿主较旧时模型卡片会显示读不到目录，其余功能仍可用

## 许可

Apache-2.0 · 蝠羽科技

**允许二次修改与再分发（含商业用途），但不得更改制作方署名。**

- 许可证全文：[LICENSE](./LICENSE)
- 署名与二改规则：[NOTICE](./NOTICE)
- 源码文件头部已带 Copyright 2026 蝠羽科技 版权声明，二次修改时必须保留；
  依 Apache-2.0 第 4(c)、4(d) 条，衍生作品须保留全部版权与署名声明，
  并复制 NOTICE 中的署名内容。删除或改写署名即不再符合本许可。
- 二次修改者可以在保留原署名的前提下，额外标注自己的修改说明与版权声明。
