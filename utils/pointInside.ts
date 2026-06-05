import { Gtk } from "ags/gtk4"

// (x, y) は root（ジェスチャを付けた widget）の座標系で渡される。
// widget.contains() は「その widget のローカル座標」を期待するため、
// halign=CENTER や transform で位置がずれていると座標系が合わず誤判定する。
//
// 代わりに GTK 本来のヒットテスト pick() を使い、クリック位置にある widget が
// target（またはその子孫）かどうかを祖先方向に辿って判定する。
// これなら中央寄せや CSS transform があっても正しく内外を判定できる。
export function isPointInsideWidget(
  root: Gtk.Widget,
  target: Gtk.Widget,
  x: number,
  y: number,
): boolean {
  let widget: Gtk.Widget | null = root.pick(x, y, Gtk.PickFlags.DEFAULT)

  while (widget !== null) {
    if (widget === target) {
      return true
    }
    widget = widget.get_parent()
  }

  return false
}
