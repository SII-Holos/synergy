import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"

export type Ink = { strong: string; soft: string; paper: string; accent: string; second: string; colors: string[] }
export const sprites = {
  ship: [
    "00000100000",
    "00001110000",
    "00001110000",
    "00101210100",
    "00111211100",
    "01111211110",
    "11111211111",
    "11111111111",
    "11001110011",
    "10001110001",
    "00001010000",
  ],
  enemy: [
    "00100000100",
    "00010001000",
    "00111111100",
    "01121112110",
    "11111111111",
    "10111111101",
    "10100000101",
    "00011011000",
  ],
  drone: ["000111000", "001111100", "011212110", "111111111", "011111110", "001010100", "010000010"],
  heart: ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"],
  star: ["0001000", "0001000", "0011100", "1111111", "0011100", "0100010", "1000001"],
  ring: ["0011100", "0100010", "1000001", "1000001", "1000001", "0100010", "0011100"],
  crate: ["11111111", "12222221", "11222211", "12122121", "12211221", "12122121", "11222211", "11111111"],
  bolt: ["0001100", "0011000", "0110000", "1111110", "0001100", "0011000", "0110000"],
  flag: ["11111000", "12222100", "12222210", "12222100", "11111000", "10000000", "10000000", "10000000"],
  sprout: ["0000000", "1100011", "1110111", "0111110", "0001000", "0001000", "0111110"],
} as const
export function sprite(
  ctx: CanvasRenderingContext2D,
  mask: readonly string[],
  x: number,
  y: number,
  scale: number,
  ink: string,
  detail = ink,
) {
  for (let row = 0; row < mask.length; row++)
    for (let col = 0; col < mask[row]!.length; col++) {
      const cell = mask[row]![col]
      if (cell === "0") continue
      ctx.fillStyle = cell === "2" ? detail : ink
      ctx.fillRect(Math.round(x + col * scale), Math.round(y + row * scale), scale, scale)
    }
}
export function usePixelCanvas(
  draw: (ctx: CanvasRenderingContext2D, ink: Ink) => void,
  width: number,
  height: number,
  align: "center" | "end" = "center",
) {
  const theme = useTheme()
  const [size, setSize] = createSignal({ width: 0, height: 0, dpr: 1 })
  let canvas!: HTMLCanvasElement
  const buffer = document.createElement("canvas")
  buffer.width = width
  buffer.height = height
  onMount(() => {
    const measure = () =>
      setSize({
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      })
    const resize = new ResizeObserver(measure)
    resize.observe(canvas)
    measure()
    onCleanup(() => resize.disconnect())
  })
  createEffect(() => {
    const tokens = theme.tokens()
    const bounds = size()
    if (!canvas || !bounds.width || !bounds.height) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const pixelWidth = Math.round(bounds.width * bounds.dpr),
      pixelHeight = Math.round(bounds.height * bounds.dpr)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const scale = Math.min(bounds.width / width, bounds.height / height)
    const pixels = buffer.getContext("2d")
    if (!pixels) return
    pixels.clearRect(0, 0, width, height)
    pixels.save()
    draw(pixels, {
      strong: tokens["text-strong"],
      soft: tokens["text-weak"],
      paper: tokens["background-stronger"],
      accent: tokens["chart-series-1"],
      second: tokens["chart-series-2"],
      colors: [
        tokens["chart-series-1"],
        tokens["chart-series-2"],
        tokens["chart-series-3"],
        tokens["chart-series-4"],
        tokens["chart-series-5"],
        tokens["chart-series-6"],
        tokens["chart-series-7"],
      ],
    })
    pixels.restore()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(
      buffer,
      ((bounds.width - width * scale) * bounds.dpr) / 2,
      (bounds.height - height * scale) * bounds.dpr * (align === "end" ? 1 : 0.5),
      width * scale * bounds.dpr,
      height * scale * bounds.dpr,
    )
  })
  return {
    ref: (element: HTMLCanvasElement) => {
      canvas = element
    },
    element: () => canvas,
    point: (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const scale = Math.min(rect.width / width, rect.height / height)
      return {
        x: (event.clientX - rect.left - (rect.width - width * scale) / 2) / scale,
        y: (event.clientY - rect.top - (rect.height - height * scale) * (align === "end" ? 1 : 0.5)) / scale,
      }
    },
  }
}
