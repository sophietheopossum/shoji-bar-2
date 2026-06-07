import GLib from "gi://GLib"
import Gio from "gi://Gio"
import AstalNetwork from "gi://AstalNetwork"
import AstalPowerProfiles from "gi://AstalPowerProfiles"
import AstalNotifd from "gi://AstalNotifd"
import AstalMpris from "gi://AstalMpris"
import AstalWp from "gi://AstalWp"
import AstalBattery from "gi://AstalBattery"
import { createBinding, createComputed, createState } from "gnim"
import { execAsync, subprocess, type Process } from "ags/process"

// =============================================================================
// シングルトン
// =============================================================================

export const network = AstalNetwork.get_default()
export const powerProfiles = AstalPowerProfiles.get_default()
export const notifd = AstalNotifd.get_default()
export const mpris = AstalMpris.get_default()
export const audio = AstalWp.get_default()
export const battery = AstalBattery.get_default()

// =============================================================================
// Wifi
//
// AstalNetwork.Wifi のプロパティ更新が NM 側で起きた変化 (特に外部の nmcli
// による切断) を即時 emit してくれない問題が実機で再現したので、
// **nmcli 出力の自前ポーリングで状態を完全に作る** 方式に切り替えた。
//
// 基本: 3 秒ごとに `nmcli` を叩いて結果を createState に流す。
// WiFi サブメニューを開いた瞬間とアクション直後だけ即時 + 高頻度 (1.5s) に
// 切り替えて反応速度を上げる。
// =============================================================================

/** 自前で作る AP 型。AstalNetwork.AccessPoint と最低限互換: ssid / strength。 */
export type WifiAp = {
  ssid: string
  bssid: string
  /** 0..100 */
  strength: number
  /** "WPA2/WPA3" / "WPA" / "WEP" / "Open" / "Unknown" */
  security: string
  /** 現在この AP に接続しているか */
  inUse: boolean
}

/** AstalNetwork.Internet とほぼ同じ意味の状態 enum。 */
export const WifiInternet = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2,
} as const
export type WifiInternetValue = (typeof WifiInternet)[keyof typeof WifiInternet]

const [wifiEnabledState, setWifiEnabledState] = createState(false)
const [wifiSsidState, setWifiSsidState] = createState<string | null>(null)
const [wifiInternetState, setWifiInternetState] = createState<WifiInternetValue>(
  WifiInternet.DISCONNECTED,
)
const [wifiStrengthState, setWifiStrengthState] = createState(0)
const [wifiScanningState, setWifiScanningState] = createState(false)
const [wifiApsState, setWifiApsState] = createState<WifiAp[]>([])

export const wifiEnabled = wifiEnabledState
export const wifiSsid = wifiSsidState
export const wifiInternet = wifiInternetState
export const wifiStrength = wifiStrengthState
export const wifiScanning = wifiScanningState
export const wifiAccessPoints = wifiApsState

