import { Astal, Gdk, Gtk } from "ags/gtk4"
import { Accessor, createState } from "gnim"
import { createPoll } from "ags/time"
import { LayerState } from "../utils/LayerState"
import { isPointInsideWidget } from "../utils/pointInside"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"

type ClockMenuState = {
  isOpen: Accessor<boolean>
  setOpen: (open: boolean) => void
}

const LAYER_STATE = new LayerState<ClockMenuState>()

// 1 秒ごとに更新される現在時刻。全モニタで共有する
const now = createPoll(GLib.DateTime.new_now_local(), 1000, () =>
  GLib.DateTime.new_now_local(),
)

// 日本語環境かどうか。日本語なら日本語表記、それ以外は英語表記にする
const IS_JP = GLib.get_language_names()[0].toLowerCase().startsWith("ja")

// get_day_of_week(): 1=月 ... 7=日
const WEEKDAYS_JP = ["月", "火", "水", "木", "金", "土", "日"]
const WEEKDAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const WEEKDAYS_EN_FULL = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]
// get_month(): 1=1月 ... 12=12月
const MONTHS_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

// ロケールに応じた曜日(短縮)。例: 金 / Fri
function weekday(dt: GLib.DateTime): string {
  const i = dt.get_day_of_week() - 1
  return IS_JP ? WEEKDAYS_JP[i] : WEEKDAYS_EN[i]
}

// ロケールに応じた日付。例: 2026年6月5日 (金) / Friday, June 5, 2026
function dateLabel(dt: GLib.DateTime): string {
  if (IS_JP) {
    return `${dt.get_year()}年${dt.get_month()}月${dt.get_day_of_month()}日 (${WEEKDAYS_JP[dt.get_day_of_week() - 1]})`
  }
  return `${WEEKDAYS_EN_FULL[dt.get_day_of_week() - 1]}, ${MONTHS_EN[dt.get_month() - 1]} ${dt.get_day_of_month()}, ${dt.get_year()}`
}

// 例: Asia/Tokyo · JST (UTC+09:00)
function timezoneLabel(dt: GLib.DateTime): string {
  const identifier = dt.get_timezone().get_identifier()
  return `${identifier} · ${dt.format("%Z")} (UTC${dt.format("%:z")})`
}

export function ClockButton({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  return (
    <button
      cssName="ClockButton"
      class={LAYER_STATE.then(gdkmonitor, (state) =>
        state.isOpen((isOpen) => (isOpen ? "pressed" : "")),
      )}
      onClicked={() =>
        LAYER_STATE.then(gdkmonitor, (state) => state.setOpen(!state.isOpen()))
      }
    >
      <label
        cssName="ClockButtonLabel"
        label={now(
          (dt) => `${dt.format("%m/%d")} ${weekday(dt)} ${dt.format("%H:%M")}`,
        )}
      />
    </button>
  )
}

export function ClockMenuLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const [isOpen, setIsOpen] = createState(false)
  const [mounted, setMounted] = createState(false)

  let closeTimeoutId: number | null = null
  let openIdleId: number | null = null

  function clearTimers() {
    if (closeTimeoutId !== null) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = null
    }

    if (openIdleId !== null) {
      GLib.source_remove(openIdleId)
      openIdleId = null
    }
  }

  function setOpen(open: boolean) {
    clearTimers()

    if (open) {
      setMounted(true)

      // mounted=true の反映後に open class を付ける
      // これを分けないと transition が発火しないことがある
      openIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        openIdleId = null
        setIsOpen(true)
        return GLib.SOURCE_REMOVE
      })
    } else {
      setIsOpen(false)

      // CSS transition の終了後に window を消す
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        closeTimeoutId = null

        if (!isOpen()) {
          setMounted(false)
        }

        return GLib.SOURCE_REMOVE
      })
    }
  }

  const states = {
    isOpen,
    setOpen,
  }

  LAYER_STATE.set(gdkmonitor, states)

  const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

  const inner = (
    <box
      cssName="ClockMenu"
      class={isOpen((open) => (open ? "open" : "close"))}
      orientation={Gtk.Orientation.VERTICAL}
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.START}
    >
      {/* バー直下に潜り込ませる分の余白(StartMenu の FirstPadding と同様) */}
      <box cssName="FirstPadding" />

      {/* 上の島: 年月日/曜日 + 時計 + タイムゾーン */}
      <box
        cssName="ClockIsland"
        orientation={Gtk.Orientation.VERTICAL}
        halign={Gtk.Align.FILL}
        hexpand
      >
        <label
          cssName="ClockDate"
          halign={Gtk.Align.CENTER}
          label={now((dt) => dateLabel(dt))}
        />
        <label
          cssName="ClockTime"
          halign={Gtk.Align.CENTER}
          label={now((dt) => dt.format("%H:%M:%S") ?? "")}
        />
        <label
          cssName="ClockTimezone"
          halign={Gtk.Align.CENTER}
          label={now((dt) => timezoneLabel(dt))}
        />
      </box>

      {/* 下の島: カレンダー */}
      <box
        cssName="CalendarIsland"
        orientation={Gtk.Orientation.VERTICAL}
        halign={Gtk.Align.FILL}
        hexpand
      >
        <Gtk.Calendar
          cssName="Calendar"
          showHeading
          showDayNames
          showWeekNumbers={false}
          hexpand
        />
      </box>
    </box>
  ) as Gtk.Box

  const window = (
    <window
      name="clockmenulayer"
      class="ClockMenuLayer"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.NORMAL}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={TOP | LEFT | RIGHT | BOTTOM}
      application={app}
      visible={mounted}
    >
      {inner}
    </window>
  ) as Gtk.Window

  const outsideClick = Gtk.GestureClick.new()
  outsideClick.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)

  outsideClick.connect("pressed", (_g, _n, x, y) => {
    if (!isPointInsideWidget(window, inner, x, y)) {
      states.setOpen(false)
    }
  })

  window.add_controller(outsideClick)

  const keyController = Gtk.EventControllerKey.new()
  keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)

  keyController.connect("key-pressed", (_c, keyval) => {
    if (keyval === Gdk.KEY_Escape) {
      states.setOpen(false)
      return true
    }
    return false
  })

  window.add_controller(keyController)

  return window
}
