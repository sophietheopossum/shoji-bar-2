import GLib from "gi://GLib"
import Gio from "gi://Gio"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalPowerProfiles from "gi://AstalPowerProfiles"
import AstalNotifd from "gi://AstalNotifd"
import AstalMpris from "gi://AstalMpris"
import AstalWp from "gi://AstalWp"
import { createBinding, createComputed, createState } from "gnim"
import { execAsync } from "ags/process"

// =============================================================================
// シングルトン
// =============================================================================

export const network = AstalNetwork.get_default()
export const bluetooth = AstalBluetooth.get_default()
export const powerProfiles = AstalPowerProfiles.get_default()
export const notifd = AstalNotifd.get_default()
export const mpris = AstalMpris.get_default()
export const audio = AstalWp.get_default()

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
// =============================================================================

export const bluetoothEnabled = createBinding(bluetooth, "isPowered")

const [btDevicesState, setBtDevicesState] = createState<AstalBluetooth.Device[]>([])
export const bluetoothDevices = btDevicesState

function refreshBtDevices() {
  const devs = bluetooth.get_devices().slice()
  devs.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1
    if (a.paired !== b.paired) return a.paired ? -1 : 1
    return (a.name ?? "").localeCompare(b.name ?? "")
  })
  setBtDevicesState(devs)
}

bluetooth.connect("notify::devices", refreshBtDevices)
bluetooth.connect("device-added", refreshBtDevices)
bluetooth.connect("device-removed", refreshBtDevices)
refreshBtDevices()

// 代表表示用: 接続中があればその名前、なければ "Off" or "Available"
export const bluetoothPrimary = createComputed(() => {
  if (!bluetoothEnabled()) return "Off"
  const connected = btDevicesState().find((d) => d.connected)
  if (connected) return connected.name ?? connected.alias ?? "Connected"
  return "On"
})

export function toggleBluetooth() {
  const adapter = bluetooth.adapter
  if (!adapter) return
  adapter.powered = !adapter.powered
}

export function toggleBluetoothDevice(dev: AstalBluetooth.Device) {
  if (dev.connected) {
    dev.disconnect_device(() => {})
  } else {
    dev.connect_device(() => {})
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