// ---- nmcli -t 出力 (フィールド区切り `:`, 値内 `:` は `\:` でエスケープ) のパース。
function splitNmcliFields(line: string): string[] {
  const fields: string[] = []
  let current = ""
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "\\" && i + 1 < line.length) {
      current += line[i + 1]
      i++
    } else if (ch === ":") {
      fields.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function normalizeSecurity(sec: string): string {
  const s = sec.trim()
  if (s.length === 0 || s === "--") return "Open"
  if (/WPA3|RSN/i.test(s)) return "WPA2/WPA3"
  if (/WPA2/i.test(s)) return "WPA2"
  if (/WPA/i.test(s)) return "WPA"
  if (/WEP/i.test(s)) return "WEP"
  return s
}

export function accessPointRequiresPassword(ap: WifiAp): boolean {
  return ap.security !== "Open"
}

export function accessPointSecurity(ap: WifiAp): string {
  return ap.security
}

// ---- 実ポーリング ----
let pollingIntervalMs = 3000
let pollingTimeoutId: number | null = null
let menuFocusCount = 0
let pollInFlight = false

async function pollWifiState(): Promise<void> {
  if (pollInFlight) return
  pollInFlight = true
  try {
    // 1) Wi-Fi radio enabled?
    let enabled = false
    try {
      const out = await execAsync(["nmcli", "-t", "-f", "WIFI", "radio"])
      const text = typeof out === "string" ? out : ""
      enabled = text.trim() === "enabled"
    } catch (err) {
      console.error("[status] poll: radio failed:", err)
      enabled = false
    }
    setWifiEnabledState(enabled)

    if (!enabled) {
      setWifiSsidState(null)
      setWifiInternetState(WifiInternet.DISCONNECTED)
      setWifiStrengthState(0)
      setWifiApsState([])
      return
    }

    // 2) device 状態から CONNECTED/CONNECTING を判定 + iface 確保
    let deviceState: string | null = null
    try {
      const out = await execAsync([
        "nmcli",
        "-t",
        "-f",
        "TYPE,STATE",
        "device",
      ])
      const text = typeof out === "string" ? out : ""
      for (const line of text.split("\n")) {
        const f = splitNmcliFields(line)
        if (f.length < 2) continue
        if (f[0] === "wifi") {
          deviceState = f[1]
          break
        }
      }
    } catch {
      // ignore
    }

    // 3) AP リスト
    let activeSsid: string | null = null
    let activeStrength = 0
    let aps: WifiAp[] = []
    try {
      const out = await execAsync([
        "nmcli",
        "-t",
        "-f",
        "IN-USE,BSSID,SSID,SIGNAL,SECURITY",
        "device",
        "wifi",
        "list",
        "--rescan",
        "no",
      ])
      const text = typeof out === "string" ? out : ""
      for (const line of text.split("\n")) {
        if (!line) continue
        const f = splitNmcliFields(line)
        if (f.length < 5) continue
        const inUse = f[0] === "*"
        const bssid = f[1]
        const ssid = f[2]
        const strength = Number.parseInt(f[3], 10) || 0
        const security = normalizeSecurity(f[4])
        if (!ssid) continue
        const ap: WifiAp = { ssid, bssid, strength, security, inUse }
        aps.push(ap)
        if (inUse) {
          activeSsid = ssid
          activeStrength = strength
        }
      }
      // 同 SSID dedupe (in-use 優先 → 強度降順)
      const best = new Map<string, WifiAp>()
      for (const ap of aps) {
        const existing = best.get(ap.ssid)
        if (
          !existing ||
          (ap.inUse && !existing.inUse) ||
          (!existing.inUse && ap.strength > existing.strength)
        ) {
          best.set(ap.ssid, ap)
        }
      }
      aps = [...best.values()].sort((a, b) => {
        if (a.inUse !== b.inUse) return a.inUse ? -1 : 1
        return b.strength - a.strength
      })
    } catch (err) {
      console.error("[status] poll: ap list failed:", err)
    }

    setWifiApsState(aps)
    setWifiSsidState(activeSsid)
    setWifiStrengthState(activeStrength)
    // CONNECTING の判定: device state が "connecting" 系
    if (deviceState && /connecting/i.test(deviceState)) {
      setWifiInternetState(WifiInternet.CONNECTING)
    } else if (activeSsid) {
      setWifiInternetState(WifiInternet.CONNECTED)
    } else {
      setWifiInternetState(WifiInternet.DISCONNECTED)
    }
  } finally {
    pollInFlight = false
  }
}

function setPollIntervalAndStart(intervalMs: number) {
  if (pollingTimeoutId !== null && pollingIntervalMs === intervalMs) return
  if (pollingTimeoutId !== null) {
    GLib.source_remove(pollingTimeoutId)
    pollingTimeoutId = null
  }
  pollingIntervalMs = intervalMs
  pollingTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
    void pollWifiState()
    return GLib.SOURCE_CONTINUE
  })
}

/**
 * Wi-Fi サブメニューが開いている間呼ぶことで poll interval を 1.5s に上げる。
 * 戻り値の関数を呼ぶと background interval (3s) に戻る。
 */
export function focusWifiPolling(): () => void {
  menuFocusCount += 1
  if (menuFocusCount === 1) {
    setPollIntervalAndStart(1500)
  }
  void pollWifiState() // 即時更新
  let released = false
  return () => {
    if (released) return
    released = true
    menuFocusCount = Math.max(0, menuFocusCount - 1)
    if (menuFocusCount === 0) {
      setPollIntervalAndStart(3000)
    }
  }
}

// 初期 poll + バックグラウンド 3s polling 開始
setPollIntervalAndStart(3000)
void pollWifiState()

// ---- アクション ----

export function wifiIconName(): string {
  if (!wifiEnabled()) return "wifi-off"
  const s = wifiStrength()
  if (s >= 70) return "wifi-full"
  if (s >= 40) return "wifi-midium"
  if (s >= 10) return "wifi-low"
  return "wifi-off"
}

export async function setWifiEnabled(enabled: boolean): Promise<void> {
  try {
    await execAsync(["nmcli", "radio", "wifi", enabled ? "on" : "off"])
  } catch (err) {
    console.error("[status] wifi set enabled failed:", err)
  }
  void pollWifiState()
}

export async function toggleWifi(): Promise<void> {
  return setWifiEnabled(!wifiEnabledState())
}

/** rescan を明示的に走らせ、scanning フラグを立てる。 */
export async function triggerWifiScan(): Promise<void> {
  if (!wifiEnabledState()) return
  setWifiScanningState(true)
  try {
    await execAsync(["nmcli", "device", "wifi", "rescan"])
  } catch (err) {
    // "Scan request failed: Scanning not allowed immediately" 系は無視。
    const msg = err instanceof Error ? err.message : String(err)
    if (!/not allowed|too soon/i.test(msg)) {
      console.error("[status] rescan failed:", err)
    }
  }
  // 結果反映を少し待ってから poll し、scanning フラグを下ろす。
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
    void pollWifiState().then(() => setWifiScanningState(false))
    return GLib.SOURCE_REMOVE
  })
}

export interface WifiConnectResult {
  ok: boolean
  message?: string
  needsPassword?: boolean
}

function isPasswordError(message: string): boolean {
  return /no[\s-]?secrets?|secret|password|authentication|802-11-wireless-security|invalid-secrets/i.test(
    message,
  )
}

