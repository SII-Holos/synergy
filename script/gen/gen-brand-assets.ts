#!/usr/bin/env bun

import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")

export const BRAND_ICON_SOURCE = path.join(REPO_ROOT, "packages/ui/src/assets/brand/synergy-product-icon-source.png")
const SOCIAL_SHARE_TEMPLATE = path.join(REPO_ROOT, "script/gen/assets/synergy-social-share-template.png")

export const BRAND_ASSET_OUTPUTS = [
  "packages/ui/src/assets/brand/synergy-product-icon.png",
  "packages/app/public/brand/synergy-product-icon.png",
  "packages/app/public/favicon-96x96.png",
  "packages/app/public/favicon.svg",
  "packages/app/public/favicon.ico",
  "packages/app/public/apple-touch-icon.png",
  "packages/app/public/web-app-manifest-192x192.png",
  "packages/app/public/web-app-manifest-512x512.png",
  "packages/app/public/social-share.png",
  "packages/desktop/build/icon.png",
  "packages/desktop/build/icon-unread.png",
] as const

export const OBSOLETE_BRAND_ASSETS = [
  "packages/desktop/build/icon.icns",
  "packages/desktop/build/icon.ico",
  "packages/desktop/build/icons",
] as const

function absolute(relative: string): string {
  return path.join(REPO_ROOT, relative)
}

async function exists(target: string): Promise<boolean> {
  return stat(target)
    .then(() => true)
    .catch(() => false)
}

async function encodePng(canvas: Canvas): Promise<Buffer> {
  return Buffer.from(await canvas.encode("png"))
}

async function resizePng(image: Awaited<ReturnType<typeof loadImage>>, size: number): Promise<Buffer> {
  const canvas = createCanvas(size, size)
  const context = canvas.getContext("2d")
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"
  context.drawImage(image, 0, 0, size, size)
  return encodePng(canvas)
}

function createIco(images: Array<{ size: number; data: Buffer }>): Buffer {
  const headerSize = 6 + images.length * 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  let offset = headerSize
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16
    header.writeUInt8(size === 256 ? 0 : size, entry)
    header.writeUInt8(size === 256 ? 0 : size, entry + 1)
    header.writeUInt8(0, entry + 2)
    header.writeUInt8(0, entry + 3)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.byteLength, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.byteLength
  })

  return Buffer.concat([header, ...images.map((image) => image.data)])
}

async function createSocialShare(icon: Awaited<ReturnType<typeof loadImage>>): Promise<Buffer> {
  const template = await loadImage(SOCIAL_SHARE_TEMPLATE)
  const canvas = createCanvas(template.width, template.height)
  const context = canvas.getContext("2d")
  context.drawImage(template, 0, 0)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"
  context.drawImage(icon, 121, 205, 220, 220)
  return encodePng(canvas)
}

async function createUnreadIcon(icon: Awaited<ReturnType<typeof loadImage>>): Promise<Buffer> {
  const canvas = createCanvas(512, 512)
  const context = canvas.getContext("2d")
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"
  context.drawImage(icon, 0, 0, 512, 512)
  const imageData = context.getImageData(0, 0, 512, 512)
  compositeCircle(imageData.data, 512, 446, 66, 67, [255, 255, 255])
  compositeCircle(imageData.data, 512, 446, 66, 54, [239, 68, 68])
  context.putImageData(imageData, 0, 0)
  return encodePng(canvas)
}

function compositeCircle(
  pixels: Uint8ClampedArray,
  width: number,
  centerX: number,
  centerY: number,
  radius: number,
  color: readonly [number, number, number],
): void {
  const startX = Math.max(0, Math.floor(centerX - radius - 1))
  const endX = Math.min(width - 1, Math.ceil(centerX + radius + 1))
  const startY = Math.max(0, Math.floor(centerY - radius - 1))
  const endY = Math.min(width - 1, Math.ceil(centerY + radius + 1))

  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const sourceAlpha = circleAlpha(x, y, centerX, centerY, radius)
      if (sourceAlpha === 0) continue

      const offset = (y * width + x) * 4
      const destinationAlpha = pixels[offset + 3]
      const inverseSourceAlpha = 255 - sourceAlpha
      const outputAlpha = sourceAlpha + Math.round((destinationAlpha * inverseSourceAlpha) / 255)
      for (let channel = 0; channel < 3; channel += 1) {
        const destination = pixels[offset + channel]
        pixels[offset + channel] = Math.round(
          (color[channel] * sourceAlpha * 255 + destination * destinationAlpha * inverseSourceAlpha) /
            (outputAlpha * 255),
        )
      }
      pixels[offset + 3] = outputAlpha
    }
  }
}

function circleAlpha(x: number, y: number, centerX: number, centerY: number, radius: number): number {
  const samplesPerAxis = 8
  const scale = samplesPerAxis * 2
  const scaledCenterX = centerX * scale
  const scaledCenterY = centerY * scale
  const scaledRadiusSquared = (radius * scale) ** 2
  let coveredSamples = 0

  for (let sampleY = 0; sampleY < samplesPerAxis; sampleY += 1) {
    const deltaY = y * scale + sampleY * 2 + 1 - scaledCenterY
    for (let sampleX = 0; sampleX < samplesPerAxis; sampleX += 1) {
      const deltaX = x * scale + sampleX * 2 + 1 - scaledCenterX
      if (deltaX ** 2 + deltaY ** 2 <= scaledRadiusSquared) coveredSamples += 1
    }
  }

  return Math.round((coveredSamples * 255) / samplesPerAxis ** 2)
}

