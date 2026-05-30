import { Astal, Gdk, Gtk } from "ags/gtk4"
import { Accessor, createState, Setter } from "gnim"
import { LayerState } from "../utils/LayerState"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
import { animate, cubicBezier } from "../utils/animation"

type StartMenuState = {
  isOpen: Accessor<boolean>
  setOpen: (open: boolean) => void

  mounted: Accessor<boolean>
  progress: Accessor<number>
}

const OPEN_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1)
const CLOSE_EASING = cubicBezier(0.3, -0.3, 0, 1)

const LAYER_STATE = new LayerState<StartMenuState>()

export function StartMenuButton({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  return (
    <button
      cssName="StartMenuButton"
      class={(LAYER_STATE.then(gdkmonitor, state => state.isOpen(isOpen => isOpen ? "pressed" : "")))}
      onClicked={() => LAYER_STATE.then(gdkmonitor, state => state.setOpen(!state.isOpen()))}
    >
      <image file={`${SRC}/assets/arch-linux.svg`} />
    </button>
  )
}

export function StartMenuLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const [isOpen, setIsOpen] = createState(false)
  const [mounted, setMounted] = createState(false)
  const [progress, setProgress] = createState(0)

  let animationId: number | null = null

  const refreshRate = gdkmonitor.get_refresh_rate()
  const hz = refreshRate > 0 ? refreshRate / 1000 : 60
  const intervalMs = Math.max(1, Math.floor(1000 / hz))

  function stopAnimation() {
    if (animationId !== null) {
      GLib.source_remove(animationId)
      animationId = null
    }
  }

  function setOpen(open: boolean) {
    stopAnimation()
    setIsOpen(open)

    if (open) {
      setMounted(true)

      animationId = animate(
        progress(),
        1,
        500,
        intervalMs,
        OPEN_EASING,
        setProgress,
        () => {
          animationId = null
        },
      )
    } else {
      animationId = animate(
        progress(),
        0,
        500,
        intervalMs,
        CLOSE_EASING,
        setProgress,
        () => {
          animationId = null
          setMounted(false)
        },
      )
    }
  }

  const states = {
    isOpen,
    setOpen,
    mounted,
    progress,
  }

  LAYER_STATE.set(gdkmonitor, states)

  const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

  const inner = (
    <box
      cssName="StartMenu"
      css={progress.as((p) => `
        opacity: ${p};
        transform: translateY(${p * 40 - 40 + 10}px) translateX(10px);
      `)}
      halign={Gtk.Align.START}
      valign={Gtk.Align.START}
    >
      {/* menu contents */}
    </box>
  ) as Gtk.Box

  const window = (
    <window
      visible={mounted}
      name="startmenulayer"
      class="StartMenuLayer"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.NORMAL}
      anchor={TOP | LEFT | RIGHT | BOTTOM}
      application={app}
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