export async function wifiConnect(
  ssid: string,
  password?: string,
): Promise<WifiConnectResult> {
  if (!ssid) {
    return { ok: false, message: "SSID not specified" }
  }
  const args = ["nmcli", "-w", "30", "device", "wifi", "connect", ssid]
  if (password && password.length > 0) {
    args.push("password", password)
  }
  let result: WifiConnectResult
  try {
    await execAsync(args)
    result = { ok: true }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : String(err)
    result = { ok: false, message, needsPassword: isPasswordError(message) }
  }
  // 結果に関わらず短い間隔で 3 回再 poll して状態を確実に反映。
  for (const delay of [200, 800, 1800]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollWifiState()
      return GLib.SOURCE_REMOVE
    })
  }
  return result
}

/**
 * Wi-Fi デバイス自体を DISCONNECTED 状態にする (autoconnect 抑止)。
 */
export async function wifiDisconnect(): Promise<void> {
  let iface: string | null = null
  try {
    const out = await execAsync(["nmcli", "-t", "-f", "DEVICE,TYPE", "device"])
    const text = typeof out === "string" ? out : ""
    for (const line of text.split("\n")) {
      const f = splitNmcliFields(line)
      if (f.length < 2) continue
      if (f[1] === "wifi" && f[0].length > 0) {
        iface = f[0]
        break
      }
    }
  } catch (err) {
    console.error("[status] wifi device list failed:", err)
  }

  if (iface) {
    try {
      await execAsync(["nmcli", "device", "disconnect", iface])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/not active|already/i.test(msg)) {
        console.error("[status] wifi disconnect failed:", err)
      }
    }
  }

  // 即時 UI 反映 + 確実反映のため複数回 poll。
  setWifiSsidState(null)
  setWifiInternetState(WifiInternet.DISCONNECTED)
  setWifiStrengthState(0)
  for (const delay of [150, 600, 1500]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollWifiState()
      return GLib.SOURCE_REMOVE
    })
  }
}

// =============================================================================
// Bluetooth
//
// AstalBluetooth (bluez D-Bus binding) ではなく、Wi-Fi と同じく
// **bluetoothctl の自前ポーリング** で状態を作る。理由は Wi-Fi 同様、外部
// 変更 (他クライアントが繋いだ / 切った) の取りこぼしを避けるため。
//
// 基本: 3 秒ごとに `bluetoothctl show` + `bluetoothctl devices [filter]` を
// 叩いて結果を createState に流す。サブメニューを開いた瞬間とアクション直後
// だけ即時 + 高頻度 (1.5s) に切り替える (focusBluetoothPolling)。
// =============================================================================

export type BtDevice = {
  /** "AA:BB:CC:DD:EE:FF" 形式 */
  mac: string
  /** alias 優先 (空ならアドレスをそのまま) */
  name: string
  paired: boolean
  trusted: boolean
  connected: boolean
}

const [btEnabledState, setBtEnabledState] = createState(false)
const [btScanningState, setBtScanningState] = createState(false)
const [btDevicesState, setBtDevicesState] = createState<BtDevice[]>([])

export const bluetoothEnabled = btEnabledState
export const bluetoothScanning = btScanningState
export const bluetoothDevices = btDevicesState

// 代表表示用: 接続中があればその名前、なければ On / Off
export const bluetoothPrimary = createComputed(() => {
  if (!btEnabledState()) return "Off"
  const connected = btDevicesState().find((d) => d.connected)
  if (connected) return connected.name
  return "On"
})

// ---- bluetoothctl 出力パース ----

function parseDevicesOutput(text: string): { mac: string; name: string }[] {
  const out: { mac: string; name: string }[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    // "Device AA:BB:CC:DD:EE:FF Alias name with spaces"
    const m = line.match(/^Device\s+([0-9A-F:]{17})\s*(.*)$/i)
    if (!m) continue
    out.push({ mac: m[1].toUpperCase(), name: m[2] || m[1].toUpperCase() })
  }
  return out
}

function parseMacs(text: string): Set<string> {
  return new Set(parseDevicesOutput(text).map((d) => d.mac))
}

// ---- 実ポーリング ----
let btPollingIntervalMs = 3000
let btPollingTimeoutId: number | null = null
let btMenuFocusCount = 0
let btPollInFlight = false

async function pollBluetoothState(): Promise<void> {
  if (btPollInFlight) return
  btPollInFlight = true
  try {
    // 1) adapter 状態
    let showText = ""
    try {
      const out = await execAsync(["bluetoothctl", "show"])
      showText = typeof out === "string" ? out : ""
    } catch (err) {
      // adapter が無いケース等。Off 扱いにする。
      setBtEnabledState(false)
      setBtScanningState(false)
      setBtDevicesState([])
      return
    }
    let powered = false
    let discovering = false
    for (const line of showText.split("\n")) {
      if (/^\s*Powered:\s*yes/i.test(line)) powered = true
      if (/^\s*Discovering:\s*yes/i.test(line)) discovering = true
    }
    setBtEnabledState(powered)
    setBtScanningState(discovering)

    if (!powered) {
      setBtDevicesState([])
      return
    }

    // 2) device リスト + フィルタ済みリストで paired / connected / trusted を判定
    const [allText, pairedText, connectedText, trustedText] = await Promise.all([
      execAsync(["bluetoothctl", "devices"]).catch(() => ""),
      execAsync(["bluetoothctl", "devices", "Paired"]).catch(() => ""),
      execAsync(["bluetoothctl", "devices", "Connected"]).catch(() => ""),
      execAsync(["bluetoothctl", "devices", "Trusted"]).catch(() => ""),
    ])
    const all = parseDevicesOutput(typeof allText === "string" ? allText : "")
    const pairedSet = parseMacs(typeof pairedText === "string" ? pairedText : "")
    const connectedSet = parseMacs(
      typeof connectedText === "string" ? connectedText : "",
    )
    const trustedSet = parseMacs(typeof trustedText === "string" ? trustedText : "")

    const devs: BtDevice[] = all.map((d) => ({
      mac: d.mac,
      name: d.name,
      paired: pairedSet.has(d.mac),
      trusted: trustedSet.has(d.mac),
      connected: connectedSet.has(d.mac),
    }))
    devs.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1
      if (a.paired !== b.paired) return a.paired ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    setBtDevicesState(devs)
  } finally {
    btPollInFlight = false
  }
}

