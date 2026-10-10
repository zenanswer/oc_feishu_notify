/**
 * 探测层（纯逻辑 + 系统探测）
 *
 * 目标：判断“用户现在能不能看到这个 opencode 会话”。
 *
 * 设计要点（详见 README / 方案）：
 * - 信号分两类，语义分离：
 *   - presence（有人吗）：本地=键鼠空闲；远程=mux attached
 *   - attention（在看这个页面吗）：unread（opencode 自身的 viewed 状态）+ mux pane 级
 * - “本地 / 远程”与“是否在复用器里”正交，不做二选一。
 * - 无头/远程机测不到键鼠空闲 → 自动退回 mux 判定。
 *
 * 本文件不依赖 @opencode/plugin，可被 node --test 直接测试。
 */
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

/** 执行命令并返回 stdout；出错/超时返回空串。 */
export const run = (file: string, args: string[], timeout = 5000): Promise<string> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 1 << 22 }, (err, out) =>
      resolve(err ? "" : String(out ?? "")),
    )
  })

/** 经 /bin/sh 执行（仅用于需要管道/glob 的场景）。 */
export const sh = (cmd: string): Promise<string> => run("/bin/sh", ["-c", cmd])

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)]

// ---------------------------------------------------------------------------
// presence 信号 1：键鼠空闲（跨平台）
// ---------------------------------------------------------------------------

/** 解析 macOS `ioreg` 的 HIDIdleTime（纳秒）→ 秒。 */
export const parseHIDIdleTime = (out: string): number | undefined => {
  const m = out.match(/(\d+)/)
  if (!m) return undefined
  return Number(m[1]) / 1e9
}

/** 解析 `xprintidle`（毫秒）→ 秒。 */
export const parseXprintidle = (out: string): number | undefined => {
  const t = out.trim()
  if (!/^\d+$/.test(t)) return undefined
  return Number(t) / 1000
}

/** 解析 D-Bus ScreenSaver GetSessionIdleTime（秒）。优先 `uint32 <n>`。 */
export const parseScreensaverIdle = (out: string): number | undefined => {
  const m = out.match(/uint32\s+(\d+)/) || out.match(/(\d+)\s*$/)
  if (!m) return undefined
  return Number(m[1])
}

/** 解析 `loginctl ... -p IdleHint`。返回 yes=已空闲 / no=活跃 / undefined=未知。 */
export const parseLoginctlIdleHint = (out: string): boolean | undefined => {
  if (/IdleHint=yes/.test(out)) return true
  if (/IdleHint=no/.test(out)) return false
  return undefined
}

/** 用于 loginctl 只给布尔时的粗粒度值（大于任何常见阈值）。 */
export const IDLE_HINT_AWAY_SEC = 1 << 30

/**
 * 本机键鼠空闲秒数。
 * - macOS：ioreg HIDIdleTime
 * - Linux：xprintidle → D-Bus ScreenSaver → loginctl IdleHint（粗粒度）
 * - 无法测量（无交互座席/无头服务器）→ undefined（调用方据此退回 mux 判定）
 */
export const inputIdleSec = async (): Promise<number | undefined> => {
  try {
    if (process.platform === "darwin") {
      const out = await sh(`ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'`)
      return parseHIDIdleTime(out)
    }
    if (process.platform === "linux") {
      if (process.env.DISPLAY) {
        const v = parseXprintidle(await sh("xprintidle 2>/dev/null"))
        if (v !== undefined) return v
      }
      for (const dest of ["org.gnome.ScreenSaver", "org.freedesktop.ScreenSaver"]) {
        const obj = "/" + dest.replace(/\./g, "/")
        const out = await sh(
          `dbus-send --session --print-reply --dest=${dest} ${obj} ${dest}.GetSessionIdleTime 2>/dev/null`,
        )
        const v = parseScreensaverIdle(out)
        if (v !== undefined) return v
      }
      const sid = process.env.XDG_SESSION_ID
      if (sid) {
        const hint = parseLoginctlIdleHint(
          await sh(`loginctl show-session ${sid} -p IdleHint 2>/dev/null`),
        )
        if (hint === true) return IDLE_HINT_AWAY_SEC
        if (hint === false) return 0
      }
    }
  } catch {
    /* ignore */
  }
  return undefined
}

// ---------------------------------------------------------------------------
// opencode TUI 进程 & 其环境变量
// ---------------------------------------------------------------------------

