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

没有守护进程时，面板会显示「守护进程不在」——这是正常的，不是面板坏了。

策略与修复逻辑只有守护进程一份实现，面板只负责传参和展示，避免两边判定不一致。

## 配置

宿主侧路径可用环境变量覆盖（不设则用默认值）：

| 变量 | 含义 | 默认 |
|---|---|---|
| `REPAIR_DIR` | 自愈系统根目录 | `D:\大肥鱼\auto-repair` |
| `AUTO_REPAIR_INTERVAL_MS` | 巡检间隔（毫秒） | `30000` |

策略文件 `state/repair-policy.json` 字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `mode` | string | `manual` / `approve-all` / `reject-all` |
| `agentAssist` | boolean | 修不了时是否交给 DSH agent |
| `rejectedCodes` | string[] | 逐条忽略过的故障 code |

面板写策略一律通过守护进程的 `--set-policy`，保证合并语义只在 `policy.mjs` 一处实现。

## API

宿主侧注册在 DSH 的 webServer 上，前缀 `/dsh-auto-repair`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-auto-repair/status` | 守护进程状态摘要 |
| GET | `/dsh-auto-repair/diagnose` | 跑一遍诊断，返回结论列表 |
| POST | `/dsh-auto-repair/repair` | 手动触发一次修复 |
| GET | `/dsh-auto-repair/history` | 修复历史与频次计数 |
| GET / POST / PUT | `/dsh-auto-repair/policy` | 读 / 写审批策略（`mode`、`agentAssist`） |
| POST | `/dsh-auto-repair/repair-one` | 修指定的单条（body: `code`） |
| POST | `/dsh-auto-repair/repair-all` | 修补所有可修项 |
| POST | `/dsh-auto-repair/agent-assist` | 把某条交给 AI（body: `code`） |
| POST | `/dsh-auto-repair/ignore` | 忽略 / 取消忽略（body: `code`、`ignored`） |

## 版本与兼容性

当前版本 **1.1.0**。

- 1.1.0 新增：审批策略三档、`agentAssist`、逐条处置、全部修复，以及上表中后 5 个接口
- 1.0.0 的行为相当于 1.1.0 手动模式：不自动修、不拉起 AI，只有状态 / 诊断 / 历史 / 手动修复
- 原有接口路径未变，属向后兼容的增量更新
- 依赖宿主守护进程支持 `--repair <code>`、`--repair-all`、`--agent <code>`、`--set-policy`；宿主较旧时策略区会读不到数据，但状态、诊断、历史、手动修复仍可用

## 许可

Apache-2.0 · 蝠羽科技

**允许二次修改与再分发（含商业用途），但不得更改制作方署名。**

- 许可证全文：[LICENSE](./LICENSE)
- 署名与二改规则：[NOTICE](./NOTICE)
- 源码文件头部已带 Copyright 2026 蝠羽科技 版权声明，二次修改时必须保留；
  依 Apache-2.0 第 4(c)、4(d) 条，衍生作品须保留全部版权与署名声明，
  并复制 NOTICE 中的署名内容。删除或改写署名即不再符合本许可。
- 二次修改者可以在保留原署名的前提下，额外标注自己的修改说明与版权声明。