function setBtPollIntervalAndStart(intervalMs: number) {
  if (btPollingTimeoutId !== null && btPollingIntervalMs === intervalMs) return
  if (btPollingTimeoutId !== null) {
    GLib.source_remove(btPollingTimeoutId)
    btPollingTimeoutId = null
  }
  btPollingIntervalMs = intervalMs
  btPollingTimeoutId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    intervalMs,
    () => {
      void pollBluetoothState()
      return GLib.SOURCE_CONTINUE
    },
  )
}

/**
 * Bluetooth サブメニュー表示中に呼ぶと poll を 1.5s に上げる。
 * 戻り値の関数で 3s に戻す。
 */
export function focusBluetoothPolling(): () => void {
  btMenuFocusCount += 1
  if (btMenuFocusCount === 1) {
    setBtPollIntervalAndStart(1500)
  }
  void pollBluetoothState() // 即時更新
  let released = false
  return () => {
    if (released) return
    released = true
    btMenuFocusCount = Math.max(0, btMenuFocusCount - 1)
    if (btMenuFocusCount === 0) {
      setBtPollIntervalAndStart(3000)
    }
  }
}

// 初期 poll + バックグラウンド 3s polling
setBtPollIntervalAndStart(3000)
void pollBluetoothState()

// ---- ペアリング agent ----
//
// BlueZ は SSP (Secure Simple Pairing) の passkey 確認に **agent の登録** を
// 要求する。agent が居ないと bluetoothd に
//   `No agent available for request type 2`
//   `device_confirm_passkey: Operation not permitted`
// が出てペアリングがタイムアウトし、せっかく繋がっても数秒で
// `org.bluez.Reason.Local Connection terminated by local host` で切られる。
//
// bluetoothctl 一発実行スタイルでは agent はそのプロセスの生存期間しか
// 登録されないので、ここで **常駐 bluetoothctl** を起動して agent を維持する。
// stdin が pipe で開きっぱなしなので bluetoothctl は EOF せずに動き続ける。
//
// NoInputNoOutput = キーボードもディスプレイも無いデバイス用の capability。
// 全 SSP 要求を自動で受諾する (= ユーザー操作不要)。本デスクトップ環境では
// 我々がメニューで「接続」ボタンを押した時点でユーザー意図は表明されている
// ので auto-accept でよい。
let btAgentProc: Process | null = null
function startBluetoothAgent() {
  if (btAgentProc) return
  try {
    btAgentProc = subprocess(
      ["bluetoothctl", "--agent", "NoInputNoOutput"],
      // 普段は何も出さない。診断したいときは console.log に差し替える。
      () => {},
      () => {},
    )
    btAgentProc.connect("exit", (_self, code, signaled) => {
      console.error(
        `[status] bluetooth agent exited (code=${code} signaled=${signaled}); restarting in 2s`,
      )
      btAgentProc = null
      // 何らかの理由で死んだら 2 秒後に再起動 (連続失敗の暴走を防ぐ簡易リミット)。
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        startBluetoothAgent()
        return GLib.SOURCE_REMOVE
      })
    })
  } catch (err) {
    console.error("[status] failed to start bluetooth agent:", errMessage(err))
  }
}
startBluetoothAgent()

// ---- アクション ----

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.toString()
  if (typeof err === "string") return err
  return String(err)
}

async function tryUnblockBluetooth(): Promise<void> {
  // BT は rfkill でソフト/ハードブロックされうる。ハードブロック (物理スイッチ等)
  // はユーザー操作が必要なので何もできないが、ソフトブロックは `rfkill unblock`
  // で外せる。off-blocked 状態だと bluetoothctl power on は org.bluez.Error.Failed
  // を返してしまうのでここで先に解除する。
  try {
    await execAsync(["rfkill", "unblock", "bluetooth"])
  } catch (err) {
    // 失敗しても致命ではない (既に unblock 済みなら成功するはずで、本当に
    // 失敗するのは権限不足など)。診断のためログだけ残す。
    console.error("[status] rfkill unblock bluetooth failed:", errMessage(err))
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    }),
  )
}

/** bluetoothctl show を 1 度叩いて Powered / PowerState 抜粋を返す。 */
async function readBluetoothPower(): Promise<{
  powered: boolean
  transitional: boolean
}> {
  try {
    const out = await execAsync(["bluetoothctl", "show"])
    const text = typeof out === "string" ? out : ""
    const powered = /^\s*Powered:\s*yes/im.test(text)
    // on-disabling / off-enabling は遷移中状態。stuck の検出に使う。
    const transitional =
      /^\s*PowerState:\s*(on-disabling|off-enabling)/im.test(text)
    return { powered, transitional }
  } catch {
    return { powered: false, transitional: false }
  }
}

