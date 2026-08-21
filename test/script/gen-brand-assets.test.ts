import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createCanvas, loadImage } from "@napi-rs/canvas"
import {
  BRAND_ASSET_OUTPUTS,
  BRAND_ICON_SOURCE,
  OBSOLETE_BRAND_ASSETS,
  checkBrandAssets,
  generateBrandAssets,
} from "../../script/gen/gen-brand-assets"

async function pngPixels(data: Uint8Array) {
  const image = await loadImage(data)
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext("2d")
  context.drawImage(image, 0, 0)
  return {
    width: image.width,
    height: image.height,
    data: context.getImageData(0, 0, image.width, image.height).data,
  }
}

function icoSizes(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const count = view.getUint16(4, true)
  return Array.from({ length: count }, (_, index) => {
    const width = view.getUint8(6 + index * 16)
    return width === 0 ? 256 : width
  })
}

describe("brand asset generation", () => {
  test("uses one transparent square source", async () => {
    const source = await pngPixels(await Bun.file(BRAND_ICON_SOURCE).bytes())
    expect(source.width).toBe(1024)
    expect(source.height).toBe(1024)

    const cornerAlpha = [
      source.data[3],
      source.data[(source.width - 1) * 4 + 3],
      source.data[(source.height - 1) * source.width * 4 + 3],
      source.data[(source.width * source.height - 1) * 4 + 3],
    ]
    expect(cornerAlpha).toEqual([0, 0, 0, 0])
    expect(source.data[((source.height / 2) * source.width + source.width / 2) * 4 + 3]).toBe(255)
  })

  test("generates every formal product icon deterministically", async () => {
    const first = await generateBrandAssets()
    const second = await generateBrandAssets()
    expect([...first.keys()].sort()).toEqual([...BRAND_ASSET_OUTPUTS].sort())
    expect([...second.keys()].sort()).toEqual([...BRAND_ASSET_OUTPUTS].sort())
    for (const output of BRAND_ASSET_OUTPUTS) expect(second.get(output)).toEqual(first.get(output))
  })

  test("emits the expected raster and favicon sizes", async () => {
    const generated = await generateBrandAssets()
    const expected = new Map([
      ["packages/ui/src/assets/brand/synergy-product-icon.png", 512],
      ["packages/app/public/brand/synergy-product-icon.png", 512],
      ["packages/app/public/favicon-96x96.png", 96],
      ["packages/app/public/apple-touch-icon.png", 180],
      ["packages/app/public/web-app-manifest-192x192.png", 192],
      ["packages/app/public/web-app-manifest-512x512.png", 512],
      ["packages/desktop/build/icon.png", 1024],
      ["packages/desktop/build/icon-unread.png", 512],
    ])

    for (const [output, size] of expected) {
      const image = await loadImage(generated.get(output)!)
      expect([image.width, image.height]).toEqual([size, size])
    }
    expect(icoSizes(generated.get("packages/app/public/favicon.ico")!)).toEqual([16, 32, 48, 96, 256])
  })

  test("keeps committed outputs fresh and removes manual desktop variants", async () => {
    expect(await checkBrandAssets()).toEqual([])
    const manifest = await Bun.file(path.resolve(import.meta.dir, "../../packages/app/public/site.webmanifest")).json()
    expect(manifest.icons.map((icon: { purpose: string }) => icon.purpose)).toEqual(["any", "any"])
    for (const obsolete of OBSOLETE_BRAND_ASSETS) {
      expect(await Bun.file(path.resolve(import.meta.dir, "../..", obsolete)).exists()).toBe(false)
    }
  })
})
