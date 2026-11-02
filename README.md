# dsh-auto-repair-ui

DeepSeek Harness 插件：把「自愈守护进程」搬进 DSH 设置页。装上以后左侧多一个 **自愈** 页签——守护进程在不在跑、当前诊断出什么问题、过去修过什么，一眼看到，也能手动触发一次修复。

> 面板只是**看**和**手动触发**。真正的修复逻辑在独立的守护进程里，不在 DSH 进程树内。
> 这是故意的：DSH 自己起不来的时候，插件也跟着加载不了——而「起不来」恰恰是最需要自动修的那一类。

## 功能

- 守护进程状态：是否存活、pid、巡检间隔
- 诊断结论：按 fatal / warn / info 分级展示，带证据
- 修复历史：最近修过什么、哪些没修成
- 手动触发一次修复（POST）

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

没有守护进程时，面板会显示「守护进程不在」——这是正常的，不是面板坏了。

## 配置

宿主侧路径可用环境变量覆盖（不设则用默认值）：

| 变量 | 含义 | 默认 |
|---|---|---|
| `REPAIR_DIR` | 自愈系统根目录 | `D:\大肥鱼\auto-repair` |
| `AUTO_REPAIR_INTERVAL_MS` | 巡检间隔（毫秒） | `30000` |

## API

宿主侧注册在 DSH 的 webServer 上，前缀 `/dsh-auto-repair`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-auto-repair/status` | 守护进程状态摘要 |
| GET | `/dsh-auto-repair/diagnose` | 跑一遍诊断，返回结论列表 |
| POST | `/dsh-auto-repair/repair` | 手动触发一次修复 |
| GET | `/dsh-auto-repair/history` | 修复历史与频次计数 |

## 许可

MIT · 蝠羽科技