/** rfkill cycle で adapter を完全リセット (on-disabling 等の stuck から復旧)。 */
async function rfkillResetBluetooth(): Promise<void> {
  await execAsync(["rfkill", "block", "bluetooth"]).catch((err) => {
    console.error("[status] rfkill block bluetooth failed:", errMessage(err))
  })
  await waitMs(600)
  await execAsync(["rfkill", "unblock", "bluetooth"]).catch((err) => {
    console.error("[status] rfkill unblock bluetooth failed:", errMessage(err))
  })
  await waitMs(800)
}

export async function setBluetoothEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await tryUnblockBluetooth()

    // 直前の rfkill unblock 後など、ごく短時間 org.bluez.Error.Busy が返る
    // ケースがあるので軽くリトライする。
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await execAsync(["bluetoothctl", "power", "on"])
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        const msg = errMessage(err)
        if (!/Busy/i.test(msg)) break
        await waitMs(400)
      }
    }

    // Busy / NotReady が解消しないときは adapter が on-disabling 等で stuck
    // している可能性が高いので rfkill cycle で reset → 再 ON。
    if (lastErr !== null) {
      const msg = errMessage(lastErr)
      console.error("[status] bluetoothctl power on failed:", msg)
      if (/Busy|NotReady/i.test(msg)) {
        console.error("[status] attempting rfkill cycle to recover stuck adapter")
        await rfkillResetBluetooth()
        try {
          await execAsync(["bluetoothctl", "power", "on"])
        } catch (err2) {
          console.error(
            "[status] bluetoothctl power on retry failed:",
            errMessage(err2),
          )
        }
      }
    }
  } else {
    // まず正攻法で power off。
    try {
      await execAsync(["bluetoothctl", "power", "off"])
    } catch (err) {
      // Busy 等。続行して下でフォールバックを試す。
      const msg = errMessage(err)
      if (!/Busy/i.test(msg)) {
        console.error("[status] bluetoothctl power off failed:", msg)
      }
    }

    // 1.5 秒待って実 state を確認し、まだ off に到達していなければ
    // rfkill block で kernel レベルで強制 off にする (on-disabling stuck 救済)。
    await waitMs(1500)
    const state = await readBluetoothPower()
    if (state.powered || state.transitional) {
      console.error(
        "[status] bluetooth power off did not complete; forcing rfkill block",
      )
      try {
        await execAsync(["rfkill", "block", "bluetooth"])
      } catch (err) {
        console.error("[status] rfkill block bluetooth failed:", errMessage(err))
      }
    }
  }

  // 状態反映を確認する poll を複数回スケジュール。
  for (const delay of [150, 600, 1500, 3000]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollBluetoothState()
      return GLib.SOURCE_REMOVE
    })
  }
}

export async function toggleBluetooth(): Promise<void> {
  return setBluetoothEnabled(!btEnabledState())
}

/**
 * scan を 15 秒間 (bluetoothctl の --timeout 機能) 走らせる。
 * fire-and-forget で実行: bluetoothctl は --timeout 経過まで生き続けるので
 * await はせず、poll で Discovering: yes/no を観測する。
 *
 * UI 反応性のため、既に scanning 中の再 click でも単純に skip せず、
 * 実 adapter 側の Discovering 状態を見て本当に動いているか確認する。
 * (optimistic flag が古いまま stuck することがあるため。)
 */
export async function triggerBluetoothScan(): Promise<void> {
  if (!btEnabledState()) return
  // optimistic flag を立てる前に実 state を確認: 既に Discovering:yes なら
  // 重複起動を避けつつ flag を真値に揃える。Discovering:no なのに flag が
  // 立っているのは stuck なので、ここで flag を一度クリアして再 trigger できる
  // ようにする。
  const state = await readBluetoothPower()
  if (!state.powered) return

  setBtScanningState(true)
  void execAsync(["bluetoothctl", "--timeout", "15", "scan", "on"]).catch(
    (err) => {
      const msg = errMessage(err)
      // "Already discovering" は無視できる
      if (!/Already|discovering/i.test(msg)) {
        console.error("[status] bluetoothctl scan on failed:", msg)
      }
    },
  )
  for (const delay of [300, 1200, 3000, 8000, 15500]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollBluetoothState()
      return GLib.SOURCE_REMOVE
    })
  }
}

export interface BluetoothConnectResult {
  ok: boolean
  message?: string
}

/** bluetoothctl info <mac> の Connected: フィールドを真値で取得。 */
async function isDeviceConnected(mac: string): Promise<boolean> {
  try {
    const out = await execAsync(["bluetoothctl", "info", mac])
    const text = typeof out === "string" ? out : ""
    return /^\s*Connected:\s*yes/im.test(text)
  } catch {
    return false
  }
}

function scheduleBluetoothRepoll() {
  for (const delay of [200, 800, 1800]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollBluetoothState()
      return GLib.SOURCE_REMOVE
    })
  }
}

