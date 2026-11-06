import { describe, expect, test } from "bun:test"
import { clampImageIndex, imagePreviewMetadata } from "../../src/components/image-preview-model"

describe("image preview model", () => {
  test("clamps initial indexes into the image collection", () => {
    expect(clampImageIndex(undefined, 3)).toBe(0)
    expect(clampImageIndex(-2, 3)).toBe(0)
    expect(clampImageIndex(10, 3)).toBe(2)
    expect(clampImageIndex(1.8, 3)).toBe(1)
    expect(clampImageIndex(Number.NaN, 3)).toBe(0)
    expect(clampImageIndex(Number.POSITIVE_INFINITY, 3)).toBe(0)
    expect(clampImageIndex(2, 0)).toBe(0)
  })

  test("formats quiet metadata only when values are available", () => {
    expect(
      imagePreviewMetadata({
        image: { mime: "image/png", size: 1536 },
        dimensions: { width: 640, height: 480 },
        index: 1,
        count: 3,
      }),
    ).toEqual(["640 × 480", "1.5 KB", "image/png", "2 / 3"])

    expect(imagePreviewMetadata({ image: { mime: "image/jpeg" }, index: 0, count: 1 })).toEqual(["image/jpeg"])
    expect(imagePreviewMetadata({ image: { mime: "image/gif", size: 512 }, count: 2 })).toEqual(["512 B", "image/gif"])
    expect(
      imagePreviewMetadata({ image: { mime: "image/webp" }, dimensions: { width: 10, height: 20 }, index: 0 }),
    ).toEqual(["10 × 20", "image/webp"])
  })
})
