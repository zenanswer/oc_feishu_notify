/**
 * opencode 飞书通知插件
 *
 * 在 SSH 断开时通过飞书应用机器人私聊推送 opencode 状态：
 * - 任务完成 (`session.idle`)
 * - 会话出错 (`session.error`)
 * - 权限请求 (`permission.asked`)
 * - Agent 提问 (`tool.execute.before` when tool is "question")
 *
 * 消息以交互式卡片发送，过滤子 agent 会话避免刷屏。
 *
 * 环境变量配置（全部可选，缺失必需项时插件静默禁用）：
 * - FEISHU_APP_ID            飞书应用 App ID（必需）
 * - FEISHU_APP_SECRET        飞书应用 App Secret（必需）
 * - FEISHU_NOTIFY_OPEN_ID    接收人 open_id（ou_ 开头，二选一）
 * - FEISHU_NOTIFY_MOBILE     接收人手机号，带区号如 +8613800138000（二选一）
 * - FEISHU_NOTIFY_EMAIL      接收人邮箱（二选一，优先级低于 open_id/mobile）
 * - FEISHU_API_BASE          API 域名，默认 https://open.feishu.cn
 * - FEISHU_PROXY             出网代理，如 http://proxy:3128（可选）
 * - FEISHU_NOTIFY_WHEN       always（默认，总是发送）| detached（仅当"人看不到"时发送：
 *                            zellij/tmux 无人 attached；裸 SSH 一律不发；本地裸终端按
 *                            键鼠空闲判定人是否离开）
 * - FEISHU_PRESENT_IDLE_SEC  本地裸终端在场阈值秒数（默认 300；键鼠空闲 ≥ 阈值视为离开；
 *                            设 0 禁用在场检测，本地裸终端始终发送）
 *
 * 所需应用权限：
 * - im:message:send_as_bot      发送私聊消息
 * - contact:user.id:readonly    通过手机号/邮箱查 open_id
 */
import type { Plugin } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

type Config = {
  appId: string
  appSecret: string
  openId?: string
  mobile?: string
  email?: string
  apiBase: string
  proxy?: string
}

const loadConfig = (): Config | undefined => {
  const appId = process.env.FEISHU_APP_ID?.trim()
  const appSecret = process.env.FEISHU_APP_SECRET?.trim()
  const openId = process.env.FEISHU_NOTIFY_OPEN_ID?.trim()
  const mobile = process.env.FEISHU_NOTIFY_MOBILE?.trim()
  const email = process.env.FEISHU_NOTIFY_EMAIL?.trim()
  if (!appId || !appSecret) return undefined
  if (!openId && !mobile && !email) return undefined
  return {
    appId,
    appSecret,
    openId,
    mobile,
    email,
    apiBase: process.env.FEISHU_API_BASE?.trim() || "https://open.feishu.cn",
    proxy: process.env.FEISHU_PROXY?.trim() || undefined,
  }
}

// ---------------------------------------------------------------------------
// 飞书 API 客户端（token 缓存 + 过期刷新 + 失败重试）
// ---------------------------------------------------------------------------

class FeishuClient {
  private token?: { value: string; expireAt: number }
  private openId?: string
  private cfg: Config

  constructor(cfg: Config) {
    this.cfg = cfg
  }

