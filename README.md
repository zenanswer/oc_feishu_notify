# opencode 飞书通知插件

SSH 断开时，通过飞书应用机器人**私聊推送** opencode 的状态通知（基于 **OpenCode 2.x** 插件 API）。

| 事件（OpenCode 2.x） | 卡片 | 说明 |
|---|---|---|
| `session.execution.succeeded`（`session.idle` 兜底） | ✅ 绿色 | 一轮任务完成，含会话标题、目录、耗时 |
| `session.execution.failed` | 🔴 红色 | 会话出错，含错误信息 |
| `permission.asked` | 🟠 橙色 | Agent 等待你批准权限 |
| `form.created` | 🔵 蓝色 | Agent 有问题等你回答（2.0 用表单取代了 `question` 工具） |

- 过滤子 agent 会话（Task 工具产生的 session），只在主会话通知
- **智能模式**（`FEISHU_NOTIFY_WHEN=detached`）：人在终端前（herdr/zellij/tmux attached）只靠终端 bell，断开/离开后才发飞书
- 采用 OpenCode 2.x 插件 API：`export default Plugin.define({ id, setup(ctx) })`，事件用 `ctx.event.subscribe({ signal })` 订阅
- 单文件 TypeScript；除 opencode 运行时（`@opencode/plugin`）与 Node 内置模块外，无第三方依赖
- 发送失败只记日志，绝不影响 opencode 主流程

> **兼容性**：本分支对应 **OpenCode 2.x**。OpenCode 1.x 请使用仓库 `main` 分支上的旧实现。
> 2.x 插件运行在后台服务进程里，stdout 指向 `/dev/null`，因此本地提示（智能模式下人在跟前时）改为把 OSC 9 / bell 序列写入 TUI 的 pty。

## 部署

```bash
./install.sh   # symlink 到 ~/.config/opencode/plugins/feishu-notify.ts
```

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
# 本地裸终端在场阈值：键鼠空闲超过该秒数视为离开（默认 300，0 = 禁用在场检测）
# export FEISHU_PRESENT_IDLE_SEC="300"
# 可选：
# export FEISHU_API_BASE="https://open.feishu.cn"  # 默认值
# export FEISHU_PROXY="http://proxy:3128"          # 出网需要代理时
```

## 智能模式（detached）的检测原理

人在不在终端前，通过终端复用器的 **attached 状态**判断：

| 环境 | 检测方式 | attached 判定 |
|---|---|---|
| herdr | `ss -x` 统计 UI 客户端 socket（`~/.config/herdr/herdr-client.sock`，named session 为 `sessions/<name>/herdr-client.sock`）的 ESTAB 连接数 | ≥ 1 条 ESTAB |
| herdr（macOS） | 无 `ss`，用内置 `netstat -f unix`：`herdr-client.sock` 路径行与客户端行互指即有连接（原理同 ss） | 有连接 |
| zellij（Linux） | `ss -x` 统计会话 socket `/run/user/$UID/zellij/<版本>/<会话名>` 的 ESTAB 连接数 | ≥ 1 条 ESTAB |
| zellij（macOS） | 无 `ss`，用内置 `netstat -f unix`：会话路径行 `Address` 与客户端行 `Conn` 互指即有连接（原理同 ss） | 有连接 |
| tmux | `tmux list-clients` 是否有输出 | 有输出 |
| 本地裸终端（macOS） | `ioreg` 读 `HIDIdleTime`（全局键鼠空闲时长，无需权限） | 空闲 < `FEISHU_PRESENT_IDLE_SEC`（默认 300 秒）视为在场（不发）；≥ 阈值视为离开（发） |
| 裸 SSH / 远程终端 | 无法感知对端有没有人看 | 视为在场（不发） |
| 其他平台裸终端 / 检测失败 | — | 视为离开（照发，宁发勿漏） |

- `attached` → 跳过飞书（terminal bell 插件已够用）
- `detached`（SSH 断开 / 人离开）→ 发飞书
- 检测命令失败也视为无人（fail-open，避免漏通知）

局限：本地裸终端下，"人在电脑前但长时间无键鼠输入"（看视频/开会）会被视为离开，照发；锁屏无需单独检测（锁屏必然伴随键鼠空闲增长）。裸 SSH 场景无法感知对端是否有人，一律不发送。

缺省阈值可用 `FEISHU_PRESENT_IDLE_SEC` 调整（秒，默认 300，设 0 禁用在场检测）。

缺少必需变量时插件自动禁用，加载时会写入本地日志 `/tmp/opencode/feishu-notify.log`（可用 `FEISHU_LOG` 覆盖路径）。该日志也记录通知跳过 / 发送失败的原因。

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
