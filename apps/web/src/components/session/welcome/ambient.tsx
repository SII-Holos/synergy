import { createEffect, onCleanup, onMount, type Accessor } from "solid-js"
import { resolveThemeColor, useTheme } from "@ericsanchezok/synergy-ui/theme"
import { sceneRandom } from "./random"
import { sprite, sprites } from "./pixels"
import { useSceneClock } from "./clock"

export function AmbientField(props: {
  seed: number
  active: Accessor<boolean>
  reducedMotion: Accessor<boolean>
  surface: Element
}) {
  const theme = useTheme()
  const random = sceneRandom(props.seed)
  const masks = [
    ...[sprites.star, sprites.ring, sprites.bolt, sprites.sprout, sprites.crate, sprites.drone, sprites.heart].map(
      (mask) => mask.map((row) => row.replaceAll("2", "0")),
    ),
    sprites.ribbon,
  ]
  const motifs = masks.map((mask) => {
    const buffer = document.createElement("canvas")
    buffer.width = Math.max(...mask.map((row) => row.length))
    buffer.height = mask.length
    return { mask, buffer, ribbon: mask === sprites.ribbon }
  })
  const ribbon = document.createElement("canvas")
  ribbon.width = sprites.ribbon[0].length
  ribbon.height = sprites.ribbon.length
  const marks = Array.from({ length: 240 }, (_, index) => ({
    column: index % 20,
    row: Math.floor(index / 20),
    offset: random(),
    depth: 0.35 + random() * 0.65,
    motif: motifs[Math.floor(random() * motifs.length)]!,
    reveal: 0,
  }))
  let canvas!: HTMLCanvasElement
  let time = 0,
    width = 0,
    height = 0
  let palette: string[] = []
  let cachedPalette: string | undefined
  let pointer: { x: number; y: number } | undefined
  onCleanup(() => {
    for (const { buffer } of motifs) buffer.width = buffer.height = 0
    ribbon.width = ribbon.height = 0
  })
  function draw(dt = 0) {
    const ctx = canvas?.getContext("2d")
    if (!ctx || !width || !height || !palette.length) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const aligned = Number.isInteger(dpr)
    const color = palette[0]!
    if (aligned && cachedPalette !== palette.join(":")) {
      for (const { mask, buffer } of motifs) {
        const pixels = buffer.getContext("2d")
        if (!pixels) continue
        pixels.clearRect(0, 0, buffer.width, buffer.height)
        sprite(pixels, mask, 0, 0, 1, color)
      }
      const pixels = ribbon.getContext("2d")
      if (pixels) {
        pixels.clearRect(0, 0, ribbon.width, ribbon.height)
        sprite(pixels, sprites.ribbon, 0, 0, 1, palette[1]!, palette[2]!, palette[3]!)
      }
      cachedPalette = palette.join(":")
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
      const scale = mark.depth > 0.65 ? 2 : 1
      const distance = pointer
        ? Math.hypot(
            pointer.x - x - (mark.motif.buffer.width * scale) / 2,
            pointer.y - y - (mark.motif.buffer.height * scale) / 2,
          )
        : Infinity
      const near = mark.motif.ribbon ? Math.max(0, 1 - distance / 140) : 0
      const target = near * near * (3 - 2 * near)
      mark.reveal = props.reducedMotion() ? target : mark.reveal + (target - mark.reveal) * (1 - Math.exp(-dt / 0.16))
      if (mark.reveal < 0.001) mark.reveal = 0
      ctx.globalAlpha = (0.025 + 0.062 * mark.depth) * band * edge * (1 - mark.reveal)
      if (aligned) {
        const buffer = mark.motif.buffer
        ctx.drawImage(buffer, Math.round(x), Math.round(y), buffer.width * scale, buffer.height * scale)
      } else sprite(ctx, mark.motif.mask, x, y, scale, color)
      if (mark.reveal > 0) {
        ctx.globalAlpha = mark.reveal * 0.85 * edge
        if (aligned) ctx.drawImage(ribbon, Math.round(x), Math.round(y), ribbon.width * scale, ribbon.height * scale)
        else sprite(ctx, sprites.ribbon, x, y, scale, palette[1]!, palette[2]!, palette[3]!)
      }
    }
    ctx.globalAlpha = 1
  }
  onMount(() => {
    const move = (event: Event) => {
      const input = event as PointerEvent
      if (!props.active() || input.pointerType === "touch") return
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      pointer = {
        x: ((input.clientX - rect.left) * width) / rect.width,
        y: ((input.clientY - rect.top) * height) / rect.height,
      }
      if (props.reducedMotion()) draw()
    }
    const leave = () => {
      pointer = undefined
      if (props.reducedMotion()) draw()
    }
    props.surface.addEventListener("pointermove", move, { passive: true })
    props.surface.addEventListener("pointerleave", leave)
    props.surface.addEventListener("pointercancel", leave)
    window.addEventListener("blur", leave)
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
    onCleanup(() => {
      resize.disconnect()
      props.surface.removeEventListener("pointermove", move)
      props.surface.removeEventListener("pointerleave", leave)
      props.surface.removeEventListener("pointercancel", leave)
      window.removeEventListener("blur", leave)
    })
  })
  createEffect(() => {
    const tokens = theme.tokens()
    palette = (["text-strong", "brand-ribbon-start", "brand-ribbon-middle", "brand-ribbon-end"] as const).map((token) =>
      resolveThemeColor(tokens, token),
    )
    if (!props.active()) {
      pointer = undefined
      for (const mark of marks) mark.reveal = 0
    }
    draw()
  })
  useSceneClock(
    () => props.active() && !props.reducedMotion(),
    (dt) => {
      time += dt
      draw(dt)
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