  private async req(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; auth?: boolean; retryToken?: boolean } = {},
  ): Promise<Record<string, any>> {
    const init: Record<string, unknown> = {
      method,
      headers: { "Content-Type": "application/json" },
    }
    if (this.cfg.proxy) init.proxy = this.cfg.proxy
    if (opts.auth) {
      init.headers = {
        ...init.headers,
        Authorization: `Bearer ${await this.getToken()}`,
      }
    }
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
    const res = await fetch(`${this.cfg.apiBase}${path}`, init as RequestInit)
    const data = (await res.json().catch(() => ({}))) as Record<string, any>

    // token 失效（99991661/99991663/99991668 等）时强制刷新重试一次
    if (opts.auth && opts.retryToken !== false && data.code === 99991661) {
      this.token = undefined
      return this.req(method, path, { ...opts, retryToken: false })
    }
    return data
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expireAt) return this.token.value
    const data = await this.req("POST", "/open-apis/auth/v3/tenant_access_token/internal", {
      body: { app_id: this.cfg.appId, app_secret: this.cfg.appSecret },
    })
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`feishu: get token failed: ${data.code} ${data.msg}`)
    }
    // 提前 5 分钟过期，避免边界失效
    this.token = {
      value: data.tenant_access_token,
      expireAt: Date.now() + (data.expire ?? 7200) * 1000 - 5 * 60 * 1000,
    }
    return this.token.value
  }

  async getOpenId(): Promise<string> {
    if (this.openId) return this.openId
    if (this.cfg.openId) {
      this.openId = this.cfg.openId
      return this.openId
    }
    if (this.cfg.mobile || this.cfg.email) {
      const query = new URLSearchParams({ user_id_type: "open_id" })
      const body: Record<string, string[]> = {}
      if (this.cfg.mobile) body.mobiles = [this.cfg.mobile]
      if (this.cfg.email) body.emails = [this.cfg.email]
      const data = await this.req(
        "POST",
        `/open-apis/contact/v3/users/batch_get_id?${query}`,
        { body, auth: true },
      )
      const user = data?.data?.user_list?.find((u: any) => u.user_id)
      if (data.code !== 0 || !user) {
        throw new Error(`feishu: resolve open_id failed: ${data.code} ${data.msg}`)
      }
      this.openId = user.user_id
      return this.openId
    }
    throw new Error("feishu: no receiver configured (open_id/mobile/email)")
  }

  async sendCard(card: Record<string, unknown>): Promise<void> {
    const openId = await this.getOpenId()
    const data = await this.req("POST", "/open-apis/im/v1/messages?receive_id_type=open_id", {
      body: {
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
      auth: true,
    })
    if (data.code !== 0) {
      throw new Error(`feishu: send message failed: ${data.code} ${data.msg}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 卡片构造
// ---------------------------------------------------------------------------

type NotifyKind = "done" | "error" | "permission" | "question"

const KIND_META: Record<NotifyKind, { title: string; template: string }> = {
  done: { title: "✅ opencode 任务完成", template: "green" },
  error: { title: "❌ opencode 会话出错", template: "red" },
  permission: { title: "🔐 opencode 权限请求", template: "orange" },
  question: { title: "❓ opencode 等待回答", template: "blue" },
}

const mdEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const fmtDuration = (ms: number): string => {
  if (ms < 0 || !Number.isFinite(ms)) return "-"
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟`
  const hr = Math.floor(min / 60)
  return `${hr} 小时 ${min % 60} 分钟`
}

const buildCard = (kind: NotifyKind, lines: string[], footer: string) => ({
  config: { wide_screen_mode: true },
  header: {
    template: KIND_META[kind].template,
    title: { tag: "plain_text", content: KIND_META[kind].title },
  },
  elements: [
    {
      tag: "div",
      text: { tag: "lark_md", content: lines.filter(Boolean).join("\n") },
    },
    {
      tag: "note",
      elements: [{ tag: "plain_text", content: footer }],
    },
  ],
})

// ---------------------------------------------------------------------------
// zellij attached 检测（macOS 无 ss 时的等价实现）
// ---------------------------------------------------------------------------

/**
 * 从 `netstat -f unix` 输出判断 zellij 会话 socket 是否有客户端连接。
 * 与 Linux `ss -x` 的 ESTAB 判定同构：
 * - 路径行（尾列为 socket 路径，形如 $TMPDIR/zellij-<uid>/<contract>/<会话名>）
 * - 已连接的 unix stream 是两行互指：客户端行的 Conn 列 = 服务端行（路径行）的 Address 列
 * 列序：Address Type Recv-Q Send-Q Inode Conn Refs Nextref Addr
 */
export const zellijAttachedFromNetstat = (out: string, session: string): boolean => {
  const pathRe = new RegExp(`zellij[^/]*(?:/[^/]+)?/${escapeRegExp(session)}\\s*$`)
  const lines = out.split("\n")
  const pcbs = new Set<string>()
  for (const l of lines) {
    if (!pathRe.test(l)) continue
    const addr = l.trim().split(/\s+/)[0]
    if (addr) pcbs.add(addr)
  }
  if (pcbs.size === 0) return false
  return lines.some((l) => {
    const c = l.trim().split(/\s+/)
    return c[1] === "stream" && c[5] !== undefined && pcbs.has(c[5])
  })
}

// ---------------------------------------------------------------------------
// 本地在场检测（macOS 裸终端用，无复用器时判断人是否在电脑前）
// ---------------------------------------------------------------------------

/**
 * 根据键鼠空闲秒数判断人是否在电脑前：
 * - idleSec 未知（undefined）→ undefined（无法判定，调用方 fail-open）
 * - idleSec < threshold → true（人在场）
 * - idleSec >= threshold → false（人已离开）
 * - threshold 为 0 时恒为 false（禁用在场检测，始终按"离开"处理）
 */
export const presentFromIdle = (
  idleSec: number | undefined,
  threshold: number,
): boolean | undefined => {
  if (idleSec === undefined) return undefined
  return idleSec < threshold
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export const FeishuNotifyPlugin: Plugin = async ({ client, project, directory, $ }) => {
  const cfg = loadConfig()
  // 不能用 client.app.log.bind(...)：SDK 方法内部依赖 this._client，
  // 必须保持方法调用形式（client.app.log({...})）才有正确 receiver；
  // 日志失败也绝不向上抛，避免影响插件加载与通知主流程。
  const log = async (
    envelope: { body: { service: string; level: string; message: string } },
  ) => {
    try {
      await client.app.log(envelope)
    } catch {
      // swallow
    }
  }

  if (!cfg) {
    await log({
      body: {
        service: "feishu-notify",
        level: "info",
        message:
          "disabled: missing FEISHU_APP_ID/FEISHU_APP_SECRET or receiver (FEISHU_NOTIFY_OPEN_ID/MOBILE/EMAIL)",
      },
    })
    return {}
  }

  const feishu = new FeishuClient(cfg)
  const projectName = project.worktree?.split("/").filter(Boolean).pop() || directory
  const notifyWhen =
    process.env.FEISHU_NOTIFY_WHEN?.trim() === "detached" ? "detached" : "always"
  // 本地裸终端的在场阈值（秒）：键鼠空闲超过该时长视为"人已离开"；0 = 禁用在场检测
  const idleRaw = Number(process.env.FEISHU_PRESENT_IDLE_SEC?.trim())
  const presentIdleSec = Number.isFinite(idleRaw) && idleRaw >= 0 ? idleRaw : 300

  await log({
    body: {
      service: "feishu-notify",
      level: "info",
      message: `enabled (notify_when=${notifyWhen})`,
    },
  })

  /**
   * macOS 本机人是否在电脑前（全局键鼠空闲时长，无需任何权限）；失败 → undefined
   */
  const isUserPresentOnMac = async (): Promise<boolean | undefined> => {
    try {
      const out =
        await $`ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'`
          .nothrow()
          .text()
      const t = out.trim()
      if (!/^\d+$/.test(t)) return undefined
      return presentFromIdle(Number(t) / 1e9, presentIdleSec)
    } catch {
      return undefined
    }
  }

  /**
   * 用户是否 attached 在终端复用器上 / 人是否在场（人在屏幕前）：
   * - zellij: 会话 socket 上有客户端连接
   *   - Linux: `ss -x` 匹配 /run/user/$UID/zellij/<版本>/<会话名> 的 ESTAB 行
   *   - macOS: 无 ss，用内置 `netstat -f unix`（见 zellijAttachedFromNetstat）
   * - tmux:   tmux list-clients 有输出
   * - 裸终端:
   *   - SSH/远程会话：无法感知对端是否有人在看 → 视为在场（不发）
   *   - macOS 本机: 键鼠空闲 < FEISHU_PRESENT_IDLE_SEC 视为在场（不发），
   *     离开/检测失败 → 视为不在场（发，fail-open 宁发勿漏）
   *   - 其他平台 / 检测失败 → 视为不在场（照发）
   */
  const isUserAttached = async (): Promise<boolean> => {
    try {
      const zellijSession = process.env.ZELLIJ_SESSION_NAME?.trim()
      if (zellijSession) {
        if (process.platform === "darwin") {
          const out = await $`netstat -f unix`.nothrow().text()
          return zellijAttachedFromNetstat(out, zellijSession)
        }
        const out = await $`ss -x`.nothrow().text()
        const re = new RegExp(`zellij/[^/]+/${escapeRegExp(zellijSession)}\\s`)
        return out.split("\n").some((l) => l.includes("ESTAB") && re.test(l))
      }
      if (process.env.TMUX?.trim()) {
        const out = await $`tmux list-clients`.nothrow().text()
        return out.trim().length > 0
      }
      if (process.env.SSH_CONNECTION?.trim()) return true
      if (process.platform === "darwin") {
        return (await isUserPresentOnMac()) ?? false
      }
      return false
    } catch {
      return false
    }
  }

  /** 发送通知；任何失败只记日志，绝不影响 opencode 主流程 */
  const notify = async (kind: NotifyKind, lines: string[], footerExtra?: string) => {
    if (notifyWhen === "detached" && (await isUserAttached())) {
      await log({
        body: {
          service: "feishu-notify",
          level: "info",
          message: "skipped: user attached to multiplexer or present locally",
        },
      })
      return
    }
    try {
      const time = new Date().toLocaleString("zh-CN", { hour12: false })
      const footer = [projectName, footerExtra, time].filter(Boolean).join(" · ")
      await feishu.sendCard(buildCard(kind, lines, footer))
    } catch (e) {
      await log({
        body: {
          service: "feishu-notify",
          level: "warn",
          message: `send failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      })
    }
  }

  /** 主会话（非子 agent）才通知；查询失败时放行，避免漏通知 */
  const isPrimarySession = async (sessionID: string): Promise<boolean> => {
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      return !res.data?.parentID
    } catch {
      return true
    }
  }

  /** 取会话上下文信息用于卡片展示 */
  const sessionInfo = async (sessionID: string) => {
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      const s = res.data
      const lines: string[] = []
      if (s?.title) lines.push(`**会话**：${mdEscape(s.title)}`)
      if (s?.directory) {
        lines.push(`**目录**：${mdEscape(s.directory)}`)
      }
      if (s?.time?.created && s?.time?.updated) {
        lines.push(`**耗时**：${fmtDuration(s.time.updated - s.time.created)}`)
      }
      if (s?.summary && (s.summary.files ?? 0) > 0) {
        lines.push(
          `**改动**：+${s.summary.additions ?? 0} -${s.summary.deletions ?? 0}（${s.summary.files} 个文件）`,
        )
      }
      return lines
    } catch {
      return []
    }
  }

  type LoosePart = { type?: string; text?: string; synthetic?: boolean }

  const textOf = (parts: LoosePart[] | undefined) =>
    (parts ?? [])
      .filter((p) => p.type === "text" && !p.synthetic)
      .map((p) => String(p.text ?? ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()

  /** 任务上下文：首条用户消息（任务）与末条 assistant 回复（结果） */
  const taskContext = async (sessionID: string) => {
    const out = { task: "", result: "" }
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const msgs = (res.data ?? []) as Array<{
        info?: { role?: string }
        parts?: LoosePart[]
      }>
      const firstUser = msgs.find((m) => m.info?.role === "user")
      const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant")
      out.task = textOf(firstUser?.parts)
      out.result = textOf(lastAssistant?.parts)
      if (out.task.length > 100) out.task = out.task.slice(0, 100) + "…"
      if (out.result.length > 150) out.result = out.result.slice(0, 150) + "…"
    } catch {
      // 拿不到就少显示，不影响通知
    }
    return out
  }

  const taskLines = (ctx: { task: string; result: string }, withResult = false) => [
    ...(ctx.task ? [`**任务**：${mdEscape(ctx.task)}`] : []),
    ...(withResult && ctx.result ? [`**结果**：${mdEscape(ctx.result)}`] : []),
  ]

  return {
    event: async ({ event }) => {
      const props = (event.properties ?? {}) as {
        sessionID?: string
        error?: { message?: string; name?: string }
      }
      switch (event.type as string) {
        case "session.idle": {
          if (!props.sessionID) return
          if (!(await isPrimarySession(props.sessionID))) return
          const [info, ctx] = await Promise.all([
            sessionInfo(props.sessionID),
            taskContext(props.sessionID),
          ])
          await notify("done", [
            "任务已完成，回来查看结果吧。",
            ...taskLines(ctx, true),
            ...info,
          ], "session.idle")
          break
        }
        case "session.error": {
          if (props.sessionID && !(await isPrimarySession(props.sessionID))) return
          const errMsg = props.error?.message || props.error?.name
          const ctx = props.sessionID
            ? await taskContext(props.sessionID)
            : { task: "", result: "" }
          const info = props.sessionID ? await sessionInfo(props.sessionID) : []
          await notify("error", [
            "会话出现错误。",
            ...taskLines(ctx),
            ...(errMsg ? [`**错误**：${mdEscape(errMsg).slice(0, 500)}`] : []),
            ...info,
          ], "session.error")
          break
        }
        case "permission.asked": {
          const info = props.sessionID ? await sessionInfo(props.sessionID) : []
          const ctx = props.sessionID
            ? await taskContext(props.sessionID)
            : { task: "", result: "" }
          await notify("permission", [
            "Agent 正在等待你批准权限操作。",
            ...taskLines(ctx),
            ...info,
          ], "permission.asked")
          break
        }
      }
    },
    "tool.execute.before": async (input) => {
      if (input.tool !== "question") return
      if (!(await isPrimarySession(input.sessionID))) return
      const [info, ctx] = await Promise.all([
        sessionInfo(input.sessionID),
        taskContext(input.sessionID),
      ])
      await notify(
        "question",
        ["Agent 有问题需要你回答。", ...taskLines(ctx), ...info],
        "question",
      )
    },
  }
}