/** TUI 持有的 pty：Linux `pts/N`，macOS `ttysN`。 */
export const TUI_TTY_RE = /^(?:pts\/\d+|ttys?\d+)$/

export type TuiProc = { pid: string; tty: string }

/** 解析 `ps -eo pid=,tty=,args=`，找出交互式 opencode TUI（跳过 serve --service）。 */
export const parseTuiProcs = (psOut: string): TuiProc[] => {
  const res: TuiProc[] = []
  const seen = new Set<string>()
  for (const line of psOut.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const [, pid, tty, args] = m
    if (!TUI_TTY_RE.test(tty)) continue
    if (!args.includes("opencode") || args.includes("serve --service")) continue
    if (seen.has(pid)) continue
    seen.add(pid)
    res.push({ pid, tty })
  }
  return res
}

export const tuiProcs = async (): Promise<TuiProc[]> =>
  parseTuiProcs(await run("ps", ["-eo", "pid=,tty=,args="]))

/** 解析 `/proc/<pid>/environ`（NUL 分隔）。 */
export const parseEnviron = (raw: string): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const kv of raw.split("\0")) {
    const i = kv.indexOf("=")
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return env
}

/** 解析 macOS `ps eww` 尾部追加的 `KEY=VAL`（值含空格会截断，够用）。 */
export const parsePsEnv = (psOut: string): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const m of psOut.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S*)/g)) env[m[1]] = m[2]
  return env
}

export const readProcessEnv = async (pid: string): Promise<Record<string, string>> => {
  if (process.platform === "linux") {
    try {
      return parseEnviron(readFileSync(`/proc/${pid}/environ`, "utf8"))
    } catch {
      return {}
    }
  }
  return parsePsEnv(await run("ps", ["eww", "-p", pid]))
}

export type MuxEnv = {
  ssh: boolean
  herdrSocket?: string
  zellijSession?: string
  zellijPane?: string
  tmuxPane?: string
}

/** 从某个 TUI 的 env 提取与本方案相关的复用器信息。 */
export const pickMuxEnv = (e: Record<string, string>): MuxEnv => ({
  ssh: !!(e.SSH_CONNECTION || e.SSH_CLIENT || e.SSH_TTY),
  herdrSocket: e.HERDR_ENV === "1" ? e.HERDR_SOCKET_PATH || "" : undefined,
  zellijSession: e.ZELLIJ_SESSION_NAME || undefined,
  zellijPane: e.ZELLIJ_PANE_ID || undefined,
  tmuxPane: e.TMUX ? e.TMUX_PANE || "" : undefined,
})

// ---------------------------------------------------------------------------
// presence 信号 2：复用器 attached（+ 客户端本地/远程）
// ---------------------------------------------------------------------------

export type MuxState = { kind: "herdr" | "tmux" | "zellij"; attached: boolean }

export type UnixSock = { addr: string; type: string; conn: string; path: string }

/** 解析 `netstat -f unix`（macOS）。带路径的行 9 列，无路径的 8 列。 */
export const parseNetstatUnix = (out: string): UnixSock[] => {
  const rows: UnixSock[] = []
  for (const line of out.split("\n")) {
    const c = line.trim().split(/\s+/)
    if (c.length < 8) continue
    if (c[1] !== "stream" && c[1] !== "dgram") continue
    rows.push({ addr: c[0], type: c[1], conn: c[5], path: c.length >= 9 ? c[8] : "" })
  }
  return rows
}

/** 某 socket 路径是否有已连接的对端（attached）。返回客户端 pcb 地址（用于反查 PID）。 */
export const unixSocketPeer = (
  out: string,
  path: string,
): { attached: boolean; clientPcb?: string } => {
  const rows = parseNetstatUnix(out)
  const accepted = rows.find((r) => r.path === path && r.conn !== "0")
  return accepted ? { attached: true, clientPcb: accepted.conn } : { attached: false }
}

/** 解析 `lsof -U` 的 `unix 0x<addr>` → 地址到 PID 的映射（macOS/Linux 通用尽力）。 */
export const parseLsofUnixPids = (out: string): Map<string, string> => {
  const map = new Map<string, string>()
  for (const line of out.split("\n")) {
    const m = line.match(/^\S+\s+(\d+)\s+\S+\s+\S+\s+unix\s+0x([0-9a-fA-F]+)/)
    if (m) map.set(m[2].toLowerCase(), m[1])
  }
  return map
}

