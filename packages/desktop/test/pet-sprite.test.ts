import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  decodeRasterDimensions,
  isPetSpritePath,
  loadPetSpriteSheet,
  PET_SPRITE_ASPECT_RATIO,
  validatePetSpriteSheet,
} from "../src/pet-sprite.js"

/** Minimal PNG header with an 8:7 aspect (e.g. 4096x3584). */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** Minimal JPEG header with SOF0 dimensions. */
function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20)
  bytes.set([0xff, 0xd8], 0)
  // SOF0 marker with length 17, precision 8, height, width.
  bytes.set([0xff, 0xc0], 2)
  const view = new DataView(bytes.buffer)
  view.setUint16(4, 17)
  view.setUint8(6, 8)
  view.setUint16(7, height)
  view.setUint16(9, width)
  return bytes
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synergy-desktop-sprite-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("pet sprite sheet validation", () => {
  test("accepts png/jpg/webp paths and rejects others", () => {
    expect(isPetSpritePath("/tmp/pet.png")).toBe(true)
    expect(isPetSpritePath("/tmp/pet.jpg")).toBe(true)
    expect(isPetSpritePath("/tmp/pet.jpeg")).toBe(true)
    expect(isPetSpritePath("/tmp/pet.webp")).toBe(true)
    expect(isPetSpritePath("/tmp/pet.gif")).toBe(false)
    expect(isPetSpritePath("/tmp/pet.txt")).toBe(false)
  })

  test("decodes PNG header dimensions", () => {
    expect(decodeRasterDimensions(pngBytes(4096, 3584))).toEqual({ width: 4096, height: 3584 })
  })

  test("decodes JPEG SOF0 dimensions", () => {
    expect(decodeRasterDimensions(jpegBytes(1024, 896))).toEqual({ width: 1024, height: 896 })
  })

  test("rejects non-raster input", () => {
    expect(decodeRasterDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })

  test("validates an 8:7 sheet and rejects wrong aspect ratios", async () => {
    await withTempDir(async (dir) => {
      const good = path.join(dir, "good.png")
      await writeFile(good, pngBytes(4096, 3584))
      expect(await validatePetSpriteSheet(good)).toEqual({ ok: true, width: 4096, height: 3584 })

      const square = path.join(dir, "square.png")
      await writeFile(square, pngBytes(512, 512))
      const result = await validatePetSpriteSheet(square)
      expect(result.ok).toBe(false)
      expect(result.reason).toContain("8:7")
    })
  })

  test("rejects unreadable and unsupported files", async () => {
    await withTempDir(async (dir) => {
      const missing = path.join(dir, "missing.png")
      expect((await validatePetSpriteSheet(missing)).ok).toBe(false)

      const txt = path.join(dir, "pet.txt")
      await writeFile(txt, "hello")
      expect((await validatePetSpriteSheet(txt)).ok).toBe(false)
    })
  })

  test("loads a valid sheet to a data URL and falls back for invalid ones", async () => {
    await withTempDir(async (dir) => {
      const good = path.join(dir, "good.png")
      await writeFile(good, pngBytes(1024, 896))
      const loaded = await loadPetSpriteSheet(good, 120)
      expect(loaded.dataUrl).toMatch(/^data:image\/png;base64,/)
      expect(loaded.columns).toBe(8)
      expect(loaded.rows).toBe(7)
      expect(loaded.frameMs).toBe(120)

      const fallback = await loadPetSpriteSheet("", 120)
      expect(fallback.dataUrl).toBeNull()

      const bad = path.join(dir, "bad.png")
      await writeFile(bad, "not an image")
      expect((await loadPetSpriteSheet(bad, 120)).dataUrl).toBeNull()
    })
  })

  test("exposes the expected 8:7 aspect ratio", () => {
    expect(PET_SPRITE_ASPECT_RATIO).toBeCloseTo(8 / 7, 5)
  })
})
