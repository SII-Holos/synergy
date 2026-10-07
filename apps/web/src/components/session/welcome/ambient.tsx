import { createEffect, onCleanup, onMount, type Accessor } from "solid-js"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { sceneRandom } from "./random"
import { sprite, sprites } from "./pixels"
import { useSceneClock } from "./clock"

export function AmbientField(props: { seed: number; active: Accessor<boolean>; reducedMotion: Accessor<boolean> }) {
  const theme = useTheme()
  const random = sceneRandom(props.seed)
  const masks = [
    sprites.star,
    sprites.ring,
    sprites.bolt,
    sprites.sprout,
    sprites.crate,
    sprites.drone,
    sprites.heart,
  ].map((mask) => mask.map((row) => row.replaceAll("2", "0")))
  const motifs = masks.map((mask) => {
    const buffer = document.createElement("canvas")
    buffer.width = Math.max(...mask.map((row) => row.length))
    buffer.height = mask.length
    return { mask, buffer }
  })
  const marks = Array.from({ length: 240 }, (_, index) => ({
    column: index % 20,
    row: Math.floor(index / 20),
    offset: random(),
    depth: 0.35 + random() * 0.65,
    motif: motifs[Math.floor(random() * motifs.length)]!,
  }))
  let canvas!: HTMLCanvasElement
  let time = 0,
    width = 0,
    height = 0
  let color = theme.tokens()["text-strong"]
  let cachedColor: string | undefined
  onCleanup(() => {
    for (const { buffer } of motifs) buffer.width = buffer.height = 0
  })
  function draw() {
    const ctx = canvas?.getContext("2d")
    if (!ctx || !width || !height) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const aligned = Number.isInteger(dpr)
    if (aligned && cachedColor !== color) {
      for (const { mask, buffer } of motifs) {
        const pixels = buffer.getContext("2d")
        if (!pixels) continue
        pixels.clearRect(0, 0, buffer.width, buffer.height)
        sprite(pixels, mask, 0, 0, 1, color)
      }
      cachedColor = color
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.imageSmoothingEnabled = false
    for (const mark of marks) {
      const spacing = Math.max(62, width / 18)
      const x = (mark.column + 0.3 + mark.offset * 0.35) * spacing + Math.sin(time * 0.13 + mark.row * 0.6) * 9
      if (x > width + 20) continue
      const cycle = height + 100
      const y = (((mark.row / 12) * cycle + time * (9 + mark.depth * 12) + mark.offset * 40) % cycle) - 45
      const band = 0.6 + 0.4 * Math.sin(time * 0.16 + mark.column * 0.8 + mark.row * 0.35)
      const edge = Math.min(1, Math.max(0, y / 65), Math.max(0, (height - y) / 80))
      ctx.globalAlpha = (0.025 + 0.062 * mark.depth) * band * edge
      const scale = mark.depth > 0.65 ? 2 : 1
      if (aligned) {
        const buffer = mark.motif.buffer
        ctx.drawImage(buffer, Math.round(x), Math.round(y), buffer.width * scale, buffer.height * scale)
      } else sprite(ctx, mark.motif.mask, x, y, scale, color)
    }
    ctx.globalAlpha = 1
  }
  onMount(() => {
    const measure = () => {
      width = canvas.clientWidth
      height = canvas.clientHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      draw()
    }
    const resize = new ResizeObserver(measure)
    resize.observe(canvas)
    measure()
    onCleanup(() => resize.disconnect())
  })
  createEffect(() => {
    color = theme.tokens()["text-strong"]
    draw()
  })
  useSceneClock(
    () => props.active() && !props.reducedMotion(),
    (dt) => {
      time += dt
      draw()
    },
  )
  return (
    <canvas
      ref={canvas}
      class="welcome-ambient"
      aria-hidden="true"
      data-moving={props.active() && !props.reducedMotion() ? "" : undefined}
    />
  )
}
