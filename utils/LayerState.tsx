import { Gdk } from "ags/gtk4";

export class LayerState<T> {
  private map: WeakMap<Gdk.Monitor, T>

  constructor() {
    this.map = new WeakMap()
  }

  then<R>(gdkmonitor: Gdk.Monitor, consumer: (state: T) => R | undefined) {
    const state = this.map.get(gdkmonitor)

    if (state) {
      return consumer(state)
    }
  }

  set(gdkmonitor: Gdk.Monitor, state: T) {
    this.map.set(gdkmonitor, state)
  }
}
