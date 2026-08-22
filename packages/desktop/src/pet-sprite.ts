/**
 * Sprite sheet validation and normalization.
 *
 * The pet renderer expects an 8-column by 7-row sprite sheet (one animation
 * per row). This module validates that a local PNG/JPG is a readable image with
 * the expected aspect ratio, normalizes it to a data URL the sandboxed
 * renderer can display, and rejects anything that cannot be used.
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import { PET_SPRITE_COLUMNS, PET_SPRITE_ROWS, type PetSpriteSheet } from "./pet-types.js"

export const PET_SPRITE_ASPECT_RATIO = PET_SPRITE_COLUMNS / PET_SPRITE_ROWS

export const PET_SPRITE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const

export function isPetSpritePath(value: string): boolean {
  const ext = path.extname(value).toLowerCase()
  return (PET_SPRITE_EXTENSIONS as readonly string[]).includes(ext)
}

export interface PetSpriteValidation {
  ok: boolean
  /** Human-readable reason when ok is false. */
  reason?: string
  width?: number
  height?: number
}

/**
 * Validate that the image at the given path decodes as a raster image and has
 * the 8:7 aspect ratio expected of a sprite sheet. The renderer also enforces
 * per-frame square geometry; here we only reject files that cannot possibly be
 * a usable sheet.
 */
export async function validatePetSpriteSheet(filePath: string): Promise<PetSpriteValidation> {
  if (!isPetSpritePath(filePath)) {
    return { ok: false, reason: "Unsupported sprite sheet extension" }
  }
  try {
    const buffer = await readFile(filePath)
    const dims = decodeRasterDimensions(buffer)
    if (!dims) {
      return { ok: false, reason: "Sprite sheet is not a readable raster image" }
    }
    const { width, height } = dims
    const ratio = width / height
    const tolerance = 0.05
    if (Math.abs(ratio - PET_SPRITE_ASPECT_RATIO) > tolerance) {
      return {
        ok: false,
        reason: `Sprite sheet aspect ratio ${ratio.toFixed(3)} does not match 8:7`,
        width,
        height,
      }
    }
    return { ok: true, width, height }
  } catch {
    return { ok: false, reason: "Sprite sheet could not be read" }
  }
}

/** Build the sprite payload sent to the pet renderer. */
export async function loadPetSpriteSheet(filePath: string, frameMs: number): Promise<PetSpriteSheet> {
  if (!filePath) return { dataUrl: null, columns: PET_SPRITE_COLUMNS, rows: PET_SPRITE_ROWS, frameMs }
  const validation = await validatePetSpriteSheet(filePath)
  if (!validation.ok || validation.width === undefined || validation.height === undefined) {
    return { dataUrl: null, columns: PET_SPRITE_COLUMNS, rows: PET_SPRITE_ROWS, frameMs }
  }
  const buffer = await readFile(filePath)
  const mime = mimeForPath(filePath)
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`
  return {
    dataUrl,
    columns: PET_SPRITE_COLUMNS,
    rows: PET_SPRITE_ROWS,
    frameMs,
  }
}

function mimeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    default:
      return "image/png"
  }
}

/**
 * Decode PNG/JPEG/WebP header dimensions without a full image decoder.
 * Returns null when the signature or header is unrecognized.
 */
export function decodeRasterDimensions(buffer: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  // PNG: 8-byte signature, then IHDR chunk with width/height at offset 16.
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    if (buffer.length < 24) return null
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
    }
  }
  // JPEG: starts with FFD8, then SOF markers carry dimensions.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return decodeJpegDimensions(view)
  }
  // WebP: RIFF....WEBP, then VP8 / VP8L / VP8X chunks.
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return decodeWebpDimensions(view)
  }
  return null
}

function decodeJpegDimensions(view: DataView): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 < view.byteLength) {
    const marker = view.getUint8(offset + 1)
    // Standalone markers carry no length.
    if (view.getUint8(offset) !== 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = view.getUint16(offset + 2)
    if (length < 2) return null
    // SOF0-SOF15 (except DHT C4 and DAC CC) carry dimensions.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 >= view.byteLength) return null
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      }
    }
    offset += 2 + length
  }
  return null
}

function decodeWebpDimensions(view: DataView): { width: number; height: number } | null {
  // VP8X (extended): width-1/height-1 stored as 24-bit little-endian at 24.
  if (view.byteLength >= 30 && isChunk(view, 12, 0x56, 0x50, 0x38, 0x58)) {
    return {
      width: readUint24LE(view, 24) + 1,
      height: readUint24LE(view, 27) + 1,
    }
  }
  // VP8 (lossy): dimensions are 14-bit little-endian values at offset 26/28.
  if (view.byteLength >= 30 && isChunk(view, 12, 0x56, 0x50, 0x38, 0x20)) {
    return {
      width: readUint14LE(view, 26),
      height: readUint14LE(view, 28),
    }
  }
  // VP8L (lossless): 1 byte signature at 20 then 14-bit dimensions at 21.
  if (view.byteLength >= 25 && isChunk(view, 12, 0x56, 0x50, 0x38, 0x4c)) {
    if (view.getUint8(20) !== 0x2f) return null
    return {
      width: readUint14LE(view, 21) + 1,
      height: readUint14LE(view, 23) + 1,
    }
  }
  return null
}

function isChunk(view: DataView, offset: number, a: number, b: number, c: number, d: number): boolean {
  return (
    view.getUint8(offset) === a &&
    view.getUint8(offset + 1) === b &&
    view.getUint8(offset + 2) === c &&
    view.getUint8(offset + 3) === d
  )
}

function readUint24LE(view: DataView, offset: number): number {
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
}

function readUint14LE(view: DataView, offset: number): number {
  return (view.getUint8(offset) | ((view.getUint8(offset + 1) & 0x3f) << 8)) & 0x3fff
}
