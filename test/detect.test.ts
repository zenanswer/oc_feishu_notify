import test from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  decidePresent,
  herdrClientSocket,
  parseEnviron,
  parseHIDIdleTime,
  parseLsofUnixPids,
  parseLoginctlIdleHint,
  parseNetstatUnix,
  parsePsEnv,
  parseScreensaverIdle,
  parseTuiProcs,
  parseWindowActiveClients,
  parseXprintidle,
  parseZellijClients,
  pickMuxEnv,
  unixSocketPeer,
  type Signals,
} from "../detect.ts"

const sig = (over: Partial<Signals> = {}): Signals => ({
  sessionRemote: false,
  localSeat: true,
  idleSec: 10,
  muxes: [],
  unread: false,
  notes: [],
  ...over,
})

const CFG = { presentIdleSec: 300 }

test("decidePresent: 本地在看（idle 小）→ present", () => {
  assert.equal(decidePresent(sig(), CFG), true)
})

test("decidePresent: 本地切到别的 tab（unread）→ 不 present", () => {
  assert.equal(decidePresent(sig({ unread: true }), CFG), false)
})

test("decidePresent: 本地关掉终端（mux detached）→ 不 present（即使人在键盘前）", () => {
  assert.equal(decidePresent(sig({ idleSec: 0.1, muxes: [{ kind: "herdr", attached: false }] }), CFG), false)
})

test("decidePresent: 本地终端仍接着（mux attached）+ 在看 → present", () => {
  assert.equal(
    decidePresent(sig({ idleSec: 1, muxes: [{ kind: "herdr", attached: true }] }), CFG),
    true,
  )
})

test("decidePresent: 本地 mux attached 但人走开（空闲超阈值）→ 不 present", () => {
  assert.equal(
    decidePresent(sig({ idleSec: 301, muxes: [{ kind: "herdr", attached: true }] }), CFG),
    false,
  )
})

test("decidePresent: 本地走开（空闲超阈值）→ 不 present", () => {
  assert.equal(decidePresent(sig({ idleSec: 301 }), CFG), false)
})

test("decidePresent: 空闲正好等于阈值 → 视为离开", () => {
  assert.equal(decidePresent(sig({ idleSec: 300 }), CFG), false)
})

test("decidePresent: 远程 unread → 不 present", () => {
  assert.equal(
    decidePresent(
      sig({ sessionRemote: true, unread: true, muxes: [{ kind: "herdr", attached: true }] }),
      CFG,
    ),
    false,
  )
})

test("decidePresent: 远程 mux detached → 不 present", () => {
  assert.equal(
    decidePresent(sig({ sessionRemote: true, muxes: [{ kind: "tmux", attached: false }] }), CFG),
    false,
  )
})

test("decidePresent: 远程 mux attached 且在看 → present（忽略本机空闲）", () => {
  assert.equal(
    decidePresent(
      sig({ sessionRemote: true, idleSec: 99999, muxes: [{ kind: "herdr", attached: true }] }),
      CFG,
    ),
    true,
  )
})

test("decidePresent: 远程无 mux（裸 ssh）→ present（沿用旧行为）", () => {
  assert.equal(
    decidePresent(sig({ sessionRemote: true, localSeat: false, idleSec: undefined }), CFG),
    true,
  )
})

test("decidePresent: 无座席（测不到空闲）→ 按远程规则处理", () => {
  assert.equal(decidePresent(sig({ localSeat: false, idleSec: undefined }), CFG), true)
  assert.equal(decidePresent(sig({ localSeat: false, idleSec: undefined, unread: true }), CFG), false)
})

// --- netstat ---

const NETSTAT = `Active LOCAL (UNIX) domain sockets
Address          Type   Recv-Q Send-Q            Inode             Conn             Refs          Nextref Addr
2e9234590698a26c stream      0      0                0 9ec295742348ded1                0                0 /x/mux.sock
 bb416f029ebc9e stream      0      0 d74c64dd4474b0ca                0                0                0 /x/mux.sock
9ec295742348ded1 stream      0      0                0 2e9234590698a26c                0                0`

const NETSTAT_NO_CLIENT = `Active LOCAL (UNIX) domain sockets
Address          Type   Recv-Q Send-Q            Inode             Conn             Refs          Nextref Addr
bb416f029ebc9e stream      0      0 d74c64dd4474b0ca                0                0                0 /x/mux.sock`

test("parseNetstatUnix: 8 列（无名客户端行）也要解析", () => {
  const rows = parseNetstatUnix(NETSTAT)
  assert.equal(rows.length, 3)
  const client = rows.find((r) => r.addr === "9ec295742348ded1")
  assert.equal(client?.path, "")
  assert.equal(client?.conn, "2e9234590698a26c")
})

test("unixSocketPeer: attached 时给出客户端 pcb", () => {
  assert.deepEqual(unixSocketPeer(NETSTAT, "/x/mux.sock"), {
    attached: true,
    clientPcb: "9ec295742348ded1",
  })
})

test("unixSocketPeer: 无连接 → attached=false", () => {
  assert.deepEqual(unixSocketPeer(NETSTAT_NO_CLIENT, "/x/mux.sock"), { attached: false })
})

