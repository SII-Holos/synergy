import path from "node:path"
import { Resvg, initWasm } from "@resvg/resvg-wasm"
import { SVG_RASTER_RUNTIME_PATH, SVG_RASTER_RUNTIME_WASM } from "./svg-raster-runtime"

declare const SYNERGY_STANDALONE: boolean | undefined

const MAX_PREVIEW_EDGE = 2048
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024

let initialized: Promise<void> | undefined

self.onmessage = async (event: MessageEvent<{ svg: Uint8Array }>) => {
  try {
    const png = await renderSvg(event.data.svg)
    postMessage({ ok: true, png })
  } catch (error) {
    postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function renderSvg(svg: Uint8Array): Promise<Uint8Array> {
  await initialize()
  const probe = new Resvg(svg)
  let fitTo: { mode: "width" | "height"; value: number } | undefined
  try {
    fitTo = previewFit(probe.width, probe.height)
  } finally {
    probe.free()
  }

  const renderer = new Resvg(svg, fitTo ? { fitTo } : undefined)
  try {
    const rendered = renderer.render()
    try {
      const png = rendered.asPng()
      if (png.byteLength === 0 || png.byteLength > MAX_PREVIEW_BYTES) {
        throw new Error(`SVG preview output must be between 1 and ${MAX_PREVIEW_BYTES} bytes`)
      }
      return new Uint8Array(png)
    } finally {
      rendered.free()
    }
  } finally {
    renderer.free()
  }
}

function previewFit(width: number, height: number): { mode: "width" | "height"; value: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("SVG preview has invalid dimensions")
  }
  if (width <= MAX_PREVIEW_EDGE && height <= MAX_PREVIEW_EDGE) return undefined
  return width >= height ? { mode: "width", value: MAX_PREVIEW_EDGE } : { mode: "height", value: MAX_PREVIEW_EDGE }
}

function initialize(): Promise<void> {
  initialized ??= (async () => {
    const wasmPath = isStandalone()
      ? path.resolve(path.dirname(process.execPath), "..", SVG_RASTER_RUNTIME_PATH, SVG_RASTER_RUNTIME_WASM)
      : Bun.resolveSync("@resvg/resvg-wasm/index_bg.wasm", import.meta.dir)
    const wasm = new Uint8Array(await Bun.file(wasmPath).arrayBuffer())
    await initWasm(wasm)
  })()
  return initialized
}

function isStandalone(): boolean {
  return typeof SYNERGY_STANDALONE !== "undefined" && SYNERGY_STANDALONE
}
