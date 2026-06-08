import { Gtk } from "ags/gtk4"
import { For, createBinding, onCleanup } from "gnim"
import AstalTray from "gi://AstalTray"

// SNI(StatusNotifierItem)ホスト。アプリのトレイアイコンを集約する。
const tray = AstalTray.get_default()

// バーのシステムトレイ。トレイアイテムを横に並べ、アイテムが 0 個なら非表示。
// 全体を灰色半透明の丸角 box で囲ってトレイだと分かるようにする。
export function SystemTray() {
  const items = createBinding(tray, "items")

  return (
    <box
      cssName="SystemTray"
      visible={items((list) => list.length > 0)}
      valign={Gtk.Align.CENTER}
    >
      <For each={items}>
        {(item: AstalTray.TrayItem) => buildTrayItem(item)}
      </For>
    </box>
  )
}

// 1 アイテム = 1 ボタン。クリックで dbusmenu の popover を出す。
// メニューを持たないアイテムは activate() にフォールバックする。
function buildTrayItem(item: AstalTray.TrayItem): Gtk.Widget {
  let popover: Gtk.PopoverMenu | null = null

  const button = (
    <button
      cssName="SystemTrayItem"
      tooltipText={createBinding(item, "tooltipText")}
      onClicked={() => {
        // 遅延生成されるメニューに備え、表示前に about_to_show を呼ぶ
        item.about_to_show()
        const model = item.get_menu_model()
        if (model) {
          if (!popover) {
            popover = Gtk.PopoverMenu.new_from_model(model)
            popover.set_has_arrow(true)
            popover.set_position(Gtk.PositionType.BOTTOM)
            // スコープ用クラス(グローバルテーマ貫通を防ぐ)
            popover.add_css_class("SystemTrayPopover")
            popover.set_parent(button)
          } else {
            popover.set_menu_model(model)
          }
          const actionGroup = item.get_action_group()
          if (actionGroup) {
            button.insert_action_group("dbusmenu", actionGroup)
          }
          popover.popup()
        } else {
          // メニューが無いアイテムは左クリックで activate
          item.activate(0, 0)
        }
      }}
    >
      <image
        cssName="SystemTrayIcon"
        gicon={createBinding(item, "gicon")}
        pixelSize={16}
      />
    </button>
  ) as Gtk.Widget

  onCleanup(() => {
    if (popover) {
      popover.unparent()
      popover = null
    }
  })

  return button
}