/** 沿父进程链查找 sshd（= 远程登录会话）。 */
export const ancestryHasSshd = async (pid: string): Promise<boolean> => {
  let p = pid
  for (let i = 0; i < 15 && p && p !== "0" && p !== "1"; i++) {
    const out = await run("ps", ["-o", "ppid=,comm=", "-p", p])
    const m = out.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) break
    if (/sshd/i.test(m[2])) return true
    p = m[1]
  }
  return false
}

/** 确保 `herdr.sock` → `herdr-client.sock`（UI 客户端连的是后者）。 */
export const herdrClientSocket = (socketPath?: string): string => {
  const p = (socketPath || "").trim()
  if (!p) return join(homedir(), ".config", "herdr", "herdr-client.sock")
  if (/herdr-client\.sock$/.test(p)) return p
  if (/herdr\.sock$/.test(p)) return p.replace(/herdr\.sock$/, "herdr-client.sock")
  return p
}

/**
 * 探测 macOS 下某 unix socket 的 attached 状态与对端是否远程。
 * - attached：存在 `Addr==path && Conn!=0` 的行
 * - 对端 PID：pcb → lsof；解析不出 ⇒ 远程（root 拥有的 ssh/forward 端）
 */
export const probeUnixSocketMac = async (
  path: string,
): Promise<{ attached: boolean; remote?: boolean }> => {
  const net = await run("netstat", ["-f", "unix"])
  const { attached, clientPcb } = unixSocketPeer(net, path)
  if (!attached) return { attached: false }
  const pid = clientPcb ? parseLsofUnixPids(await run("lsof", ["-U"])).get(clientPcb.toLowerCase()) : undefined
  if (!pid) return { attached: true, remote: true }
  return { attached: true, remote: await ancestryHasSshd(pid) }
}

/** Linux：`ss -x` 判定 attached，`ss -x -p` 取对端 PID。 */
export const ssUnixAttached = (out: string, marker: string): boolean =>
  out.split("\n").some((l) => l.includes("ESTAB") && l.includes(marker))

export const ssUnixPids = (out: string, marker: string): string[] =>
  uniq(
    out
      .split("\n")
      .filter((l) => l.includes(marker))
      .flatMap((l) => [...l.matchAll(/pid=(\d+)/g)].map((m) => m[1])),
  )

export const probeUnixSocketLinux = async (
  path: string,
): Promise<{ attached: boolean; remote?: boolean }> => {
  const ss = await run("ss", ["-x"])
  if (!ssUnixAttached(ss, path)) return { attached: false }
  const pids = ssUnixPids(await run("ss", ["-x", "-p"]), path)
  if (pids.length === 0) return { attached: true, remote: true }
  const remote = (await Promise.all(pids.map(ancestryHasSshd))).some(Boolean)
  return { attached: true, remote }
}

const probeUnixSocket = (path: string): Promise<{ attached: boolean; remote?: boolean }> =>
  process.platform === "linux" ? probeUnixSocketLinux(path) : probeUnixSocketMac(path)

/** herdr：探测所有候选 client socket，合并 attached/remote。 */
export const herdrProbe = async (
  sockets: string[],
): Promise<{ attached: boolean; remote?: boolean }> => {
  const paths = uniq(sockets.map(herdrClientSocket))
  let attached = false
  let remote: boolean | undefined
  for (const p of paths) {
    const r = await probeUnixSocket(p)
    attached = attached || r.attached
    if (r.remote === true) remote = true
    else if (r.remote === false && remote === undefined) remote = false
  }
  return { attached, remote }
}

export type ZellijClientRow = { clientId: string; paneId: string; command: string }

/** 解析 `zellij action list-clients`（表头 `CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND`）。 */
export const parseZellijClients = (out: string): ZellijClientRow[] =>
  out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^CLIENT_ID\b/.test(l))
    .map((l) => {
      const c = l.split(/\s+/)
      return { clientId: c[0] ?? "", paneId: c[1] ?? "", command: c.slice(2).join(" ") }
    })

export const zellijProbe = async (
  session: string,
  paneId?: string,
): Promise<{ attached: boolean; remote?: boolean }> => {
  const out = await run("zellij", ["--session", session, "action", "list-clients"])
  const rows = parseZellijClients(out)
  const attached = paneId ? rows.some((r) => r.paneId === paneId) : rows.length > 0
  if (!attached) return { attached: false }
  // zellij 不暴露客户端 pid/tty；本地/远程交给 env(SSH_*) 与是否可测空闲判定。
  return { attached: true }
}

