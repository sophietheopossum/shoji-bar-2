import { Astal, Gdk, Gtk } from "ags/gtk4"
import { Accessor, createState } from "gnim"
import { LayerState } from "../utils/LayerState"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"

type StartMenuState = {
  isOpen: Accessor<boolean>
  setOpen: (open: boolean) => void
}

const LAYER_STATE = new LayerState<StartMenuState>()

export function StartMenuButton({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  return (
    <button
      cssName="StartMenuButton"
      class={LAYER_STATE.then(gdkmonitor, (state) =>
        state.isOpen((isOpen) => (isOpen ? "pressed" : "")),
      )}
      onClicked={() =>
        LAYER_STATE.then(gdkmonitor, (state) => state.setOpen(!state.isOpen()))
      }
    >
      <image file={`${SRC}/assets/arch-linux.svg`} />
    </button>
  )
}

export function StartMenuLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
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

        // 途中で再度 open されていない場合だけ unmount
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
      cssName="StartMenu"
      class={isOpen((open) => (open ? "open" : "close"))}
      halign={Gtk.Align.START}
      valign={Gtk.Align.START}
    >
      <box
        orientation={Gtk.Orientation.VERTICAL}
        halign={Gtk.Align.FILL}
        hexpand
      >
        <box cssName={"FirstPadding"} />
        <box
          cssName={"SearchBox"}
          orientation={Gtk.Orientation.VERTICAL}
          valign={Gtk.Align.START}
          halign={Gtk.Align.FILL}
          hexpand
        >
          <box
            cssName={"SearchBoxInner"}
            orientation={Gtk.Orientation.HORIZONTAL}
            halign={Gtk.Align.FILL}
            hexpand
          >
            <image
              cssName={"SearchBoxIcon"}
              file={`${SRC}/assets/search.svg`}
            />
            <entry
              cssName={"SearchBoxEntry"}
              placeholderText={" Search..."}
              halign={Gtk.Align.FILL}
              hexpand
            />
          </box>
          <Gtk.Separator
            cssName={"SearchBoxSeparator"}
            orientation={Gtk.Orientation.HORIZONTAL}
          />
          <label label={"App list here"} />
        </box>
      </box>
    </box>
  ) as Gtk.Box

  const window = (
    <window
      name="startmenulayer"
      class="StartMenuLayer"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.NORMAL}
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
    if (!inner.contains(x, y)) {
      states.setOpen(false)
    }
  })

  window.add_controller(outsideClick)

  return window
}
