import { describe, expect, test } from "bun:test"
import { PROVIDER_SAFE_IMAGE_MEDIA_TYPES, supportsImageMediaType } from "../../src/provider/image-capability"

function model(supportedImageMediaTypes?: readonly string[]) {
  return { capabilities: { input: { supportedImageMediaTypes } } }
}

describe("provider image capability", () => {
  test("treats an undeclared media-type list as provider-safe-only", () => {
    expect(supportsImageMediaType(model(undefined), "image/png")).toBe(true)
    expect(supportsImageMediaType(model(undefined), "image/webp")).toBe(true)
    expect(supportsImageMediaType(model(undefined), "image/tiff")).toBe(false)
    expect(supportsImageMediaType(model(undefined), "image/heic")).toBe(false)
    expect(supportsImageMediaType(model(undefined), "image/bmp")).toBe(false)
  })

  test("honors an explicit declaration over the provider-safe fallback", () => {
    expect(supportsImageMediaType(model(["image/tiff"]), "image/tiff")).toBe(true)
    expect(supportsImageMediaType(model(["image/tiff"]), "image/png")).toBe(false)
  })

  test("keeps the provider-safe set within common vision formats", () => {
    expect(PROVIDER_SAFE_IMAGE_MEDIA_TYPES).toContain("image/png")
    expect(PROVIDER_SAFE_IMAGE_MEDIA_TYPES).toContain("image/jpeg")
    expect(PROVIDER_SAFE_IMAGE_MEDIA_TYPES).toContain("image/gif")
    expect(PROVIDER_SAFE_IMAGE_MEDIA_TYPES).toContain("image/webp")
    expect(PROVIDER_SAFE_IMAGE_MEDIA_TYPES).not.toContain("image/tiff")
  })
})
