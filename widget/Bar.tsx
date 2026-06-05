import app from "ags/gtk4/app"
import { Astal, Gdk } from "ags/gtk4"
import { StartMenuButton } from "./StartMenu"

export default function Bar({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

  return (
    <window
      visible
      name="bar"
      class="Bar"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.TOP}
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      anchor={TOP | LEFT | RIGHT}
      application={app}
    >
      <box cssName="parentbox">
        <box widthRequest={1} />
        <StartMenuButton gdkmonitor={gdkmonitor} />
      </box>
    </window>
  )
}
