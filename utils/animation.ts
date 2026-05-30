import GLib from "gi://GLib"

export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  function sampleCurveX(t: number) {
    return ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t
  }

  function sampleCurveY(t: number) {
    return ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t
  }

  function sampleCurveDerivativeX(t: number) {
    return (3 * (1 - 3 * x2 + 3 * x1) * t + 2 * (3 * x2 - 6 * x1)) * t + 3 * x1
  }

  return (x: number) => {
    let t = x

    for (let i = 0; i < 8; i++) {
      const xEstimate = sampleCurveX(t) - x
      const dx = sampleCurveDerivativeX(t)

      if (Math.abs(xEstimate) < 1e-6) {
        return sampleCurveY(t)
      }

      if (Math.abs(dx) < 1e-6) {
        break
      }

      t -= xEstimate / dx
    }

    return sampleCurveY(t)
  }
}

export function animate(
  from: number,
  to: number,
  duration: number,
  intervalMs: number,
  easing: (t: number) => number,
  onUpdate: (value: number) => void,
  onDone?: () => void,
) {
  const startTime = Date.now()

  const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
    const elapsed = Date.now() - startTime
    const rawProgress = Math.min(elapsed / duration, 1)
    const eased = easing(rawProgress)

    const value = from + (to - from) * eased
    onUpdate(value)

    if (rawProgress >= 1) {
      onUpdate(to)
      onDone?.()
      return GLib.SOURCE_REMOVE
    }

    return GLib.SOURCE_CONTINUE
  })

  return id
}
