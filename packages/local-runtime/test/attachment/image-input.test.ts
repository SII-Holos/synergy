import { afterAll, expect, test } from "bun:test"
import sharp from "sharp"
import { randomBytes } from "node:crypto"
import { AttachmentImageInput } from "@ericsanchezok/synergy-harness/attachment/image-input"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const budget = AttachmentImageInput.BUDGET
const signal = () => new AbortController().signal
const blank = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 35, g: 90, b: 180, alpha: 0.5 } } })

async function prepared(bytes: Buffer) {
  const result = await AttachmentImageInput.prepare(bytes, signal())
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Image preparation failed: ${result.reason}`)
  const output = Buffer.from(result.data, "base64")
  const metadata = await sharp(output).metadata()
  expect(output.length).toBeLessThanOrEqual(budget.maxBytes)
  expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(budget.maxDimension)
  expect(
    Math.ceil(metadata.width! / budget.patchSize) * Math.ceil(metadata.height! / budget.patchSize),
  ).toBeLessThanOrEqual(budget.maxPatches)
  expect(metadata.depth).toBe("uchar")
  expect(metadata.width).toBe(result.width)
  expect(metadata.height).toBe(result.height)
  await sharp(output).raw().toBuffer()
  return { result, output, metadata }
}

test(
  "large 16-bit contact sheets are resized while the immutable original stays byte-for-byte intact",
  () =>
    runtime.run(async () => {
      const bytes = await blank(4160, 20720).toColourspace("rgb16").png().toBuffer()
      expect((await sharp(bytes).metadata()).depth).toBe("ushort")
      const id = await Asset.write(bytes, "image/png")
      const { result, output } = await prepared(bytes)
      expect(result).toMatchObject({
        originalWidth: 4160,
        originalHeight: 20720,
        width: 411,
        height: 2048,
        mediaType: "image/png",
      })
      expect(output.equals(bytes)).toBe(false)
      expect(await (await Asset.read(id))!.bytes()).toEqual(new Uint8Array(bytes))
    }),
  30_000,
)

test("dimension and patch budgets preserve portrait, landscape and very thin aspect ratios", () =>
  runtime.run(async () => {
    for (const [width, height] of [
      [2048, 2048],
      [2000, 1400],
      [1400, 2000],
      [5000, 1],
      [1, 5000],
      [40, 20],
    ]) {
      const { result } = await prepared(await blank(width, height).png().toBuffer())
      const scale = Math.min(result.width / width, result.height / height)
      expect(Math.abs(result.width - width * scale)).toBeLessThanOrEqual(1)
      expect(Math.abs(result.height - height * scale)).toBeLessThanOrEqual(1)
      if (width === height) expect(result).toMatchObject({ width: 1600, height: 1600 })
      expect(result.width).toBeLessThanOrEqual(width)
      expect(result.height).toBeLessThanOrEqual(height)
    }
  }))

test("noisy images meet the encoded byte budget even when their dimensions already fit", () =>
  runtime.run(async () => {
    const bytes = await sharp(randomBytes(1600 * 1600 * 4), { raw: { width: 1600, height: 1600, channels: 4 } })
      .png()
      .toBuffer()
    expect(bytes.length).toBeGreaterThan(budget.maxBytes)
    const { result, metadata } = await prepared(bytes)
    expect(result.width).toBeLessThan(1600)
    expect(metadata.hasAlpha).toBe(true)
  }))

test("valid small PNG, JPEG and WebP images retain their exact encoded bytes", () =>
  runtime.run(async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const bytes = await blank(64, 32).toFormat(format).toBuffer()
      const { output, result } = await prepared(bytes)
      expect(output.equals(bytes)).toBe(true)
      expect(result.mediaType).toBe(`image/${format}`)
    }
  }))

test("EXIF rotation is applied once and unsupported provider formats become a decoded PNG", () =>
  runtime.run(async () => {
    const rotated = await blank(30, 70).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const { result, metadata } = await prepared(rotated)
    expect(result).toMatchObject({
      width: 70,
      height: 30,
      originalWidth: 70,
      originalHeight: 30,
      mediaType: "image/jpeg",
    })
    expect(metadata.orientation).toBeUndefined()
    const gif = await blank(64, 32).gif().toBuffer()
    expect((await prepared(gif)).result.mediaType).toBe("image/png")
  }))

test("truncated pixel data, invalid headers and resource limits do not poison later preparations", () =>
  runtime.run(async () => {
    const bytes = await blank(64, 32).png().toBuffer()
    for (const bad of [Buffer.alloc(0), Buffer.from("broken"), bytes.subarray(0, bytes.length - 20)]) {
      expect(await AttachmentImageInput.prepare(bad, signal())).toEqual({ ok: false, reason: "invalid" })
    }
    const oversized = Buffer.from(bytes)
    oversized.writeUInt32BE(10001, 16)
    oversized.writeUInt32BE(10001, 20)
    oversized.writeUInt32BE(Bun.hash.crc32(oversized.subarray(12, 29)), 29)
    expect(await AttachmentImageInput.prepare(oversized, signal())).toEqual({ ok: false, reason: "invalid" })
    expect(
      await AttachmentImageInput.prepare(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
        signal(),
      ),
    ).toEqual({ ok: false, reason: "invalid" })
    expect(await AttachmentImageInput.prepare(new Uint8Array(budget.maxInputBytes + 1), signal())).toEqual({
      ok: false,
      reason: "too-large",
    })
    expect((await prepared(bytes)).output.equals(bytes)).toBe(true)
  }))

test("cancellation during native preparation and queued work remains cancellation", () =>
  runtime.run(async () => {
    const bytes = await blank(3000, 2000).png().toBuffer()
    const controller = new AbortController()
    const preparing = AttachmentImageInput.prepare(bytes, controller.signal)
    const queued = AttachmentImageInput.prepare(bytes, controller.signal)
    const timer = setTimeout(() => controller.abort(new Error("cancel image")), 0)
    const results = await Promise.allSettled([preparing, queued])
    clearTimeout(timer)
    expect(results).toEqual([
      { status: "rejected", reason: new Error("cancel image") },
      { status: "rejected", reason: new Error("cancel image") },
    ])
    expect((await prepared(bytes)).result.ok).toBe(true)
  }))

test("cached results remain deterministic and are isolated between Runtimes", () =>
  runtime.run(async () => {
    const bytes = await blank(2050, 16).png().toBuffer()
    const first = await AttachmentImageInput.prepare(bytes, signal())
    expect(await AttachmentImageInput.prepare(bytes, signal())).toBe(first)
    await using second = await testRuntime()
    const other = await second.run(() => AttachmentImageInput.prepare(bytes, signal()))
    expect(other).toEqual(first)
    expect(other).not.toBe(first)
    await expect(
      AttachmentImageInput.prepare(bytes, AbortSignal.abort(new Error("cancel cached image"))),
    ).rejects.toThrow("cancel cached image")
    for (let index = 0; index < 32; index++) {
      await AttachmentImageInput.prepare(Buffer.from(`invalid ${index}`), signal())
    }
    const evicted = await AttachmentImageInput.prepare(bytes, signal())
    expect(evicted).toEqual(first)
    expect(evicted).not.toBe(first)
  }))