function faviconSvg(icon: Buffer): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,${icon.toString("base64")}"/></svg>\n`,
  )
}

function assertTransparentSource(image: Awaited<ReturnType<typeof loadImage>>): void {
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext("2d")
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, image.width, image.height).data
  const alphaAt = (x: number, y: number) => pixels[(y * image.width + x) * 4 + 3]
  const corners = [
    alphaAt(0, 0),
    alphaAt(image.width - 1, 0),
    alphaAt(0, image.height - 1),
    alphaAt(image.width - 1, image.height - 1),
  ]
  if (corners.some((alpha) => alpha !== 0)) throw new Error("brand icon source must have transparent corners")
  if (alphaAt(Math.floor(image.width / 2), Math.floor(image.height / 2)) !== 255) {
    throw new Error("brand icon source center must be opaque")
  }
}

export async function generateBrandAssets(): Promise<Map<string, Buffer>> {
  const sourceBytes = Buffer.from(await readFile(BRAND_ICON_SOURCE))
  const source = await loadImage(sourceBytes)
  if (source.width !== 1024 || source.height !== 1024) {
    throw new Error(`brand icon source must be 1024x1024, received ${source.width}x${source.height}`)
  }
  assertTransparentSource(source)

  const [icon512, icon192, icon180, icon96, faviconImages] = await Promise.all([
    resizePng(source, 512),
    resizePng(source, 192),
    resizePng(source, 180),
    resizePng(source, 96),
    Promise.all([16, 32, 48, 96, 256].map(async (size) => ({ size, data: await resizePng(source, size) }))),
  ])
  const icon512Image = await loadImage(icon512)
  const [socialShare, unreadIcon] = await Promise.all([createSocialShare(icon512Image), createUnreadIcon(icon512Image)])

  return new Map<string, Buffer>([
    ["packages/ui/src/assets/brand/synergy-product-icon.png", icon512],
    ["packages/app/public/brand/synergy-product-icon.png", icon512],
    ["packages/app/public/favicon-96x96.png", icon96],
    ["packages/app/public/favicon.svg", faviconSvg(icon512)],
    ["packages/app/public/favicon.ico", createIco(faviconImages)],
    ["packages/app/public/apple-touch-icon.png", icon180],
    ["packages/app/public/web-app-manifest-192x192.png", icon192],
    ["packages/app/public/web-app-manifest-512x512.png", icon512],
    ["packages/app/public/social-share.png", socialShare],
    ["packages/desktop/build/icon.png", sourceBytes],
    ["packages/desktop/build/icon-unread.png", unreadIcon],
  ])
}

async function pngsEqual(expected: Buffer, actual: Buffer): Promise<boolean> {
  const [expectedImage, actualImage] = await Promise.all([loadImage(expected), loadImage(actual)])
  if (expectedImage.width !== actualImage.width || expectedImage.height !== actualImage.height) return false

  const expectedCanvas = createCanvas(expectedImage.width, expectedImage.height)
  const actualCanvas = createCanvas(actualImage.width, actualImage.height)
  const expectedContext = expectedCanvas.getContext("2d")
  const actualContext = actualCanvas.getContext("2d")
  expectedContext.drawImage(expectedImage, 0, 0)
  actualContext.drawImage(actualImage, 0, 0)
  const expectedPixels = expectedContext.getImageData(0, 0, expectedImage.width, expectedImage.height).data
  const actualPixels = actualContext.getImageData(0, 0, actualImage.width, actualImage.height).data
  return Buffer.from(expectedPixels).equals(Buffer.from(actualPixels))
}

export async function checkBrandAssets(): Promise<string[]> {
  const generated = await generateBrandAssets()
  const stale: string[] = []
  for (const [relative, expected] of generated) {
    const actual = await readFile(absolute(relative)).catch(() => null)
    if (!actual) {
      stale.push(relative)
      continue
    }
    const equal = relative.endsWith(".png") ? await pngsEqual(expected, actual) : expected.equals(actual)
    if (!equal) stale.push(relative)
  }
  for (const relative of OBSOLETE_BRAND_ASSETS) {
    if (await exists(absolute(relative))) stale.push(relative)
  }
  return stale
}

export async function writeBrandAssets(): Promise<void> {
  const generated = await generateBrandAssets()
  await Promise.all(
    [...generated].map(async ([relative, data]) => {
      const output = absolute(relative)
      await mkdir(path.dirname(output), { recursive: true })
      await writeFile(output, data)
    }),
  )
  await Promise.all(OBSOLETE_BRAND_ASSETS.map((relative) => rm(absolute(relative), { recursive: true, force: true })))
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const stale = await checkBrandAssets()
    if (stale.length > 0) {
      console.error(`brand assets are stale:\n${stale.map((relative) => `- ${relative}`).join("\n")}`)
      process.exit(1)
    }
    console.log("brand assets are current")
  } else {
    await writeBrandAssets()
    console.log(`generated ${BRAND_ASSET_OUTPUTS.length} brand assets`)
  }
}