/** tmux：`window_active_clients`（window 级）。 */
export const parseWindowActiveClients = (out: string): number | undefined => {
  const t = out.trim()
  if (!/^\d+$/.test(t)) return undefined
  return Number(t)
}

export const tmuxProbe = async (
  panes: string[],
): Promise<{ attached: boolean; remote?: boolean }> => {
  let attached = false
  for (const pane of panes) {
    const n = parseWindowActiveClients(
      await run("tmux", ["display-message", "-p", "-t", pane, "#{window_active_clients}"]),
    )
    if (n !== undefined && n > 0) attached = true
  }
  const pids = uniq(
    (await run("tmux", ["list-clients", "-F", "#{client_pid}"]))
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
  )
  if (!attached) return { attached: false }
  if (pids.length === 0) return { attached: true }
  const remote = (await Promise.all(pids.map(ancestryHasSshd))).some(Boolean)
  return { attached: true, remote }
}

// ---------------------------------------------------------------------------
// 汇总 & 决策
// ---------------------------------------------------------------------------

export type EnvSignals = {
  sessionRemote: boolean
  localSeat: boolean
  idleSec?: number
  muxes: MuxState[]
  notes: string[]
}

/** 环境探测（不含需要 opencode ctx 的 `unread`）。 */
export const collectEnvSignals = async (): Promise<EnvSignals> => {
  const notes: string[] = []
  const procs = await tuiProcs()
  const envs = await Promise.all(procs.map((p) => readProcessEnv(p.pid)))
  const muxEnvs = envs.map(pickMuxEnv)

  const sshEnv = muxEnvs.some((m) => m.ssh)
  const herdrSockets = uniq(muxEnvs.map((m) => m.herdrSocket).filter((x): x is string => x !== undefined))
  const zellijSessions = uniq(
    muxEnvs.map((m) => m.zellijSession).filter((x): x is string => !!x),
  )
  const tmuxPanes = uniq(muxEnvs.map((m) => m.tmuxPane).filter((x): x is string => x !== undefined))

  const muxes: MuxState[] = []
  let clientRemote: boolean | undefined
  const mergeRemote = (r?: boolean) => {
    if (r === true) clientRemote = true
    else if (r === false && clientRemote === undefined) clientRemote = false
  }

  if (herdrSockets.length) {
    const r = await herdrProbe(herdrSockets)
    muxes.push({ kind: "herdr", attached: r.attached })
    mergeRemote(r.remote)
  }
  if (zellijSessions.length) {
    const pane = muxEnvs.find((m) => m.zellijSession)?.zellijPane
    const r = await zellijProbe(zellijSessions[0], pane)
    muxes.push({ kind: "zellij", attached: r.attached })
    mergeRemote(r.remote)
  }
  if (tmuxPanes.length) {
    const r = await tmuxProbe(tmuxPanes)
    muxes.push({ kind: "tmux", attached: r.attached })
    mergeRemote(r.remote)
  }

  const idleSec = await inputIdleSec()
  const localSeat = idleSec !== undefined

  const sessionRemote =
    sshEnv ||
    clientRemote === true ||
    (!localSeat && process.platform !== "darwin")

  if (procs.length === 0) notes.push("no-tui-found")
  notes.push(`ssh=${sshEnv}`, `remote=${sessionRemote}`, `idle=${idleSec ?? "-"}`, `mux=${JSON.stringify(muxes)}`)
  return { sessionRemote, localSeat, idleSec, muxes, notes }
}

export type Signals = EnvSignals & { unread: boolean }

export type DecisionConfig = { presentIdleSec: number }

/**
 * 最终判定：true = 用户能看到（不发飞书）。
 *   notify = unread || (inMux && !muxOk) || (localSeat && !sessionRemote && idleSec >= 阈值)
 */
export const decidePresent = (s: Signals, cfg: DecisionConfig): boolean => {
  if (s.unread) return false
  if (s.muxes.length > 0 && s.muxes.some((m) => !m.attached)) return false
  if (
    s.localSeat &&
    !s.sessionRemote &&
    s.idleSec !== undefined &&
    s.idleSec >= cfg.presentIdleSec
  ) {
    return false
  }
  return true
}