/**
 * デバイスへ接続。未 paired ならまず pair → trust してから connect。
 *
 * 注意: Classic BT (BR/EDR) の場合 `bluetoothctl pair` の段階で
 * 接続まで自動で完了する。そのまま `bluetoothctl connect` を呼ぶと
 * `org.bluez.Error.Failed br-connection-unknown` などで失敗扱いに
 * なるが、実 state では Connected: yes なので、各 step で失敗を
 * 拾ったら必ず info を見て **実際の接続状態** を優先的に判定する。
 *
 * PIN が必要な場合は bluez の system agent (gnome-shell 等) が出てくる。
 */
export async function bluetoothConnect(
  mac: string,
): Promise<BluetoothConnectResult> {
  const dev = btDevicesState().find((d) => d.mac === mac)
  if (!dev) return { ok: false, message: "Unknown device" }

  if (!dev.paired) {
    let pairErr: unknown = null
    try {
      await execAsync(["bluetoothctl", "pair", mac])
    } catch (err) {
      pairErr = err
    }
    // pair の成功失敗に関わらず、実 state が Connected: yes ならその時点で成功扱い。
    if (await isDeviceConnected(mac)) {
      try {
        await execAsync(["bluetoothctl", "trust", mac])
      } catch {
        // trust 失敗は致命ではない
      }
      scheduleBluetoothRepoll()
      return { ok: true }
    }
    if (pairErr !== null) {
      scheduleBluetoothRepoll()
      return { ok: false, message: errMessage(pairErr) }
    }
    // pair は成功したが connected ではない (これから明示的 connect が要る)
    try {
      await execAsync(["bluetoothctl", "trust", mac])
    } catch {
      // trust 失敗は致命ではない
    }
  }

  try {
    await execAsync(["bluetoothctl", "connect", mac])
    scheduleBluetoothRepoll()
    return { ok: true }
  } catch (err) {
    // connect が失敗を返しても実 state が Connected: yes なら成功扱い
    // (Classic BT の二重 connect で br-connection-unknown が出るケース)。
    if (await isDeviceConnected(mac)) {
      scheduleBluetoothRepoll()
      return { ok: true }
    }
    scheduleBluetoothRepoll()
    return { ok: false, message: errMessage(err) }
  }
}

export async function bluetoothDisconnect(mac: string): Promise<void> {
  try {
    await execAsync(["bluetoothctl", "disconnect", mac])
  } catch (err) {
    const msg = errMessage(err)
    if (!/not connected|not available/i.test(msg)) {
      console.error("[status] bluetooth disconnect failed:", msg)
    }
  }
  for (const delay of [150, 600, 1500]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollBluetoothState()
      return GLib.SOURCE_REMOVE
    })
  }
}

// =============================================================================
// Power Profiles Daemon
// =============================================================================

export const ppdActive = createBinding(powerProfiles, "activeProfile")

export const ppdProfiles = createComputed(() => {
  return powerProfiles.get_profiles().map((p) => p.profile)
})

export function setPpdProfile(profile: string) {
  powerProfiles.set_active_profile(profile)
}

export function ppdIconNameFor(profile: string | null | undefined): string {
  switch (profile) {
    case "power-saver":
      return "leaf"
    case "performance":
      return "lightning"
    case "balanced":
      return "balanced"
    default:
      return "balanced"
  }
}

export function ppdLabel(profile: string | null | undefined): string {
  switch (profile) {
    case "power-saver":
      return "Power Saver"
    case "performance":
      return "Performance"
    case "balanced":
      return "Balanced"
    default:
      return profile && profile.length > 0 ? profile : "Unknown"
  }
}

// =============================================================================
// Notifications
// =============================================================================

export const notifDnd = createBinding(notifd, "dontDisturb")

const [notifListState, setNotifListState] = createState<AstalNotifd.Notification[]>([])
export const notifList = notifListState

function refreshNotifList() {
  const list = notifd.get_notifications().slice()
  list.sort((a, b) => b.time - a.time)
  setNotifListState(list)
}

notifd.connect("notify::notifications", refreshNotifList)
notifd.connect("notified", refreshNotifList)
notifd.connect("resolved", refreshNotifList)
refreshNotifList()

export function toggleDnd() {
  notifd.dontDisturb = !notifd.dontDisturb
}

export function dismissNotification(n: AstalNotifd.Notification) {
  n.dismiss()
}

export function dismissAllNotifications() {
  for (const n of notifd.get_notifications()) {
    n.dismiss()
  }
}

// =============================================================================
// Audio (volume)
//
// createBinding(audio, "defaultSpeaker") は default_speaker の入替えしか拾わ
// ないため、speaker.volume / speaker.mute の変化はそのままでは反映されない。
// 起動直後に PulseAudio がまだ準備できていない場合、speaker は存在しても
// volume が 0 のまま読まれてしまう問題もあるため、speaker に対する
// notify::volume / notify::mute を直接 listen して reactive state に流す。
// =============================================================================

const [speakerVolumeState, setSpeakerVolumeState] = createState(0)
const [speakerMuteState, setSpeakerMuteState] = createState(false)

export const speakerVolume = speakerVolumeState
export const speakerMute = speakerMuteState

let currentSpeaker: import("gi://AstalWp").default.Endpoint | null = null
let currentSpeakerHandlerIds: number[] = []

