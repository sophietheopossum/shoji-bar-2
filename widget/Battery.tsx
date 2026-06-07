import { Gtk } from "ags/gtk4"
import { createComputed, createState } from "gnim"
import {
  batteryChargeCycles,
  batteryCharging,
  batteryEnergyRate,
  batteryIconName,
  batteryPercentage,
  batteryPresent,
  batteryState,
  batteryStateLabel,
  batteryTemperature,
  batteryTimeToEmpty,
  batteryTimeToFull,
  formatBatteryDuration,
} from "../utils/statusServices"

/**
 * バー上のバッテリーインジケーター。
 * - present でないときは widget 自体を見えなくする
 *   (`visible` バインディング: presence は基本起動後変わらないので
 *    リアクティブで起こる問題は少ない)
 * - 残量に応じてアイコンを切替え
 * - 等幅 3 桁の "%X" 表記
 * - クリックで popover を出して詳細情報を表示
 */
export function BatteryButton() {
  // popover 開閉状態 (menubutton の active プロパティと連動)。
  // pressed クラスを切替えて他のバーボタンと同じ accent 色背景にする + アイコンを
  // 黒バージョンに差し替える。
  const [pressed, setPressed] = createState(false)

  // 0..1 を 0..100 整数に。フォントは monospace のまま (等幅維持) だが、
  // 順番がアイコンより前 (左端) なので空白で埋めると見栄えが悪い。padStart は
  // やらず、桁の揺れは右側 (= アイコン位置) で吸収する。
  const percentLabel = createComputed(() => {
    const p = batteryPercentage()
    const n = Math.round(Math.max(0, Math.min(1, p)) * 100)
    return `${n}%`
  })

  // アイコンファイル名: percentage / state / pressed の組合せで決まる。
  // pressed (= popover 開いてる) ときは accent 色背景上なので -dark を使う。
  const iconFile = createComputed(() => {
    batteryPercentage()
    batteryState()
    const dark = pressed() ? "-dark" : ""
    return `${SRC}/assets/${batteryIconName()}${dark}.svg`
  })

  // popover 内の大きいアイコンは常に bg-color の上に乗るので白固定。
  const iconFileWhite = createComputed(() => {
    batteryPercentage()
    batteryState()
    return `${SRC}/assets/${batteryIconName()}.svg`
  })

  // ---- popover content ----
  // 残り時間: discharging のときは timeToEmpty、charging のときは timeToFull。
  const remainingText = createComputed(() => {
    if (batteryCharging()) {
      const t = batteryTimeToFull()
      return t > 0 ? `${formatBatteryDuration(t)} to full` : "Calculating..."
    }
    const t = batteryTimeToEmpty()
    return t > 0 ? `${formatBatteryDuration(t)} remaining` : "Calculating..."
  })

  const stateText = createComputed(() => {
    batteryState()
    return batteryStateLabel()
  })

  const rateText = createComputed(() => {
    const r = batteryEnergyRate()
    if (!isFinite(r) || r <= 0) return "—"
    return `${r.toFixed(1)} W`
  })

  const cyclesText = createComputed(() => {
    const c = batteryChargeCycles()
    return c > 0 ? c.toString() : "—"
  })

  const tempText = createComputed(() => {
    const t = batteryTemperature()
    if (!isFinite(t) || t === 0) return "—"
    return `${t.toFixed(1)} °C`
  })

  const percentBigText = createComputed(() => {
    const p = batteryPercentage()
    return `${Math.round(p * 100)}%`
  })

  return (
    <menubutton
      cssName="BatteryButton"
      class={pressed((p) => (p ? "pressed" : ""))}
      visible={batteryPresent}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        // popover 開閉を pressed state に反映 (menubutton.active を観測)。
        self.connect("notify::active", () => setPressed(self.get_active()))
        // menubutton の child を image にしつつ、横にラベルも並べたいので
        // 自前で box を組み立てる。
        const row = (
          <box cssName="BatteryRow" spacing={4} valign={Gtk.Align.CENTER}>
            <label cssName="BatteryPercent" label={percentLabel} />
            <image cssName="BatteryIcon" file={iconFile} pixelSize={14} />
          </box>
        ) as Gtk.Widget
        self.set_child(row)
      }}
    >
      <popover cssName="BatteryPopover" hasArrow={false}>
        <box
          cssName="BatteryPopoverBox"
          orientation={Gtk.Orientation.VERTICAL}
          spacing={6}
        >
          <box cssName="BatteryPopoverHeader" spacing={10} valign={Gtk.Align.CENTER}>
            <image
              cssName="BatteryPopoverIcon"
              file={iconFileWhite}
              pixelSize={28}
            />
            <box orientation={Gtk.Orientation.VERTICAL}>
              <label
                cssName="BatteryPopoverPercent"
                halign={Gtk.Align.START}
                label={percentBigText}
              />
              <label
                cssName="BatteryPopoverState"
                halign={Gtk.Align.START}
                label={stateText}
              />
            </box>
          </box>

          <box cssName="BatteryPopoverSep" />

          {detailRow("Remaining", remainingText)}
          {detailRow("Power draw", rateText)}
          {detailRow("Charge cycles", cyclesText)}
          {detailRow("Temperature", tempText)}
        </box>
      </popover>
    </menubutton>
  )
}

function detailRow(
  label: string,
  value: import("gnim").Accessor<string>,
): Gtk.Widget {
  return (
    <box cssName="BatteryDetailRow" spacing={8}>
      <label
        cssName="BatteryDetailLabel"
        halign={Gtk.Align.START}
        hexpand
        label={label}
      />
      <label
        cssName="BatteryDetailValue"
        halign={Gtk.Align.END}
        label={value}
      />
    </box>
  ) as Gtk.Widget
}
