# opencode 飞书通知插件

SSH 断开时，通过飞书应用机器人**私聊推送** opencode 的状态通知（基于 **OpenCode 2.x** 插件 API）。

| 事件（OpenCode 2.x） | 卡片 | 说明 |
|---|---|---|
| `session.execution.succeeded`（`session.idle` 兜底） | ✅ 绿色 | 一轮任务完成，含会话标题、目录、耗时 |
| `session.execution.failed` | 🔴 红色 | 会话出错，含错误信息 |
| `permission.asked` | 🟠 橙色 | Agent 等待你批准权限 |
| `form.created` | 🔵 蓝色 | Agent 有问题等你回答（2.0 用表单取代了 `question` 工具） |

- 过滤子 agent 会话（Task 工具产生的 session），只在主会话通知
- **智能模式**（`FEISHU_NOTIFY_WHEN=detached`）：只有“看不到这个会话”时才发飞书，否则只做本地终端提示（判定见下文）
- 采用 OpenCode 2.x 插件 API：`export default Plugin.define({ id, setup(ctx) })`，事件用 `ctx.event.subscribe({ signal })` 订阅
- TypeScript：`feishu-notify.ts`（插件）+ `detect.ts`（探测层）；除 opencode 运行时（`@opencode/plugin`）与 Node 内置模块外，无第三方依赖
- 发送失败只记日志，绝不影响 opencode 主流程

> **兼容性**：本分支对应 **OpenCode 2.x**。OpenCode 1.x 请使用仓库 `main` 分支上的旧实现。
> 2.x 插件运行在后台服务进程里，stdout 指向 `/dev/null`，因此本地提示（智能模式下人在跟前时）改为把 OSC 9 / bell 序列写入 TUI 的 pty。

## 部署

方式一（推荐，纳入 `opencode plugin update` 自动更新，需要 package.json）：

```bash
opencode plugin add 'github:zenanswer/oc_feishu_notify#opencode_v2'
```

方式二（本地源码迭代，symlink 到 `~/.config/opencode/plugins/feishu-notify.ts`）：

```bash
./install.sh
```

两种方式二选一，同时使用会导致插件重复加载、重复通知。

重启 opencode 生效。与 `opencode-terminal-bell-notifier` 可共存（本地终端响铃 + 断开后飞书推送）。

> **重要**：SSH 断开时插件要能发通知，opencode 进程必须存活。请在 **herdr**（或 tmux/screen）中运行 opencode。

## 飞书应用配置（一次性）