function unbindSpeaker() {
  if (currentSpeaker) {
    for (const id of currentSpeakerHandlerIds) {
      try {
        currentSpeaker.disconnect(id)
      } catch {
        // ignore
      }
    }
  }
  currentSpeaker = null
  currentSpeakerHandlerIds = []
}

function bindSpeaker(s: import("gi://AstalWp").default.Endpoint | null) {
  unbindSpeaker()
  if (!s) {
    setSpeakerVolumeState(0)
    setSpeakerMuteState(false)
    return
  }
  currentSpeaker = s
  setSpeakerVolumeState(s.volume)
  setSpeakerMuteState(s.mute)
  currentSpeakerHandlerIds.push(
    s.connect("notify::volume", () => setSpeakerVolumeState(s.volume)),
  )
  currentSpeakerHandlerIds.push(
    s.connect("notify::mute", () => setSpeakerMuteState(s.mute)),
  )
}

audio.connect("notify::default-speaker", () => bindSpeaker(audio.default_speaker))
bindSpeaker(audio.default_speaker)

export function setSpeakerVolume(v: number) {
  const s = audio.default_speaker
  if (!s) return
  s.set_volume(Math.max(0, Math.min(1, v)))
}

export function toggleSpeakerMute() {
  const s = audio.default_speaker
  if (!s) return
  s.set_mute(!s.mute)
}

export function volumeIconName(): string {
  if (speakerMuteState()) return "volume-off"
  return speakerVolumeState() > 0 ? "volume" : "volume-off"
}

// =============================================================================
// Brightness (brightnessctl 経由 — Astal に backend lib が無い)
// =============================================================================

const BACKLIGHT_PATH = "/sys/class/backlight"

function findBacklightDevice(): string | null {
  try {
    const dir = Gio.File.new_for_path(BACKLIGHT_PATH)
    const enumerator = dir.enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    const info = enumerator.next_file(null)
    enumerator.close(null)
    return info ? info.get_name() : null
  } catch {
    return null
  }
}

const backlightDevice = findBacklightDevice()

function readBacklightValue(name: "brightness" | "max_brightness"): number {
  if (!backlightDevice) return 0
  try {
    const file = Gio.File.new_for_path(`${BACKLIGHT_PATH}/${backlightDevice}/${name}`)
    const [, contents] = file.load_contents(null)
    return Number.parseInt(new TextDecoder().decode(contents).trim(), 10) || 0
  } catch {
    return 0
  }
}

const maxBrightness = readBacklightValue("max_brightness") || 100

const [brightnessState, setBrightnessState] = createState(
  readBacklightValue("brightness") / maxBrightness,
)
export const brightness = brightnessState

// 値を直接書く時は brightnessctl で。読み戻しは 500ms polling。
let lastWrittenAt = 0
function pollBrightness() {
  // 直前に書き込んだ直後は OS 反映待ちでブレるので skip
  if (Date.now() - lastWrittenAt < 1000) return
  const value = readBacklightValue("brightness") / maxBrightness
  if (Math.abs(value - brightnessState()) > 0.005) {
    setBrightnessState(value)
  }
}
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
  pollBrightness()
  return GLib.SOURCE_CONTINUE
})

export function setBrightness(v: number) {
  const clamped = Math.max(0, Math.min(1, v))
  setBrightnessState(clamped)
  lastWrittenAt = Date.now()
  const percent = Math.round(clamped * 100)
  execAsync(["brightnessctl", "set", `${percent}%`]).catch((err) => {
    console.error("[status] brightnessctl failed:", err)
  })
}

export function brightnessAvailable(): boolean {
  return backlightDevice !== null
}

// =============================================================================
// Mpris (media player)
//
// Player の title / artist / art_url / playback_status は GObject の
// notify::<prop> として emit される。createComputed で playersState を見るだけ
// だと list の入替えしか拾えないので、現在の primary player に対して個別の
// notify::* を listen し、reactive state に流す。
// =============================================================================

const [playersState, setPlayersState] = createState<AstalMpris.Player[]>([])
export const mprisPlayers = playersState

const [primaryPlayerState, setPrimaryPlayerState] =
  createState<AstalMpris.Player | null>(null)
/** 操作 (play_pause / next / previous) のために生 Player を保持。 */
export const primaryPlayer = primaryPlayerState

const [mediaTitleState, setMediaTitleState] = createState<string>("")
const [mediaArtistState, setMediaArtistState] = createState<string>("")
const [mediaArtUrlState, setMediaArtUrlState] = createState<string>("")
const [mediaPlaybackStatusState, setMediaPlaybackStatusState] =
  createState<AstalMpris.PlaybackStatus>(AstalMpris.PlaybackStatus.STOPPED)
const [mediaLengthState, setMediaLengthState] = createState<number>(0)
const [mediaCanGoNextState, setMediaCanGoNextState] = createState<boolean>(false)
const [mediaCanGoPreviousState, setMediaCanGoPreviousState] =
  createState<boolean>(false)

export const mediaTitle = mediaTitleState
export const mediaArtist = mediaArtistState
export const mediaArtUrl = mediaArtUrlState
export const mediaPlaybackStatus = mediaPlaybackStatusState
export const mediaLength = mediaLengthState
export const mediaCanGoNext = mediaCanGoNextState
export const mediaCanGoPrevious = mediaCanGoPreviousState

