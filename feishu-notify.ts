/**
 * opencode 飞书通知插件（opencode 2.0 版）
 *
 * 只有在“用户看不到这个 opencode 会话”时，才通过飞书机器人私聊推送状态：
 * - 任务完成（`session.execution.succeeded` / `session.idle` 兜底）
 * - 会话出错（`session.execution.failed`）
 * - 权限请求（`permission.asked`）
 * - Agent 提问（`form.created`）
 *
 * ## “在看 / 不在看”判定（detached 模式）
 *
 * 详见 README。要点：
 * - presence（有人吗）：本地=键鼠空闲；远程=mux attached
 * - attention（在看这个页面吗）：opencode 自身 `unread`（`time.idle > time.viewed`）+ mux pane 级
 * - “本地 / 远程”与“是否在复用器里”正交：
 *     notify = unread
 *           || (inMux && !muxOk)
 *           || (localSeat && !sessionRemote && idleSec >= FEISHU_PRESENT_IDLE_SEC)
 * - 探测逻辑在 `detect.ts`（纯函数可单测）。
 *
 * ## 环境变量
 * - FEISHU_APP_ID / FEISHU_APP_SECRET  必需
 * - FEISHU_NOTIFY_OPEN_ID / _MOBILE / _EMAIL  接收人（三选一）
 * - FEISHU_NOTIFY_WHEN   always（默认）| detached（仅“看不到”时发送）
 * - FEISHU_PRESENT_IDLE_SEC   本地键鼠空闲阈值秒（默认 300）
 * - FEISHU_VIEW_SETTLE_MS     读取 unread 前的等待毫秒（默认 1000）
 * - FEISHU_UNREAD  0 关闭 unread 信号（默认 1）
 * - FEISHU_API_BASE / FEISHU_PROXY / FEISHU_LOG / FEISHU_DEBUG  可选
 */
import { Plugin } from "@opencode/plugin"
import { appendFileSync, closeSync, openSync, writeSync } from "node:fs"
import {
  collectEnvSignals,
  decidePresent,
  tuiProcs,
  type Signals,
} from "./detect.ts"

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