1. [open.feishu.cn](https://open.feishu.cn) → 开发者后台 → 创建**企业自建应用**
2. 「添加应用能力」→ 添加**机器人**
3. 「权限管理」开通：
   - `im:message:send_as_bot` — 以应用身份发私聊消息
   - `contact:user.id:readonly` — 通过手机号/邮箱查 open_id（直接配置 open_id 时可不开）
4. 确保应用**可用范围**包含接收人
5. 「版本管理与发布」→ 创建版本并发布
6. 「凭证与基础信息」复制 App ID / App Secret

## 环境变量

写入 `~/.bashrc`（或启动 opencode 的 shell 环境）：

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
# 接收人三选一（优先级：open_id > mobile > email）
export FEISHU_NOTIFY_MOBILE="+8613800138000"
# export FEISHU_NOTIFY_OPEN_ID="ou_xxx"
# export FEISHU_NOTIFY_EMAIL="you@company.com"
# 通知模式：always（默认，总是发送）| detached（推荐，仅"人看不到"时发送）
export FEISHU_NOTIFY_WHEN="detached"
# 本地键鼠空闲阈值：超过该秒数视为离开（默认 300，0 = 禁用该条）
# export FEISHU_PRESENT_IDLE_SEC="300"
# 读取 opencode “未读”状态前的等待（毫秒，默认 1000，避开与 TUI 的竞态）
# export FEISHU_VIEW_SETTLE_MS="1000"
# 关闭 opencode “未读”信号（默认开启）
# export FEISHU_UNREAD="0"
# 可选：
# export FEISHU_API_BASE="https://open.feishu.cn"  # 默认值
# export FEISHU_PROXY="http://proxy:3128"          # 出网需要代理时
```

## 智能模式（detached）的判定原理

“看不看得到”拆成两类信号：

- **presence（有人吗）**：本地 → 键鼠空闲；远程 → 复用器 attached
- **attention（在看这个页面吗）**：opencode 自身 `unread` + 复用器 attached

“本地 / 远程”与“是否在复用器里”是**正交**的（本地也可能套在 tmux/herdr/zellij 里），所以并列组合：

```
unread        = session.time.idle > session.time.viewed   # 该轮完成但 TUI 没确认（失焦 / 显示别的 tab）
inMux         = TUI 跑在 herdr/zellij/tmux 里
muxOk         = 所有检测到的复用器都“有人接着”（没检测到复用器时视为 true）
localSeat     = 本机有交互座席（键鼠空闲可测）
sessionRemote = 会话来自 ssh/远程（socket 反查对端进程）

任一命中即“看不到”（发飞书）：
    muxDetached = inMux && !muxOk                      # 终端被关 / 断开
    unread                                             # client 还连着，但没看这个会话（切了 tab）
    本地 (localSeat && !sessionRemote) 另加：
        muxOk && idleSec >= FEISHU_PRESENT_IDLE_SEC    # 人走开（远程测不到本机键鼠，故不参与）
```

| 信号 | 探测方式 |
|---|---|
| `unread` | 读 `session.time.idle/viewed`，`unread = idle > viewed`（或 viewed 缺失）。延迟 `FEISHU_VIEW_SETTLE_MS` 再读，避开与 TUI 的竞态 |
| 键鼠空闲（本地） | macOS `ioreg HIDIdleTime`；Linux `xprintidle` → D-Bus ScreenSaver → `loginctl IdleHint`。无座席/无头机测不到 → `undefined` |
| herdr attached | `herdr-client.sock` 是否有 accept（macOS `netstat -f unix`；Linux `ss -x`） |
| zellij attached | `zellij action list-clients` 是否有 client 聚焦本 pane（pane 级） |
| tmux attached | `#{window_active_clients}`（`TMUX_PANE` 所在 window，window 级；不依赖 `focus-events`） |
| 本地 / 远程 | **socket 反查对端进程**：accept 行的 `Conn` = 客户端 pcb → `lsof -U` 解析 PID → 祖先链找 `sshd`；解析不出 ⇒ 远程 |

要点与局限：

- **关终端 / 断开一定发**：检测到复用器（herdr/zellij/tmux）但没有 client 接着 → 无论人在不在键盘前，都发飞书。
- **切走也发（`unread`）**：client 还连着，但这条 opencode 会话跑完未被 TUI 确认（失焦 / 显示别的 tab）→ 发。
- **本地“人走开”**：复用器都接着时，本机键鼠空闲超阈值 → 发。**远程测不到本机键鼠**，故远程不参与 `idleSec` 判定（只能靠 `muxDetached` / `unread`）。
- **本地在场且在看**：以上都不命中 → 不发飞书，交给终端 bell 插件。
- **`unread` 与 `idleSec` 互补**：`unread` 是「注意力」（连着但没看），`idleSec` 是「人还在吗」（本地可测）。两者任一命中都会发。
- **远程无法感知“屏幕前有没有人”**：远端插件只能知道 client 是否 attached、在看哪个 pane。因此“client 仍 attached 但你人已离开笔记本”远程**无法**检测 → 不提醒（只能靠 detach/断连）。
- tmux 默认 `focus-events off`：`unread` 对 tmux 无效，但 tmux 走原生 `window_active_clients`，不受影响。
- zellij 不支持 1004 聚焦事件：`unread` 感知不到 zellij 切 tab，改用 `list-clients` pane 级。
- 嵌套复用器：所有检测到的复用器都 attached 才算 `muxOk`。
- 检测命令失败 / 判定异常：视为“看不到”（fail-open，宁发勿漏）。
- 本地“人在但长时间无键鼠”（看视频/开会）→ 判成离开照发。

缺少必需变量时插件自动禁用，加载时写入本地日志 `/tmp/opencode/feishu-notify.log`（`FEISHU_LOG` 可覆盖）。日志也记录每次决策（`decide present=... unread=... remote=... idleSec=... mux=...`）与发送结果；`FEISHU_DEBUG=1` 开详细日志。

## 开发 / 测试

```bash
node --test test/detect.test.ts   # 纯函数单测：判定表 / netstat / lsof / idle / env 解析
```

探测逻辑集中在 `detect.ts`（不依赖 `@opencode/plugin`，可直接用 `node` 运行）。

## 手动测试

```bash
# 1. 获取 token
TOKEN=$(curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"'$FEISHU_APP_ID'","app_secret":"'$FEISHU_APP_SECRET'"}' | jq -r .tenant_access_token)

# 2. 手机号查 open_id
curl -s -X POST "https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"mobiles":["'$FEISHU_NOTIFY_MOBILE'"]}'

# 3. 发测试卡片
curl -s -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"receive_id":"ou_xxx","msg_type":"interactive","content":"{\"config\":{\"wide_screen_mode\":true},\"header\":{\"template\":\"green\",\"title\":{\"tag\":\"plain_text\",\"content\":\"测试\"}},\"elements\":[{\"tag\":\"div\",\"text\":{\"tag\":\"lark_md\",\"content\":\"hello\"}}]}"}'
```

## 常见问题

- **99991672 权限错误**：应用未开通所需权限，或开通后未发布新版本
- **查不到 open_id**：接收人不在应用可用范围内
- **收不到消息**：确认应用已发布版本、接收人曾在飞书中能看到该机器人（搜索应用名）