// --- lsof ---

test("parseLsofUnixPids: unix 0x<addr> → pid", () => {
  const out = [
    "Python    21658 xcwang    3u  unix   0x91cd7885c6b0f7bb      0t0   /x/mux.sock",
    "Python    21660 xcwang    5u  unix 0x19038b28e805a8cf      0t0   /x/mux.sock",
  ].join("\n")
  const map = parseLsofUnixPids(out)
  assert.equal(map.get("19038b28e805a8cf"), "21660")
  assert.equal(map.get("91cd7885c6b0f7bb"), "21658")
})

// --- tmux ---

test("parseWindowActiveClients", () => {
  assert.equal(parseWindowActiveClients("1"), 1)
  assert.equal(parseWindowActiveClients("0\n"), 0)
  assert.equal(parseWindowActiveClients("nope"), undefined)
})

// --- zellij ---

test("parseZellijClients", () => {
  const out = ["CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND", "0 terminal_3 opencode", ""].join("\n")
  const rows = parseZellijClients(out)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], { clientId: "0", paneId: "terminal_3", command: "opencode" })
})

test("parseZellijClients: 无客户端（仅表头）", () => {
  assert.equal(parseZellijClients("CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n").length, 0)
})

// --- idle 解析 ---

test("parseHIDIdleTime: 纳秒 → 秒", () => {
  assert.equal(parseHIDIdleTime("713311625"), 0.713311625)
  assert.equal(parseHIDIdleTime(""), undefined)
})

test("parseXprintidle: 毫秒 → 秒", () => {
  assert.equal(parseXprintidle("4500"), 4.5)
  assert.equal(parseXprintidle("abc"), undefined)
})

test("parseScreensaverIdle", () => {
  assert.equal(parseScreensaverIdle("   uint32 120"), 120)
})

test("parseLoginctlIdleHint", () => {
  assert.equal(parseLoginctlIdleHint("IdleHint=yes"), true)
  assert.equal(parseLoginctlIdleHint("IdleHint=no"), false)
  assert.equal(parseLoginctlIdleHint(""), undefined)
})

// --- TUI 进程 / env ---

test("parseTuiProcs: 识别 macOS ttys 与 Linux pts，跳过 serve --service", () => {
  const out = [
    "73253 ?? /Users/xcwang/.opencode/bin/opencode serve --service",
    "10846 ttys003 opencode",
    "99999 pts/4 opencode",
  ].join("\n")
  const procs = parseTuiProcs(out)
  assert.deepEqual(
    procs.map((p) => p.tty).sort(),
    ["pts/4", "ttys003"].sort(),
  )
})

test("parseEnviron（Linux /proc/<pid>/environ，NUL 分隔）", () => {
  const raw = "HERDR_ENV=1\0HERDR_SOCKET_PATH=/x/herdr.sock\0SSH_CONNECTION=1.2.3.4 1 5.6.7.8 2\0"
  const env = parseEnviron(raw)
  assert.equal(env.HERDR_ENV, "1")
  assert.equal(env.HERDR_SOCKET_PATH, "/x/herdr.sock")
  assert.ok(env.SSH_CONNECTION.startsWith("1.2.3.4"))
})

test("parsePsEnv（macOS ps eww）", () => {
  const env = parsePsEnv("10846 ttys003 opencode HERDR_ENV=1 TMUX_PANE=%1 PATH=/usr/bin")
  assert.equal(env.HERDR_ENV, "1")
  assert.equal(env.TMUX_PANE, "%1")
})

// --- herdr socket 路径 ---

test("herdrClientSocket: herdr.sock → herdr-client.sock", () => {
  assert.equal(herdrClientSocket("/x/herdr.sock"), "/x/herdr-client.sock")
  assert.equal(herdrClientSocket("/x/herdr-client.sock"), "/x/herdr-client.sock")
  assert.equal(herdrClientSocket(undefined), join(homedir(), ".config", "herdr", "herdr-client.sock"))
})

// --- mux env 解析 ---

test("pickMuxEnv: 解析 tmux socket/pane、ssh、herdr、zellij", () => {
  const m = pickMuxEnv({
    TMUX: "/private/tmp/tmux-501/pt,38816,0",
    TMUX_PANE: "%1",
    SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 2",
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/x/herdr.sock",
    ZELLIJ_SESSION_NAME: "z1",
    ZELLIJ_PANE_ID: "terminal_3",
  })
  assert.equal(m.tmuxSocket, "/private/tmp/tmux-501/pt")
  assert.equal(m.tmuxPane, "%1")
  assert.equal(m.ssh, true)
  assert.equal(m.herdrSocket, "/x/herdr.sock")
  assert.equal(m.zellijSession, "z1")
  assert.equal(m.zellijPane, "terminal_3")
})

test("pickMuxEnv: 无 mux env → 全部 undefined / ssh=false", () => {
  const m = pickMuxEnv({ PATH: "/usr/bin" })
  assert.equal(m.ssh, false)
  assert.equal(m.tmuxSocket, undefined)
  assert.equal(m.tmuxPane, undefined)
  assert.equal(m.herdrSocket, undefined)
  assert.equal(m.zellijSession, undefined)
})