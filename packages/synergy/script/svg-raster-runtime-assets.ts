import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import {
  SVG_RASTER_RUNTIME_LICENSE,
  SVG_RASTER_RUNTIME_NOTICE,
  SVG_RASTER_RUNTIME_PATH,
  SVG_RASTER_RUNTIME_WASM,
} from "../src/channel/provider/feishu/svg-raster-runtime"

export const SVG_RASTER_RUNTIME_REQUIRED_PATHS = [
  `${SVG_RASTER_RUNTIME_PATH}/${SVG_RASTER_RUNTIME_WASM}`,
  `${SVG_RASTER_RUNTIME_PATH}/${SVG_RASTER_RUNTIME_LICENSE}`,
  `${SVG_RASTER_RUNTIME_PATH}/${SVG_RASTER_RUNTIME_NOTICE}`,
]

export async function stageSvgRasterRuntimeAssets(options: { runtimeDir: string; wasmPath?: string }): Promise<void> {
  const destination = path.join(options.runtimeDir, SVG_RASTER_RUNTIME_PATH)
  const noticeSource = path.join(import.meta.dir, "assets", "resvg-wasm")
  await fs.rm(destination, { recursive: true, force: true })
  await fs.mkdir(destination, { recursive: true })
  await Promise.all([
    fs.copyFile(options.wasmPath ?? defaultWasmPath(), path.join(destination, SVG_RASTER_RUNTIME_WASM)),
    fs.copyFile(
      path.join(noticeSource, SVG_RASTER_RUNTIME_LICENSE),
      path.join(destination, SVG_RASTER_RUNTIME_LICENSE),
    ),
    fs.copyFile(path.join(noticeSource, SVG_RASTER_RUNTIME_NOTICE), path.join(destination, SVG_RASTER_RUNTIME_NOTICE)),
  ])
}

function defaultWasmPath(): string {
  const require = createRequire(import.meta.url)
  return require.resolve("@resvg/resvg-wasm/index_bg.wasm")
}