const LOG_PATH = process.env.FEISHU_LOG ?? "/tmp/opencode/feishu-notify.log"
const DEBUG = process.env.FEISHU_DEBUG === "1"
const log = (level: string, message: string) => {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} [${level}] feishu-notify: ${message}\n`)
  } catch {
    /* ignore */
  }
}
const dbg = (message: string) => {
  if (DEBUG) log("debug", message)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 本地提示（OSC 9 写进 TUI 的 pty）
// ---------------------------------------------------------------------------

const notifyTerminal = async (message: string): Promise<void> => {
  for (const { tty } of await tuiProcs()) {
    try {
      const fd = openSync(`/dev/${tty}`, "w")
      try {
        writeSync(fd, `\x1b]9;${message}\x07`)
      } finally {
        closeSync(fd)
      }
    } catch {
      /* pty 可能已消失 */
    }
  }
}

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
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (opts.auth) headers.Authorization = `Bearer ${await this.getToken()}`
    const init: Record<string, unknown> = { method, headers }
    if (this.cfg.proxy) init.proxy = this.cfg.proxy
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
    const res = await fetch(`${this.cfg.apiBase}${path}`, init as RequestInit)
    const data = (await res.json().catch(() => ({}))) as Record<string, any>

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
      const openId = String(user.user_id)
      this.openId = openId
      return openId
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

const BELL_TEXT: Record<NotifyKind, string> = {
  done: "任务完成",
  error: "会话出错",
  permission: "等待权限批准",
  question: "等待你回答",
}

const mdEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

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
// 插件
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "feishu-notify",
  async setup(ctx) {
    const cfg = loadConfig()
    if (!cfg) {
      log(
        "info",
        "disabled: missing FEISHU_APP_ID/FEISHU_APP_SECRET or receiver (FEISHU_NOTIFY_OPEN_ID/MOBILE/EMAIL)",
      )
      return
    }

    const feishu = new FeishuClient(cfg)
    const directory: string = ctx.location?.directory ?? ""
    const projectRoot: string =
      (ctx.location as any)?.project?.canonical ||
      (ctx.location as any)?.project?.directory ||
      directory
    const projectName = projectRoot.split("/").filter(Boolean).pop() || directory

    const notifyWhen =
      process.env.FEISHU_NOTIFY_WHEN?.trim() === "detached" ? "detached" : "always"

    const idleRaw = Number(process.env.FEISHU_PRESENT_IDLE_SEC?.trim())
    const presentIdleSec = Number.isFinite(idleRaw) && idleRaw >= 0 ? idleRaw : 300

    const settleRaw = Number(process.env.FEISHU_VIEW_SETTLE_MS?.trim())
    const viewSettleMs = Number.isFinite(settleRaw) && settleRaw >= 0 ? settleRaw : 1000

    const unreadEnabled = process.env.FEISHU_UNREAD?.trim() !== "0"

    // 若 opencode 的 session 信息始终不暴露 time.viewed，则关闭 unread，避免误判刷屏。
    let viewedSeen = false
    let unreadProbeCount = 0

    log("info", `enabled (notify_when=${notifyWhen}) dir=${directory}`)

    /**
     * 读取 opencode 自身的“未读”状态：
     *   unread = time.idle > time.viewed（或 viewed 缺失）
     * 语义 = 该轮跑完了，但显示它的那个 TUI 还没确认（失焦 / 显示别的 tab）。
     * 需先等待 settle，避免与 TUI 的标记竞态。
     */
    const readUnread = async (sessionID: string): Promise<boolean> => {
      if (!unreadEnabled) return false
      if (viewSettleMs > 0) await sleep(viewSettleMs)
      try {
        const s: any = await ctx.session.get({ sessionID })
        const idle = s?.time?.idle
        const viewed = s?.time?.viewed
        unreadProbeCount++
        if (typeof viewed === "number") viewedSeen = true
        if (idle === undefined || idle === null) return false
        if (!viewedSeen) {
          // 该 API 可能不暴露 viewed：前几次探测不予采信；持续如此则永久关闭
          if (unreadProbeCount >= 5) {
            log("warn", "session.time.viewed not exposed; disabling unread signal")
            viewedSeen = false
            return false
          }
          return false
        }
        return viewed === undefined || viewed === null || idle > viewed
      } catch {
        return false
      }
    }

    /** 计算“用户能看到”。 */
    const computePresent = async (sessionID?: string): Promise<boolean> => {
      try {
        const env = await collectEnvSignals()
        const unread = sessionID ? await readUnread(sessionID) : false
        const signals: Signals = { ...env, unread }
        const present = decidePresent(signals, { presentIdleSec })
        log(
          "info",
          `decide present=${present} session=${sessionID ?? "-"} unread=${unread} ` +
            `remote=${env.sessionRemote} idleSec=${env.idleSec ?? "-"} mux=${JSON.stringify(env.muxes)}`,
        )
        return present
      } catch (e) {
        log("warn", `decision failed: ${e instanceof Error ? e.message : String(e)}`)
        return false // fail-open：判定失败时按“看不到”处理（宁发勿漏）
      }
    }

    /** 发送通知；失败只记日志，绝不影响 opencode 主流程。 */
    const notify = async (
      kind: NotifyKind,
      sessionID: string | undefined,
      lines: string[],
      footerExtra?: string,
    ) => {
      if (notifyWhen === "detached") {
        const present = await computePresent(sessionID)
        if (present) {
          // 人在看：走本地提示，不发飞书（避免刷屏）
          await notifyTerminal(`opencode: ${BELL_TEXT[kind]}`)
          return
        }
      }
      try {
        const time = new Date().toLocaleString("zh-CN", { hour12: false })
        const footer = [projectName, footerExtra, time].filter(Boolean).join(" · ")
        await feishu.sendCard(buildCard(kind, lines, footer))
        log("info", `sent kind=${kind} session=${sessionID ?? "-"}`)
      } catch (e) {
        log("warn", `send failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    /** 主会话（非子 agent）才通知；查询失败时放行，避免漏通知 */
    const isPrimarySession = async (sessionID: string): Promise<boolean> => {
      try {
        const s = await ctx.session.get({ sessionID })
        return !s?.parentID
      } catch {
        return true
      }
    }

    /** 取会话上下文信息用于卡片展示 */
    const sessionInfo = async (sessionID: string): Promise<string[]> => {
      try {
        const s = await ctx.session.get({ sessionID })
        const lines: string[] = []
        if (s?.title) lines.push(`**会话**：${mdEscape(s.title)}`)
        const dir = s?.location?.directory
        if (dir) lines.push(`**目录**：${mdEscape(dir)}`)
        if (s?.time?.created && s?.time?.updated) {
          lines.push(`**耗时**：${fmtDuration(s.time.updated - s.time.created)}`)
        }
        return lines
      } catch {
        return []
      }
    }

    type LooseMsg = {
      type?: string
      text?: string
      content?: Array<{ type?: string; text?: string }>
    }

    const normalize = (s: string) => s.replace(/\s+/g, " ").trim()
    const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s)

    const taskContext = async (
      sessionID: string,
    ): Promise<{ task: string; result: string }> => {
      const out = { task: "", result: "" }
      try {
        const msgs = (await ctx.session.context({ sessionID })) as LooseMsg[]
        const firstUser = msgs.find((m) => m.type === "user")
        const lastAssistant = [...msgs].reverse().find((m) => m.type === "assistant")
        out.task = clip(normalize(firstUser?.text ?? ""), 100)
        out.result = clip(
          normalize(
            (lastAssistant?.content ?? [])
              .filter((c) => c.type === "text")
              .map((c) => String(c.text ?? ""))
              .join(" "),
          ),
          150,
        )
      } catch {
        // 拿不到就少显示，不影响通知
      }
      return out
    }

    const taskLines = (t: { task: string; result: string }, withResult = false) => [
      ...(t.task ? [`**任务**：${mdEscape(t.task)}`] : []),
      ...(withResult && t.result ? [`**结果**：${mdEscape(t.result)}`] : []),
    ]

    // ── v2 事件订阅 ──────────────────────────────────────────────────────
    const controller = new AbortController()
    const seenPermissions = new Set<string>()
    const seenForms = new Set<string>()
    const doneNotified = new Set<string>()

    const notifyDone = async (sessionID: string, via: string) => {
      if (doneNotified.has(sessionID)) return
      doneNotified.add(sessionID)
      if (!(await isPrimarySession(sessionID))) return
      const [info, t] = await Promise.all([sessionInfo(sessionID), taskContext(sessionID)])
      await notify(
        "done",
        sessionID,
        ["任务已完成，回来查看结果吧。", ...taskLines(t, true), ...info],
        via,
      )
    }

    const onEvent = async (event: { type: string; data: any }) => {
      switch (event.type) {
        case "session.execution.started": {
          const sessionID: string | undefined = event.data?.sessionID
          if (sessionID) doneNotified.delete(sessionID)
          break
        }

        case "session.execution.succeeded":
        case "session.idle": {
          const sessionID: string | undefined = event.data?.sessionID
          if (sessionID) await notifyDone(sessionID, event.type)
          break
        }

        case "session.execution.failed": {
          const sessionID: string | undefined = event.data?.sessionID
          if (sessionID && !(await isPrimarySession(sessionID))) return
          const errMsg: string | undefined = event.data?.error?.message || event.data?.error?.type
          const [info, t] = await Promise.all([
            sessionID ? sessionInfo(sessionID) : Promise.resolve([] as string[]),
            sessionID ? taskContext(sessionID) : Promise.resolve({ task: "", result: "" }),
          ])
          await notify(
            "error",
            sessionID,
            [
              "会话出现错误。",
              ...taskLines(t),
              ...(errMsg ? [`**错误**：${mdEscape(errMsg).slice(0, 500)}`] : []),
              ...info,
            ],
            "session.execution.failed",
          )
          break
        }

        case "permission.asked": {
          const { sessionID, id, action, resources } = event.data ?? {}
          if (id && seenPermissions.has(id)) return
          if (id) seenPermissions.add(id)
          if (sessionID && !(await isPrimarySession(sessionID))) return
          const detail = action
            ? `**操作**：${mdEscape(action)}${
                Array.isArray(resources) && resources.length
                  ? ` ${mdEscape(resources.join(", "))}`
                  : ""
              }`
            : ""
          const [info, t] = await Promise.all([
            sessionID ? sessionInfo(sessionID) : Promise.resolve([] as string[]),
            sessionID ? taskContext(sessionID) : Promise.resolve({ task: "", result: "" }),
          ])
          await notify(
            "permission",
            sessionID,
            ["Agent 正在等待你批准权限操作。", ...(detail ? [detail] : []), ...taskLines(t), ...info],
            "permission.asked",
          )
          break
        }
        case "permission.replied": {
          const requestID: string | undefined = event.data?.requestID
          if (requestID) seenPermissions.delete(requestID)
          break
        }

        case "form.created": {
          const form = event.data?.form
          if (!form?.id) return
          if (seenForms.has(form.id)) return
          seenForms.add(form.id)
          const sessionID: string | undefined = form.sessionID
          if (sessionID && !(await isPrimarySession(sessionID))) return
          const [info, t] = await Promise.all([
            sessionID ? sessionInfo(sessionID) : Promise.resolve([] as string[]),
            sessionID ? taskContext(sessionID) : Promise.resolve({ task: "", result: "" }),
          ])
          await notify(
            "question",
            sessionID,
            [
              "Agent 有问题需要你回答。",
              ...(form.title ? [`**问题**：${mdEscape(String(form.title))}`] : []),
              ...taskLines(t),
              ...info,
            ],
            "form.created",
          )
          break
        }
        case "form.replied":
        case "form.cancelled": {
          const formID: string | undefined = event.data?.id
          if (formID) seenForms.delete(formID)
          break
        }
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await onEvent(event as any)
          } catch (e) {
            log("warn", `event handler failed: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          log("warn", `event stream ended: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    })()

    return () => controller.abort()
  },
})