function syncPlayer(p: AstalMpris.Player) {
  setMediaTitleState(p.title ?? "")
  setMediaArtistState(p.artist ?? "")
  setMediaArtUrlState(p.artUrl ?? "")
  setMediaPlaybackStatusState(p.playbackStatus)
  setMediaLengthState(p.length)
  setMediaCanGoNextState(p.canGoNext)
  setMediaCanGoPreviousState(p.canGoPrevious)
}

function clearMediaState() {
  setMediaTitleState("")
  setMediaArtistState("")
  setMediaArtUrlState("")
  setMediaPlaybackStatusState(AstalMpris.PlaybackStatus.STOPPED)
  setMediaLengthState(0)
  setMediaCanGoNextState(false)
  setMediaCanGoPreviousState(false)
}

let currentPlayer: AstalMpris.Player | null = null
let currentPlayerHandlerIds: number[] = []

function unbindCurrentPlayer() {
  if (currentPlayer) {
    for (const id of currentPlayerHandlerIds) {
      try {
        currentPlayer.disconnect(id)
      } catch {
        // ignore
      }
    }
  }
  currentPlayer = null
  currentPlayerHandlerIds = []
}

function bindPlayer(p: AstalMpris.Player | null) {
  if (p === currentPlayer) return
  unbindCurrentPlayer()
  setPrimaryPlayerState(p)
  if (!p) {
    clearMediaState()
    return
  }
  currentPlayer = p
  syncPlayer(p)
  const props = [
    "notify::title",
    "notify::artist",
    "notify::art-url",
    "notify::playback-status",
    "notify::length",
    "notify::can-go-next",
    "notify::can-go-previous",
  ] as const
  for (const sig of props) {
    currentPlayerHandlerIds.push(p.connect(sig, () => syncPlayer(p)))
  }
}

function pickPrimaryPlayer(): AstalMpris.Player | null {
  const list = playersState()
  if (list.length === 0) return null
  const playing = list.find(
    (q) => q.playbackStatus === AstalMpris.PlaybackStatus.PLAYING,
  )
  return playing ?? list[0]
}

function refreshPlayers() {
  setPlayersState(mpris.get_players().slice())
  bindPlayer(pickPrimaryPlayer())
}

mpris.connect("notify::players", refreshPlayers)
mpris.connect("player-added", refreshPlayers)
mpris.connect("player-closed", refreshPlayers)
refreshPlayers()

// 再生中ステータスが変わったら primary も切替え(複数プレーヤーが立ってる時用)。
// playback-status は player ごとの notify なので、再 evaluate を周期的に行う
// だけでよい。1 秒に 1 度 pickPrimary を見直す。
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
  const next = pickPrimaryPlayer()
  if (next !== currentPlayer) bindPlayer(next)
  return GLib.SOURCE_CONTINUE
})

export function formatMprisTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00"
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
  return `${m}:${s.toString().padStart(2, "0")}`
}

// =============================================================================
// Battery (AstalBattery — upower D-Bus 越し。プロパティ更新は安定して
// notify が来るので Wi-Fi のような自前ポーリングは不要)
// =============================================================================

export const batteryPresent = createBinding(battery, "isPresent")
export const batteryPercentage = createBinding(battery, "percentage")
export const batteryCharging = createBinding(battery, "charging")
export const batteryState = createBinding(battery, "state")
export const batteryTimeToEmpty = createBinding(battery, "timeToEmpty")
export const batteryTimeToFull = createBinding(battery, "timeToFull")
export const batteryEnergyRate = createBinding(battery, "energyRate")
export const batteryChargeCycles = createBinding(battery, "chargeCycles")
export const batteryTemperature = createBinding(battery, "temperature")

/** 残量(0..1) + state を見て表示用 SVG ファイル名を返す。
 * AC 接続中 (CHARGING / PENDING_CHARGE / FULLY_CHARGED) は常に
 * battery-charging を出す。`batteryCharging` 派生プロパティは
 * PENDING_CHARGE のとき false になるので state を直接見る。 */
export function batteryIconName(): string {
  const s = batteryState()
  if (
    s === AstalBattery.State.CHARGING ||
    s === AstalBattery.State.PENDING_CHARGE ||
    s === AstalBattery.State.FULLY_CHARGED
  ) {
    return "battery-charging"
  }
  const p = batteryPercentage()
  if (p >= 0.75) return "battery-full"
  if (p >= 0.4) return "battery-midium"
  if (p >= 0.15) return "battery-low"
  return "battery-very-low"
}

/** upower の State enum を人が読める文字列に。 */
export function batteryStateLabel(): string {
  switch (batteryState()) {
    case AstalBattery.State.CHARGING:
      return "Charging"
    case AstalBattery.State.DISCHARGING:
      return "Discharging"
    case AstalBattery.State.EMPTY:
      return "Empty"
    case AstalBattery.State.FULLY_CHARGED:
      return "Fully charged"
    case AstalBattery.State.PENDING_CHARGE:
      return "Pending charge"
    case AstalBattery.State.PENDING_DISCHARGE:
      return "Pending discharge"
    default:
      return "Unknown"
  }
}

/** "1h 23m" 形式に整形 (0 → "—")。 */
export function formatBatteryDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—"
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
