# opencode 飞书通知插件

SSH 断开时，通过飞书应用机器人**私聊推送** opencode 的状态通知：

| 事件 | 卡片 | 说明 |
|---|---|---|
| `session.idle` | ✅ 绿色 | 任务完成，含会话标题、目录、耗时、改动统计 |
| `session.error` | 🔴 红色 | 会话出错，含错误信息 |
| `permission.asked` | 🟠 橙色 | Agent 等待你批准权限 |
| `question` 工具 | 🔵 蓝色 | Agent 有问题等你回答 |

- 过滤子 agent 会话（Task 工具产生的 session），只在主会话通知
- **智能模式**（`FEISHU_NOTIFY_WHEN=detached`）：人在终端前（zellij/tmux attached）只靠终端 bell，断开/离开后才发飞书
- 单文件 TypeScript，零 npm 依赖（Bun 自带 fetch/crypto）
- 发送失败只记日志，绝不影响 opencode 主流程

## 部署

```bash
./install.sh   # symlink 到 ~/.config/opencode/plugins/feishu-notify.ts
```

重启 opencode 生效。与 `opencode-terminal-bell-notifier` 可共存（本地终端响铃 + 断开后飞书推送）。

> **重要**：SSH 断开时插件要能发通知，opencode 进程必须存活。请在 **tmux/screen** 中运行 opencode。

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
# 通知模式：always（默认，总是发送）| detached（推荐，仅终端无人时发送）
export FEISHU_NOTIFY_WHEN="detached"
# 可选：
# export FEISHU_API_BASE="https://open.feishu.cn"  # 默认值
# export FEISHU_PROXY="http://proxy:3128"          # 出网需要代理时
```

## 智能模式（detached）的检测原理

人在不在终端前，通过终端复用器的 **attached 状态**判断：

| 环境 | 检测方式 | attached 判定 |
|---|---|---|
| zellij（Linux） | `ss -x` 统计会话 socket `/run/user/$UID/zellij/<版本>/<会话名>` 的 ESTAB 连接数 | ≥ 1 条 ESTAB |
| zellij（macOS） | 无 `ss`，用内置 `netstat -f unix`：会话路径行 `Address` 与客户端行 `Conn` 互指即有连接（原理同 ss） | 有连接 |
| tmux | `tmux list-clients` 是否有输出 | 有输出 |
| 裸 SSH / 本地终端 | 无法检测 | 视为无人（照发，宁发勿漏） |

- `attached` → 跳过飞书（terminal bell 插件已够用）
- `detached`（SSH 断开 / 人离开）→ 发飞书
- 检测命令失败也视为无人（fail-open，避免漏通知）

局限：裸 SSH（无 zellij/tmux）下无法区分"人在看"与"人走了"，始终发送。

缺少必需变量时插件自动禁用（opencode 日志中会记录原因）。

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
